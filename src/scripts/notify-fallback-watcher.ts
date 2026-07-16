#!/usr/bin/env node

import { existsSync } from "fs";
import {
	appendFile,
	mkdir,
	open,
	readFile,
	readdir,
	rename,
	rm,
	stat,
	unlink,
} from "fs/promises";
import { spawn, type ChildProcess } from "child_process";
import { dirname, join, resolve } from "path";
import { homedir } from "os";
import { StringDecoder } from "string_decoder";
import { spawnPlatformCommandSync } from "../utils/platform-command.js";
import { drainPendingTeamDispatch } from "./notify-hook/team-dispatch.js";
import {
	maybeAutoNudge,
	isDeepInterviewInputLockActive,
	isDeepInterviewStateActive,
	loadAutoNudgeConfig,
	normalizeAutoNudgeSignatureText,
	resolveAutoNudgeSignature,
} from "./notify-hook/auto-nudge.js";
import { getScopedStatePath } from "./notify-hook/state-io.js";

import { checkPaneReadyForTeamSendKeys } from "./notify-hook/team-tmux-guard.js";
import {
	checkWorkerPanesAlive,
	isLeaderStale,
	maybeNudgeTeamLeader,
	resolveLeaderStalenessThresholdMs,
} from "./notify-hook/team-leader-nudge.js";
import {
	resolveManagedPaneFromAnchor,
	resolveManagedSessionPane,
} from "./notify-hook/managed-tmux.js";
import { DEFAULT_MARKER } from "./tmux-hook-engine.js";
import { isTerminalPhase } from "./notify-hook/utils.js";
import {
	isSessionStale,
	isSessionStateAuthoritativeForCwd,
	readSessionState,
	resolveSessionPointerContext,
} from "../hooks/session.js";
import {
	DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS,
	readSubagentSessionSummary,
} from "../subagents/tracker.js";
import { listNotifyCanonicalActiveTeams } from "./notify-hook/active-team.js";
import { validateSessionId } from "../mcp/state-paths.js";
import { TEAM_NAME_SAFE_PATTERN } from "../team/contracts.js";
import { shouldContinueRun } from "../runtime/run-loop.js";
import {
	deliverNotifyFallback,
	compactNotifyFallbackDeliveries,
	NOTIFY_FALLBACK_LEASE_MS,
} from "./notify-fallback-delivery.js";
import {
	atomicWriteAuthorityFile,
	initializeStateAuthority,
	mintStateAuthorityTransportCapability,
	captureRootFilesystemIdentity,
	ensureAuthorityDirectory,
	readAuthorityFileWithExpectedRoot,

	readWorkspaceAuthorityAnchor,
	resolveStateAuthorityForGuard,
	sameRootFilesystemIdentity,
	validateStateAuthorityTransportCapability,
	withStateAuthorityTransaction,
	type ResolvedStateAuthorityContext,
} from "../state/authority.js";
import {
	buildStateAuthorityTransportEnv,
	OMX_STATE_AUTHORITY_CAPABILITY_ENV,
	OMX_STATE_AUTHORITY_GENERATION_ID_ENV,
	OMX_STATE_AUTHORITY_ID_ENV,
	OMX_STATE_AUTHORITY_PATH_ENV,
	OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV,
} from "../state/transport-env.js";
import {
	captureNotifyWatcherProcessStartIdentity,
	createNotifyWatcherPidRecord,
	processMatchesNotifyWatcherPidRecord,
	readNotifyWatcherPidRecordNoFollow,
	recordMatchesNotifyWatcherAuthority,
	type NotifyWatcherPidRecord,
} from "../state/notify-watcher-pid.js";


function argValue(name: string, fallback = ""): string {
	const idx = process.argv.indexOf(name);
	if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
	return process.argv[idx + 1];
}

function asNumber(
	value: string | number | undefined,
	fallback: number,
): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(v: unknown): string {
	return typeof v === "string" ? v : "";
}

function normalizeValidSessionId(value: unknown): string {
	const trimmed = safeString(value).trim();
	if (!trimmed) return "";
	try {
		return validateSessionId(trimmed) ?? "";
	} catch {
		return "";
	}
}

function normalizeValidTeamName(value: unknown): string {
	const trimmed = safeString(value).trim();
	return TEAM_NAME_SAFE_PATTERN.test(trimmed) ? trimmed : "";
}


function parseIsoMillis(value: string | null | undefined): number | null {
	const parsed = Date.parse(safeString(value).trim());
	return Number.isFinite(parsed) ? parsed : null;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (
			error !== null &&
			typeof error === "object" &&
			(error as NodeJS.ErrnoException).code === "EPERM"
		);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}




const cwd = resolve(argValue("--cwd", process.cwd()));
const notifyScript = resolve(
	argValue("--notify-script", join(cwd, "dist", "scripts", "notify-hook.js")),
);
const runOnce = process.argv.includes("--once");
const authorityOnly = process.argv.includes("--authority-only");
// Keep fallback control-plane ticks comfortably below the default dispatch
// ack budget so leaderless team dispatch + stale-alert recovery do not feel
// laggy between native notify-hook turns.
const pollMs = Math.max(50, asNumber(argValue("--poll-ms", "250"), 250));
const idleMaxPollMs = Math.max(
	pollMs,
	asNumber(
		argValue(
			"--idle-max-poll-ms",
			process.env.OMX_NOTIFY_FALLBACK_IDLE_MAX_POLL_MS || "1000",
		),
		1000,
	),
);
const parentPid = Math.trunc(
	asNumber(
		argValue("--parent-pid", String(process.ppid || 0)),
		process.ppid || 0,
	),
);
const startedAt = Date.now();
const fileWindowMs = runOnce ? 15000 : 30000;
const defaultMaxLifetimeMs = 6 * 60 * 60 * 1000;
const requestedMaxLifetimeMs = asNumber(
	argValue(
		"--max-lifetime-ms",
		process.env.OMX_NOTIFY_FALLBACK_MAX_LIFETIME_MS ||
			String(defaultMaxLifetimeMs),
	),
	defaultMaxLifetimeMs,
);
const configuredMaxLifetimeMs =
	Number.isSafeInteger(requestedMaxLifetimeMs) && requestedMaxLifetimeMs > 0
		? requestedMaxLifetimeMs
		: defaultMaxLifetimeMs;
const maxLifetimeMs = runOnce ? 0 : Math.max(pollMs, configuredMaxLifetimeMs);
const authorityLifetimeMs = runOnce
	? NOTIFY_FALLBACK_LEASE_MS
	: Math.min(Math.max(pollMs, configuredMaxLifetimeMs), 24 * 60 * 60 * 1000);
const authorityDeadlineAtMs = startedAt + authorityLifetimeMs;

let omxDir = "";
let logsDir = "";
let stateDir = "";
let statePath = "";
let pidFilePath = "";
let logPath = "";
let logRotatePath = "";
let logLockPath = "";
let ralphSteerTimestampPath = "";
let ralphSteerLockPath = "";
const defaultMaxLogBytes = 10 * 1024 * 1024;
const maxLogBytes = Math.max(
	0,
	asNumber(
		argValue(
			"--log-max-bytes",
			process.env.OMX_NOTIFY_FALLBACK_LOG_MAX_BYTES || String(defaultMaxLogBytes),
		),
		defaultMaxLogBytes,
	),
);

let retainedAuthority: ResolvedStateAuthorityContext | undefined;
let testBootstrappedAuthority = false;

async function retainActiveAuthority(): Promise<ResolvedStateAuthorityContext> {
	const authority = await resolveStateAuthorityForGuard({
		startup_cwd: cwd,
		observed_cwd: cwd,
		session_id: process.env.OMX_SESSION_ID || undefined,
	});
	const binding = authority.session_binding;
	const transport = {
		path: process.env[OMX_STATE_AUTHORITY_PATH_ENV]?.trim() ?? "",
		authorityId: process.env[OMX_STATE_AUTHORITY_ID_ENV]?.trim() ?? "",
		generationId: process.env[OMX_STATE_AUTHORITY_GENERATION_ID_ENV]?.trim() ?? "",
		workspaceDigest:
			process.env[OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV]?.trim() ?? "",
		capability: process.env[OMX_STATE_AUTHORITY_CAPABILITY_ENV]?.trim() ?? "",
	};
	if (
		!binding ||
		binding.lifecycle !== "active" ||
		!transport.path ||
		!transport.authorityId ||
		!transport.generationId ||
		!transport.workspaceDigest ||
		!transport.capability ||
		resolve(transport.path) !== resolve(authority.authority_path) ||
		transport.authorityId !== authority.generation.authority_id ||
		transport.generationId !== authority.generation.generation_id ||
		transport.workspaceDigest !== authority.workspace_identity.digest
	) {
		throw new Error("notify fallback watcher requires authenticated committed state-authority transport");
	}
	await validateStateAuthorityTransportCapability(authority, transport.capability);
	const anchor = await readWorkspaceAuthorityAnchor(authority.workspace_identity);
	if (
		!anchor?.active_lease ||
		anchor.active_generation_id !== authority.generation.generation_id ||
		anchor.active_lease.generation_id !== authority.generation.generation_id ||
		anchor.active_lease.binding_id !== binding.binding_id
	) {
		throw new Error("notify fallback watcher authority binding is no longer active");
	}
	const root = resolve(dirname(authority.generation.canonical_omx_root));
	for (const name of ["OMX_ROOT", "OMX_STATE_ROOT"] as const) {
		const value = process.env[name]?.trim();
		if (value && resolve(authority.workspace_identity.canonical_path, value) !== root) {
			throw new Error(`${name} conflicts with authenticated state authority`);
		}
	}
	const teamRoot = process.env.OMX_TEAM_STATE_ROOT?.trim();
	if (teamRoot && resolve(authority.workspace_identity.canonical_path, teamRoot) !== resolve(authority.canonical_state_root)) {
		throw new Error("OMX_TEAM_STATE_ROOT conflicts with authenticated state authority");
	}
	return authority;
}

async function requireRetainedActiveAuthority(): Promise<void> {
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	const binding = retainedAuthority.session_binding;
	const anchor = await readWorkspaceAuthorityAnchor(retainedAuthority.workspace_identity);
	const rootIdentity = await captureRootFilesystemIdentity(retainedAuthority.canonical_state_root);
	if (
		!binding ||
		binding.lifecycle !== "active" ||
		!sameRootFilesystemIdentity(rootIdentity, retainedAuthority.generation.root_identity) ||
		anchor?.active_generation_id !== retainedAuthority.generation.generation_id ||
		anchor.active_lease?.generation_id !== retainedAuthority.generation.generation_id ||
		anchor.active_lease?.binding_id !== binding.binding_id
	) {
		stopping = true;
		throw new Error("notify fallback watcher authority changed or terminalized");
	}
}

async function withRetainedAuthorityTransaction<T>(
	callback: (authority: ResolvedStateAuthorityContext) => Promise<T>,
): Promise<T> {
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	const generationId = retainedAuthority.generation.generation_id;
	const bindingId = retainedAuthority.session_binding?.binding_id;
	return await withStateAuthorityTransaction(retainedAuthority, async (authority) => {
		if (
			authority.generation.generation_id !== generationId ||
			authority.session_binding?.binding_id !== bindingId ||
			authority.session_binding?.lifecycle !== "active"
		) {
			stopping = true;
			throw new Error("notify fallback watcher authority changed or terminalized");
		}
		return await callback(authority);
	});
}

const watcherOwnerToken = `${process.pid}-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
const RALPH_CONTINUE_TEXT = "Ralph loop active continue";
const RALPH_CONTINUE_CADENCE_MS = 60_000;
const RALPH_TERMINAL_PHASES = new Set([
	"blocked_on_user",
	"complete",
	"failed",
	"cancelled",
]);
const RALPH_STARTING_PHASE_TIMEOUT_MS = RALPH_CONTINUE_CADENCE_MS * 2;
const QUIET_ONCE_EVENT_TYPES = new Set([
	"watcher_start",
	"watcher_once_complete",
]);

interface WatcherFileMeta {
	threadId: string;
	offset: number;
	size: number;
	partial: string;
	decoder: StringDecoder;
}

interface RalphContinueSteerState {
	enabled: boolean;
	cadence_ms: number;
	message: string;
	active: boolean;
	last_state_check_at: string | null;
	last_sent_at: string;
	cooldown_anchor_at: string;
	last_reason: string;
	last_error: string | null;
	state_path: string;
	pane_id: string;
	pane_current_command: string;
	current_phase: string;
	subagent_session_id: string;
	active_subagent_thread_ids: string[];
	shared_timestamp_path: string;
	shared_last_sent_at: string;
	singleton_lock_path: string;
}




interface DispatchDrainState {
	leader_only: boolean;
	last_tick_at: string | null;
	last_result: unknown;
	last_error: string | null;
}

interface LeaderNudgeState {
	enabled: boolean;
	leader_only: boolean;
	stale_threshold_ms: number | null;
	precomputed_leader_stale: boolean | null;
	last_tick_at: string | null;
	last_error: string | null;
}

interface ParentGuardState {
	reason: string;
	state_path: string;
	current_phase: string;
	team_name?: string;
	pane_count?: number;
}

interface AuthorityBackoffState {
	active: boolean;
	reason: string;
	primary_pid: number | null;
	primary_last_tick_at: string;
	freshness_ms: number | null;
	threshold_ms: number | null;
}

interface ActiveTeamResult {
	active: boolean;
	reason: string;
	path: string;
	state: Record<string, unknown> | null;
	team_name: string;
	pane_count: number;
}

interface FallbackAutoNudgeState {
	enabled: boolean;
	stall_ms: number;
	last_tick_at: string | null;
	last_turn_at: string;
	last_turn_count: number | null;
	last_message: string;
	last_reason: string;
	last_error: string | null;
	last_nudged_signature: string;
	last_nudged_at: string;
}

interface AdaptivePollState {
	enabled: boolean;
	base_ms: number;
	max_ms: number;
	current_ms: number;
	idle_streak: number;
	last_tick_at: string | null;
	last_activity_at: string | null;
	last_activity_reason: string;
}

interface CycleActivitySummary {
	active: boolean;
	reason: string;
}

const fileState = new Map<string, WatcherFileMeta>();
const seenTurnKeys = new Set<string>();
let stopping = false;
let shutdownPromise: Promise<void> | null = null;
let activeNotifyHookChild: ChildProcess | null = null;
let activeNotifyHookClose: Promise<{
	status: number | null;
	signal: string | null;
}> | null = null;
let activeNotifyHookTermination: Promise<boolean> | null = null;
let activeDeliveryPromise: Promise<unknown> | null = null;
async function terminateActiveNotifyHookChild(): Promise<boolean> {
	if (activeNotifyHookTermination) return activeNotifyHookTermination;
	const child = activeNotifyHookChild;
	const close = activeNotifyHookClose;
	if (!child || !close) return true;
	activeNotifyHookTermination = (async () => {
		child.kill("SIGTERM");
		const termResult = await Promise.race([
			close.then(() => true),
			sleep(1_000).then(() => false),
		]);
		if (termResult) return true;
		child.kill("SIGKILL");
		return Promise.race([
			close.then(() => true),
			sleep(2_000).then(() => false),
		]);
	})();
	try {
		return await activeNotifyHookTermination;
	} finally {
		activeNotifyHookTermination = null;
	}
}
const dispatchTickMax = Math.max(
	1,
	asNumber(argValue("--dispatch-max-per-tick", "5"), 5),
);
let dispatchDrainRuns = 0;
let lastDispatchDrain: DispatchDrainState = {
	leader_only: safeString(process.env.OMX_TEAM_WORKER || "").trim() === "",
	last_tick_at: null,
	last_result: null,
	last_error: null,
};
let leaderNudgeRuns = 0;
let lastLeaderNudge: LeaderNudgeState = {
	enabled: true,
	leader_only: safeString(process.env.OMX_TEAM_WORKER || "").trim() === "",
	stale_threshold_ms: null,
	precomputed_leader_stale: null,
	last_tick_at: null,
	last_error: null,
};
let lastRalphContinueSteer: RalphContinueSteerState = {
	enabled: true,
	cadence_ms: RALPH_CONTINUE_CADENCE_MS,
	message: RALPH_CONTINUE_TEXT,
	active: false,
	last_state_check_at: null,
	last_sent_at: "",
	cooldown_anchor_at: "",
	last_reason: "init",
	last_error: null,
	state_path: "",
	pane_id: "",
	pane_current_command: "",
	current_phase: "",
	subagent_session_id: "",
	active_subagent_thread_ids: [],
	shared_timestamp_path: ralphSteerTimestampPath,
	shared_last_sent_at: "",
	singleton_lock_path: ralphSteerLockPath,
};
let lastParentGuard: ParentGuardState = {
	reason: "",
	state_path: "",
	current_phase: "",
};
let lastAuthorityBackoff: AuthorityBackoffState = {
	active: false,
	reason: "",
	primary_pid: null,
	primary_last_tick_at: "",
	freshness_ms: null,
	threshold_ms: null,
};
const AUTO_NUDGE_STALL_MS = Math.max(
	pollMs,
	asNumber(process.env.OMX_NOTIFY_FALLBACK_AUTO_NUDGE_STALL_MS || "5000", 5000),
);
let lastFallbackAutoNudge: FallbackAutoNudgeState = {
	enabled: true,
	stall_ms: AUTO_NUDGE_STALL_MS,
	last_tick_at: null,
	last_turn_at: "",
	last_turn_count: null,
	last_message: "",
	last_reason: "init",
	last_error: null,
	last_nudged_signature: "",
	last_nudged_at: "",
};
let adaptivePollState: AdaptivePollState = {
	enabled: true,
	base_ms: pollMs,
	max_ms: idleMaxPollMs,
	current_ms: pollMs,
	idle_streak: 0,
	last_tick_at: null,
	last_activity_at: null,
	last_activity_reason: "init",
};

function shouldSuppressEventLog(event: Record<string, unknown>): boolean {
	const eventType = safeString(event.type).trim();
	return runOnce && QUIET_ONCE_EVENT_TYPES.has(eventType);
}

async function acquireLogLock(timeoutMs = 1000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await mkdir(logLockPath, { recursive: false });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST")
				return false;
			const lockStat = await stat(logLockPath).catch(() => null);
			if (lockStat && Date.now() - lockStat.mtimeMs > 5000) {
				await rm(logLockPath, { recursive: true, force: true }).catch(() => {});
				continue;
			}
			await sleep(10);
		}
	}
	return false;
}

async function releaseLogLock(): Promise<void> {
	await rm(logLockPath, { recursive: true, force: true }).catch(() => {});
}

async function rotateLogIfNeeded(nextEntryBytes: number): Promise<void> {
	if (maxLogBytes <= 0) return;
	const currentStat = await stat(logPath).catch(() => null);
	if (!currentStat || currentStat.size + nextEntryBytes <= maxLogBytes) return;
	await unlink(logRotatePath).catch(() => {});
	await rename(logPath, logRotatePath).catch(() => {});
}

async function eventLog(event: Record<string, unknown>): Promise<void> {
	await requireRetainedActiveAuthority();
	if (shouldSuppressEventLog(event)) return;
	const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`;
	await mkdir(dirname(logPath), { recursive: true }).catch(() => {});
	const locked = await acquireLogLock();
	if (!locked) return;
	try {
		await rotateLogIfNeeded(Buffer.byteLength(line));
		await appendFile(logPath, line);
	} catch {
		// best effort only
	} finally {
		await releaseLogLock();
	}
}

function shouldLogLeaderNudgeTick(reason: string): boolean {
	return reason === "leader_nudge_checked" || reason === "leader_nudge_failed";
}

function nextIdlePollMs(currentMs: number): number {
	return Math.min(idleMaxPollMs, Math.max(pollMs, currentMs * 2));
}

function updateAdaptivePollState(summary: CycleActivitySummary): number {
	const nowIso = new Date().toISOString();
	if (summary.active) {
		adaptivePollState = {
			...adaptivePollState,
			enabled: true,
			base_ms: pollMs,
			max_ms: idleMaxPollMs,
			current_ms: pollMs,
			idle_streak: 0,
			last_tick_at: nowIso,
			last_activity_at: nowIso,
			last_activity_reason: summary.reason,
		};
		return adaptivePollState.current_ms;
	}

	const nextMs = nextIdlePollMs(adaptivePollState.current_ms);
	adaptivePollState = {
		...adaptivePollState,
		enabled: true,
		base_ms: pollMs,
		max_ms: idleMaxPollMs,
		current_ms: nextMs,
		idle_streak: adaptivePollState.idle_streak + 1,
		last_tick_at: nowIso,
		last_activity_reason: summary.reason,
	};
	return adaptivePollState.current_ms;
}

function shouldLogDispatchDrainTick(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const record = result as Record<string, unknown>;
	const processed = asNumber(
		record.processed as string | number | undefined,
		0,
	);
	const skipped = asNumber(record.skipped as string | number | undefined, 0);
	const failed = asNumber(record.failed as string | number | undefined, 0);
	if (processed > 0 || skipped > 0 || failed > 0) return true;
	const reason = safeString(record.reason).trim();
	return reason !== "" && reason !== "worker_context";
}

function normalizeRalphContinueSteerState(
	raw: Record<string, unknown> | null | undefined,
): RalphContinueSteerState {
	if (!raw || typeof raw !== "object") return { ...lastRalphContinueSteer };
	return {
		enabled: raw.enabled !== false,
		cadence_ms:
			Number.isFinite(raw.cadence_ms) && (raw.cadence_ms as number) > 0
				? (raw.cadence_ms as number)
				: RALPH_CONTINUE_CADENCE_MS,
		message: safeString(raw.message) || RALPH_CONTINUE_TEXT,
		active: raw.active === true,
		last_state_check_at: safeString(raw.last_state_check_at) || null,
		last_sent_at: safeString(raw.last_sent_at),
		cooldown_anchor_at: safeString(raw.cooldown_anchor_at),
		last_reason: safeString(raw.last_reason) || "init",
		last_error: safeString(raw.last_error) || null,
		state_path: safeString(raw.state_path),
		pane_id: safeString(raw.pane_id),
		pane_current_command: safeString(raw.pane_current_command),
		current_phase: safeString(raw.current_phase),
		subagent_session_id: safeString(raw.subagent_session_id),
		active_subagent_thread_ids: Array.isArray(raw.active_subagent_thread_ids)
			? raw.active_subagent_thread_ids
					.map((value) => safeString(value).trim())
					.filter(Boolean)
			: [],
		shared_timestamp_path:
			safeString(raw.shared_timestamp_path) || ralphSteerTimestampPath,
		shared_last_sent_at: safeString(raw.shared_last_sent_at),
		singleton_lock_path:
			safeString(raw.singleton_lock_path) || ralphSteerLockPath,
	};
}

function hasRalphTerminalState(
	raw: Record<string, unknown> | null | undefined,
): boolean {
	if (!raw || typeof raw !== "object") return true;
	if (raw.active !== true) return true;
	if (!shouldContinueRun(raw)) return true;
	const phase = safeString(raw.current_phase).trim().toLowerCase();
	if (phase && RALPH_TERMINAL_PHASES.has(phase)) return true;
	if (isStaleRalphStartingPhase(raw)) return true;
	if (safeString(raw.completed_at).trim()) return true;
	return false;
}

function isStaleRalphStartingPhase(raw: Record<string, unknown>): boolean {
	const phase = safeString(raw.current_phase).trim().toLowerCase();
	if (phase !== "starting") return false;
	const reference =
		parseIsoMillis(safeString(raw.last_turn_at)) ??
		parseIsoMillis(safeString(raw.started_at));
	if (reference === null) return false;
	return Date.now() - reference > RALPH_STARTING_PHASE_TIMEOUT_MS;
}

async function loadPersistedWatcherState(): Promise<void> {
	const persisted = await readFile(statePath, "utf-8")
		.then((content) => JSON.parse(content) as Record<string, unknown>)
		.catch(() => null);
	lastRalphContinueSteer = normalizeRalphContinueSteerState(
		persisted?.ralph_continue_steer as
			| Record<string, unknown>
			| null
			| undefined,
	);
	const persistedAutoNudge = persisted?.fallback_auto_nudge as
		| Record<string, unknown>
		| null
		| undefined;
	if (persistedAutoNudge && typeof persistedAutoNudge === "object") {
		lastFallbackAutoNudge = {
			enabled: persistedAutoNudge.enabled !== false,
			stall_ms:
				Number.isFinite(persistedAutoNudge.stall_ms) &&
				(persistedAutoNudge.stall_ms as number) > 0
					? (persistedAutoNudge.stall_ms as number)
					: AUTO_NUDGE_STALL_MS,
			last_tick_at: safeString(persistedAutoNudge.last_tick_at) || null,
			last_turn_at: safeString(persistedAutoNudge.last_turn_at),
			last_turn_count: Number.isFinite(persistedAutoNudge.last_turn_count)
				? (persistedAutoNudge.last_turn_count as number)
				: null,
			last_message: safeString(persistedAutoNudge.last_message),
			last_reason: safeString(persistedAutoNudge.last_reason) || "init",
			last_error: safeString(persistedAutoNudge.last_error) || null,
			last_nudged_signature: safeString(
				persistedAutoNudge.last_nudged_signature,
			),
			last_nudged_at: safeString(persistedAutoNudge.last_nudged_at),
		};
	}
	const persistedAdaptivePoll = persisted?.adaptive_poll as
		| Record<string, unknown>
		| null
		| undefined;
	if (persistedAdaptivePoll && typeof persistedAdaptivePoll === "object") {
		adaptivePollState = {
			enabled: persistedAdaptivePoll.enabled !== false,
			base_ms: pollMs,
			max_ms: idleMaxPollMs,
			current_ms: Math.min(
				idleMaxPollMs,
				Math.max(
					pollMs,
					asNumber(
						persistedAdaptivePoll.current_ms as string | number | undefined,
						pollMs,
					),
				),
			),
			idle_streak: Math.max(
				0,
				Math.trunc(
					asNumber(
						persistedAdaptivePoll.idle_streak as string | number | undefined,
						0,
					),
				),
			),
			last_tick_at: safeString(persistedAdaptivePoll.last_tick_at) || null,
			last_activity_at:
				safeString(persistedAdaptivePoll.last_activity_at) || null,
			last_activity_reason:
				safeString(persistedAdaptivePoll.last_activity_reason) || "init",
		};
	}
}

interface ActiveModeResult {
	active: boolean;
	reason: string;
	path: string;
	state: Record<string, unknown> | null;
}

async function resolveActiveModeState(mode: string): Promise<ActiveModeResult> {
	const candidateDirs: string[] = [];
	let currentSessionId = "";
	let currentSessionIsLive = false;
	const session = await readSessionState(cwd);
	if (session?.session_id) {
		if (isSessionStateAuthoritativeForCwd(session, cwd)) {
			currentSessionId = normalizeValidSessionId(session.session_id);
			currentSessionIsLive =
				currentSessionId !== "" && !isSessionStale(session);
		}
		if (currentSessionId && currentSessionIsLive) {
			candidateDirs.push(join(stateDir, "sessions", currentSessionId));
		}
	}
	if (!candidateDirs.includes(stateDir)) candidateDirs.push(stateDir);

	for (const dir of candidateDirs) {
		if (mode === "ralph" && dir === stateDir && currentSessionId) {
			return {
				active: false,
				reason: currentSessionIsLive
					? "blocked_by_current_session"
					: "stale_current_session",
				path: "",
				state: null,
			};
		}

		const path = join(dir, `${mode}-state.json`);
		if (!existsSync(path)) continue;
		const parsed = await readFile(path, "utf-8")
			.then((content) => JSON.parse(content) as Record<string, unknown>)
			.catch(() => null);
		if (!parsed || typeof parsed !== "object") continue;
		if (
			mode === "ralph" &&
			dir !== stateDir &&
			isStaleRalphStartingPhase(parsed)
		) {
			return {
				active: false,
				reason: "starting_stale",
				path,
				state: parsed,
			};
		}
		if (hasRalphTerminalState(parsed)) {
			return {
				active: false,
				reason: "terminal",
				path,
				state: parsed,
			};
		}
		return {
			active: true,
			reason: "active",
			path,
			state: parsed,
		};
	}

	return {
		active: false,
		reason: "cleared",
		path: "",
		state: null,
	};
}

async function resolveActiveRalphState(): Promise<ActiveModeResult> {
	return resolveActiveModeState("ralph");
}

async function resolveActiveTeamState(): Promise<ActiveTeamResult> {
	const candidateDirs: string[] = [];
	let currentSessionId = "";
	let currentSessionIsLive = false;
	const session = await readSessionState(cwd);
	if (session?.session_id) {
		currentSessionId = normalizeValidSessionId(session.session_id);
		currentSessionIsLive = currentSessionId !== "" && !isSessionStale(session);
		if (currentSessionId && currentSessionIsLive) {
			candidateDirs.push(join(stateDir, "sessions", currentSessionId));
		}
	}
	if (!candidateDirs.includes(stateDir)) candidateDirs.push(stateDir);

	for (const dir of candidateDirs) {
		if (dir === stateDir && currentSessionId) {
			continue;
		}

		const path = join(dir, "team-state.json");
		if (!existsSync(path)) continue;
		const parsed = await readFile(path, "utf-8")
			.then((content) => JSON.parse(content) as Record<string, unknown>)
			.catch(() => null);
		if (!parsed || typeof parsed !== "object" || parsed.active !== true)
			continue;

		const teamName = normalizeValidTeamName(parsed.team_name);
		if (!teamName) continue;

		const teamConfigDir = join(dir, "team", teamName);
		const phasePath = join(teamConfigDir, "phase.json");
		const phaseState = existsSync(phasePath)
			? await readFile(phasePath, "utf-8")
					.then((content) => JSON.parse(content) as Record<string, unknown>)
					.catch(() => null)
			: null;
		const phase = safeString(phaseState?.current_phase).trim();
		if (phase && isTerminalPhase(phase)) continue;

		const manifestPath = join(teamConfigDir, "manifest.v2.json");
		const configPath = join(teamConfigDir, "config.json");
		const teamConfigPath = existsSync(manifestPath) ? manifestPath : configPath;
		const teamConfig = existsSync(teamConfigPath)
			? await readFile(teamConfigPath, "utf-8")
					.then((content) => JSON.parse(content) as Record<string, unknown>)
					.catch(() => null)
			: null;
		const tmuxSession = safeString(teamConfig?.tmux_session).trim();
		if (!tmuxSession) continue;

		const workers = Array.isArray(teamConfig?.workers)
			? (teamConfig.workers as Array<Record<string, unknown>>)
			: [];
		const workerPaneIds: string[] = workers
			.map((worker) => safeString(worker?.pane_id).trim())
			.filter(Boolean);
		const paneStatus = await checkWorkerPanesAlive(
			tmuxSession,
			workerPaneIds as any,
		);
		if (!paneStatus.alive) continue;

		return {
			active: true,
			reason: "active",
			path,
			state: parsed,
			team_name: teamName,
			pane_count: paneStatus.paneCount,
		};
	}

	const canonicalFallbackTeams = (
		await Promise.all(
			candidateDirs.map((candidateDir) =>
				listNotifyCanonicalActiveTeams(
					cwd,
					currentSessionId,
					candidateDir,
				).catch(() => []),
			),
		)
	).flat();
	for (const team of canonicalFallbackTeams) {
		const teamName = normalizeValidTeamName(team.teamName);
		if (!teamName) continue;
		const teamConfigDir = dirname(team.path);
		const manifestPath = join(teamConfigDir, "manifest.v2.json");
		const configPath = join(teamConfigDir, "config.json");
		const teamConfigPath = existsSync(manifestPath) ? manifestPath : configPath;
		const teamConfig = existsSync(teamConfigPath)
			? await readFile(teamConfigPath, "utf-8")
					.then((content) => JSON.parse(content) as Record<string, unknown>)
					.catch(() => null)
			: null;
		const tmuxSession = safeString(teamConfig?.tmux_session).trim();
		if (!tmuxSession) continue;

		const workers = Array.isArray(teamConfig?.workers)
			? (teamConfig.workers as Array<Record<string, unknown>>)
			: [];
		const workerPaneIds: string[] = workers
			.map((worker) => safeString(worker?.pane_id).trim())
			.filter(Boolean);
		const paneStatus = await checkWorkerPanesAlive(
			tmuxSession,
			workerPaneIds as any,
		);
		if (!paneStatus.alive) continue;

		return {
			active: true,
			reason: team.source,
			path: team.path,
			state: {
				active: true,
				team_name: teamName,
				current_phase: team.phase,
			},
			team_name: teamName,
			pane_count: paneStatus.paneCount,
		};
	}

	if (currentSessionId) {
		return {
			active: false,
			reason: currentSessionIsLive
				? "blocked_by_current_session"
				: "stale_current_session",
			path: "",
			state: null,
			team_name: "",
			pane_count: 0,
		};
	}

	return {
		active: false,
		reason: "cleared",
		path: "",
		state: null,
		team_name: "",
		pane_count: 0,
	};
}

async function emitRalphContinueSteer(
	paneId: string,
	message: string,
): Promise<void> {
	const markedText = `${message} ${DEFAULT_MARKER}`;
	await new Promise<void>((resolve) => {
		const { result: typed } = spawnPlatformCommandSync(
			"tmux",
			["send-keys", "-t", paneId, "-l", markedText],
			{ encoding: "utf-8" },
		);
		if (typed.error) throw new Error(typed.error.message);
		if (typed.status !== 0)
			throw new Error(
				(typed.stderr || typed.stdout || "").trim() || "tmux send-keys failed",
			);
		setTimeout(resolve, 100);
	});
	await new Promise<void>((resolve) => {
		const { result: submitA } = spawnPlatformCommandSync(
			"tmux",
			["send-keys", "-t", paneId, "C-m"],
			{ encoding: "utf-8" },
		);
		if (submitA.error) throw new Error(submitA.error.message);
		if (submitA.status !== 0)
			throw new Error(
				(submitA.stderr || submitA.stdout || "").trim() ||
					"tmux send-keys C-m failed",
			);
		setTimeout(resolve, 100);
	});
	const { result: submitB } = spawnPlatformCommandSync(
		"tmux",
		["send-keys", "-t", paneId, "C-m"],
		{ encoding: "utf-8" },
	);
	if (submitB.error) throw new Error(submitB.error.message);
	if (submitB.status !== 0) {
		throw new Error(
			(submitB.stderr || submitB.stdout || "").trim() ||
				"tmux send-keys C-m failed",
		);
	}
}

async function readRalphSteerTimestamp(): Promise<string> {
	return readFile(ralphSteerTimestampPath, "utf-8")
		.then((content) => safeString(content).trim())
		.catch(() => "");
}

async function writeRalphSteerTimestamp(nowIso: string): Promise<void> {
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	await atomicWriteAuthorityFile(ralphSteerTimestampPath, `${nowIso}\n`, {
		authority_root: retainedAuthority.canonical_state_root,
		expected_root_identity: retainedAuthority.generation.root_identity,
	});
}


async function withRalphSteerLock<T>(
	task: () => Promise<T>,
): Promise<T | null> {
	// Every watcher cycle already holds the state-authority transaction. Keeping a
	// second path-based lock here would reopen a stale-root mutation boundary.
	await requireRetainedActiveAuthority();
	return await task();
}

interface RalphProgressGateResult {
	allow: boolean;
	reason: string;
	progress_at: string;
	subagent_session_id?: string;
	active_subagent_thread_ids?: string[];
}

async function readRalphProgressGate(
	activeRalphState: Record<string, unknown> | null,
	now: number,
): Promise<RalphProgressGateResult> {
	const subagentSessionId = safeString(
		activeRalphState?.owner_codex_session_id,
	).trim();
	if (subagentSessionId) {
		const sessionContext = resolveSessionPointerContext(cwd);
		const sessionState = await readSessionState(cwd).catch(() => null);
		const trackerStateDir = sessionState?.session_id
			? join(sessionContext.baseStateDir, "sessions", sessionState.session_id)
			: sessionContext.baseStateDir;
		const summary = await readSubagentSessionSummary(cwd, subagentSessionId, {
			now: new Date(now),
			activeWindowMs: DEFAULT_SUBAGENT_ACTIVE_WINDOW_MS,
			stateDir: trackerStateDir,
		});
		if ((summary?.activeSubagentThreadIds.length ?? 0) > 0) {
			return {
				allow: false,
				reason: "subagents_active",
				progress_at: "",
				subagent_session_id: subagentSessionId,
				active_subagent_thread_ids: summary?.activeSubagentThreadIds ?? [],
			};
		}
	}

	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	const hudState = await readScopedJsonWithAuthority(retainedAuthority, "hud-state.json");
	if (!hudState || typeof hudState !== "object") {
		return {
			allow: false,
			reason: "progress_missing",
			progress_at: "",
			subagent_session_id: subagentSessionId,
		};
	}

	const progressAt = safeString(hudState.last_progress_at).trim();
	if (!progressAt) {
		return {
			allow: false,
			reason: "progress_missing",
			progress_at: "",
			subagent_session_id: subagentSessionId,
		};
	}

	const progressMs = parseIsoMillis(progressAt);
	if (progressMs === null) {
		return {
			allow: false,
			reason: "progress_invalid",
			progress_at: progressAt,
			subagent_session_id: subagentSessionId,
		};
	}

	if (now - progressMs < RALPH_CONTINUE_CADENCE_MS) {
		return {
			allow: false,
			reason: "progress_fresh",
			progress_at: progressAt,
			subagent_session_id: subagentSessionId,
		};
	}

	return {
		allow: true,
		reason: "progress_stale",
		progress_at: progressAt,
		subagent_session_id: subagentSessionId,
	};
}

function shouldSkipRalphContinue(
	now: number,
	candidateIso: string,
): { skip: boolean; reason: string; anchorMs: number; anchorIso: string } {
	const sharedMs = parseIsoMillis(candidateIso);
	const localMs = parseIsoMillis(lastRalphContinueSteer.last_sent_at);
	const startupAnchorIso = lastRalphContinueSteer.cooldown_anchor_at;
	const startupAnchorMs = parseIsoMillis(startupAnchorIso);
	const startupCooldown =
		sharedMs === null && localMs === null && startupAnchorMs !== null;
	const anchorMs = sharedMs ?? localMs ?? startupAnchorMs ?? 0;
	const anchorIso =
		sharedMs !== null
			? candidateIso
			: localMs !== null
				? lastRalphContinueSteer.last_sent_at
				: startupAnchorIso;
	return {
		skip: anchorMs > 0 && now - anchorMs < RALPH_CONTINUE_CADENCE_MS,
		reason: startupCooldown
			? "startup_cooldown"
			: sharedMs !== null
				? "global_cooldown"
				: "cooldown",
		anchorMs,
		anchorIso,
	};
}

async function readPidFileRecord(path: string): Promise<NotifyWatcherPidRecord | null> {
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	await requireRetainedActiveAuthority();
	const record = await readNotifyWatcherPidRecordNoFollow(path, retainedAuthority);
	await requireRetainedActiveAuthority();
	return record;
}

function createAuthorityBackoffState(
	reason: string,
	overrides: Partial<AuthorityBackoffState> = {},
): AuthorityBackoffState {
	return {
		active: false,
		reason,
		primary_pid: null,
		primary_last_tick_at: "",
		freshness_ms: null,
		threshold_ms: null,
		...overrides,
	};
}

function latestWatcherTickIso(state: Record<string, unknown> | null): string {
	if (!state || typeof state !== "object") return "";
	const candidates = [
		safeString(
			(state.dispatch_drain as Record<string, unknown> | undefined)
				?.last_tick_at,
		),
		safeString(
			(state.leader_nudge as Record<string, unknown> | undefined)?.last_tick_at,
		),
		safeString(
			(state.fallback_auto_nudge as Record<string, unknown> | undefined)
				?.last_tick_at,
		),
		safeString(
			(state.ralph_continue_steer as Record<string, unknown> | undefined)
				?.last_state_check_at,
		),
	]
		.map((value) => value.trim())
		.filter(Boolean);
	let latestIso = "";
	let latestMs = -1;
	for (const candidate of candidates) {
		const parsed = parseIsoMillis(candidate);
		if (parsed === null || parsed <= latestMs) continue;
		latestMs = parsed;
		latestIso = candidate;
	}
	return latestIso;
}

async function resolveAuthorityPrimaryWatcherHealth(
	now = Date.now(),
): Promise<AuthorityBackoffState> {
	if (!authorityOnly) return createAuthorityBackoffState("not_authority");

	const existingRecord = await readPidFileRecord(pidFilePath).catch(() => null);
	if (!existingRecord) return createAuthorityBackoffState("pid_missing");
	if (!recordMatchesNotifyWatcherAuthority(existingRecord, retainedAuthority!, cwd)) {
		return createAuthorityBackoffState("pid_authority_mismatch", { primary_pid: existingRecord.pid });
	}
	if (!processMatchesNotifyWatcherPidRecord(existingRecord)) {
		return createAuthorityBackoffState("pid_identity_mismatch", { primary_pid: existingRecord.pid });
	}

	const persistedState = await readJsonObject(statePath);
	if (!persistedState) {
		return createAuthorityBackoffState("state_missing", {
			primary_pid: existingRecord.pid,
		});
	}

	const persistedPid = Math.trunc(
		asNumber(persistedState.pid as string | number | undefined, 0),
	);
	if (persistedPid > 0 && persistedPid !== existingRecord.pid) {
		return createAuthorityBackoffState("state_pid_mismatch", {
			primary_pid: existingRecord.pid,
		});
	}

	const lastTickAt = latestWatcherTickIso(persistedState);
	if (!lastTickAt) {
		return createAuthorityBackoffState("tick_missing", {
			primary_pid: existingRecord.pid,
		});
	}

	const lastTickMs = parseIsoMillis(lastTickAt);
	const primaryPollMs = Math.max(
		50,
		asNumber(persistedState.poll_ms as string | number | undefined, 250),
	);
	const thresholdMs = Math.max(1_000, primaryPollMs * 4);
	if (lastTickMs === null) {
		return createAuthorityBackoffState("tick_invalid", {
			primary_pid: existingRecord.pid,
			primary_last_tick_at: lastTickAt,
			threshold_ms: thresholdMs,
		});
	}

	const freshnessMs = now - lastTickMs;
	if (freshnessMs > thresholdMs) {
		return {
			active: false,
			reason: "tick_stale",
			primary_pid: existingRecord.pid,
			primary_last_tick_at: lastTickAt,
			freshness_ms: freshnessMs,
			threshold_ms: thresholdMs,
		};
	}

	return {
		active: true,
		reason: "primary_watcher_healthy",
		primary_pid: existingRecord.pid,
		primary_last_tick_at: lastTickAt,
		freshness_ms: freshnessMs,
		threshold_ms: thresholdMs,
	};
}

async function writePidFileRecord(): Promise<void> {
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	const processStartIdentity = captureNotifyWatcherProcessStartIdentity(process.pid);
	if (!processStartIdentity) {
		throw new Error("cannot prove fallback watcher process identity for PID ownership record");
	}
	const nextRecord = createNotifyWatcherPidRecord(retainedAuthority, {
		pid: process.pid,
		cwd,
		started_at: new Date(startedAt).toISOString(),
		owner_token: watcherOwnerToken,
		process_start_identity: processStartIdentity,
	});
	await atomicWriteAuthorityFile(pidFilePath, JSON.stringify(nextRecord, null, 2), {
		authority_root: retainedAuthority.canonical_state_root,
		expected_root_identity: retainedAuthority.generation.root_identity,
	});
}

async function buildWatcherManagedPayload(): Promise<Record<
	string,
	string
> | null> {
	const session = await readSessionState(cwd).catch(() => null);
	const sessionId = safeString(session?.session_id).trim();
	if (!sessionId || !session || isSessionStale(session)) return null;
	return { session_id: sessionId };
}

async function persistReboundRalphPaneState(
	statePath: string,
	state: Record<string, unknown> | null,
	paneId: string,
	nowIso: string,
): Promise<Record<string, unknown>> {
	const latestState = await readFile(statePath, "utf-8")
		.then((content) => JSON.parse(content) as Record<string, unknown>)
		.catch(() => null);
	const nextState = {
		...(latestState && typeof latestState === "object" ? latestState : state || {}),
		tmux_pane_id: paneId,
		tmux_pane_set_at: nowIso,
	};
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	await atomicWriteAuthorityFile(statePath, JSON.stringify(nextState, null, 2), {
		authority_root: retainedAuthority.canonical_state_root,
		expected_root_identity: retainedAuthority.generation.root_identity,
	});
	return nextState;
}

async function resolveRalphContinuePaneTarget(
	activeRalph: ActiveModeResult,
	nowIso: string,
): Promise<{
	paneId: string;
	state: Record<string, unknown> | null;
	reboundFrom: string;
}> {
	const currentState =
		activeRalph.state && typeof activeRalph.state === "object"
			? (activeRalph.state as Record<string, unknown>)
			: null;
	const anchorPaneId = safeString(currentState?.tmux_pane_id).trim();
	if (!anchorPaneId) {
		return {
			paneId: "",
			state: currentState,
			reboundFrom: "",
		};
	}

	const managedPayload = await buildWatcherManagedPayload();
	if (!managedPayload) {
		return {
			paneId: anchorPaneId,
			state: currentState,
			reboundFrom: "",
		};
	}

	let resolvedPaneId = await resolveManagedPaneFromAnchor(
		anchorPaneId,
		cwd,
		managedPayload,
		{ allowTeamWorker: false },
	);
	if (!resolvedPaneId) {
		resolvedPaneId = await resolveManagedSessionPane(cwd, managedPayload);
	}
	if (!resolvedPaneId) {
		return {
			paneId: "",
			state: currentState,
			reboundFrom: "",
		};
	}
	if (resolvedPaneId === anchorPaneId) {
		return {
			paneId: resolvedPaneId,
			state: currentState,
			reboundFrom: "",
		};
	}

	const updatedState = await persistReboundRalphPaneState(
		activeRalph.path,
		currentState,
		resolvedPaneId,
		nowIso,
	);
	return {
		paneId: resolvedPaneId,
		state: updatedState,
		reboundFrom: anchorPaneId,
	};
}

async function runRalphContinueSteerTick(): Promise<void> {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const activeRalph = await resolveActiveRalphState();
	const activePaneId = safeString(activeRalph.state?.tmux_pane_id).trim();
	lastRalphContinueSteer = {
		...lastRalphContinueSteer,
		active: activeRalph.active,
		current_phase: safeString(activeRalph.state?.current_phase),
		last_state_check_at: nowIso,
		last_reason: activeRalph.reason,
		last_error: null,
		state_path: activeRalph.path,
		pane_id: activePaneId,
		pane_current_command: "",
		subagent_session_id: safeString(
			activeRalph.state?.owner_codex_session_id,
		).trim(),
		active_subagent_thread_ids: [],
		shared_timestamp_path: ralphSteerTimestampPath,
		singleton_lock_path: ralphSteerLockPath,
	};

	if (!activeRalph.active) {
		if (activeRalph.reason === "starting_stale") {
			lastRalphContinueSteer.last_reason = "starting_stale";
		}
		return;
	}

	const sharedBeforeLock = await readRalphSteerTimestamp();
	lastRalphContinueSteer.shared_last_sent_at = sharedBeforeLock;
	const initialCooldown = shouldSkipRalphContinue(now, sharedBeforeLock);
	if (initialCooldown.skip) {
		lastRalphContinueSteer.last_reason = initialCooldown.reason;
		if (!sharedBeforeLock && initialCooldown.reason === "startup_cooldown") {
			lastRalphContinueSteer.cooldown_anchor_at = initialCooldown.anchorIso;
		}
		return;
	}

	const outcome = await withRalphSteerLock(async () => {
		const sharedLastSentAt = await readRalphSteerTimestamp();
		lastRalphContinueSteer.shared_last_sent_at = sharedLastSentAt;
		const cooldown = shouldSkipRalphContinue(Date.now(), sharedLastSentAt);
		if (cooldown.skip) {
			lastRalphContinueSteer.last_reason = cooldown.reason;
			if (!sharedLastSentAt && cooldown.reason === "startup_cooldown") {
				lastRalphContinueSteer.cooldown_anchor_at = cooldown.anchorIso;
			}
			return { sent: false, skipped: true };
		}

		const progressGate = await readRalphProgressGate(
			activeRalph.state,
			Date.now(),
		);
		if (!progressGate.allow) {
			lastRalphContinueSteer.last_reason = progressGate.reason;
			lastRalphContinueSteer.subagent_session_id =
				progressGate.subagent_session_id ??
				lastRalphContinueSteer.subagent_session_id;
			lastRalphContinueSteer.active_subagent_thread_ids =
				progressGate.active_subagent_thread_ids ?? [];
			return { sent: false, skipped: true };
		}

		const resolvedPane = await resolveRalphContinuePaneTarget(
			activeRalph,
			nowIso,
		);
		activeRalph.state = resolvedPane.state;
		const paneId = resolvedPane.paneId;
		if (!paneId) {
			lastRalphContinueSteer.last_reason = "pane_missing";
			lastRalphContinueSteer.pane_id = "";
			return { sent: false, skipped: true };
		}

		const paneGuard = await checkPaneReadyForTeamSendKeys(paneId);
		lastRalphContinueSteer.pane_id = paneId;
		lastRalphContinueSteer.pane_current_command =
			paneGuard.paneCurrentCommand || "";
		if (!paneGuard.ok) {
			lastRalphContinueSteer.last_reason =
				paneGuard.reason || "pane_guard_blocked";
			return { sent: false, skipped: true };
		}

		await requireRetainedActiveAuthority();
		await emitRalphContinueSteer(paneId, RALPH_CONTINUE_TEXT);
		await writeRalphSteerTimestamp(nowIso);
		lastRalphContinueSteer.last_sent_at = nowIso;
		lastRalphContinueSteer.shared_last_sent_at = nowIso;
		lastRalphContinueSteer.cooldown_anchor_at = nowIso;
		lastRalphContinueSteer.last_reason = "sent";
		await eventLog({
			type: "ralph_continue_steer",
			reason: "sent",
			pane_id: paneId,
			rebound_from: resolvedPane.reboundFrom || null,
			state_path: activeRalph.path,
			current_phase: safeString(activeRalph.state?.current_phase) || null,
			cadence_ms: RALPH_CONTINUE_CADENCE_MS,
			message: RALPH_CONTINUE_TEXT,
			shared_timestamp_path: ralphSteerTimestampPath,
		});
		return { sent: true, skipped: false };
	});

	if (outcome === null) {
		lastRalphContinueSteer.shared_last_sent_at =
			await readRalphSteerTimestamp();
	}
}

async function runRalphWatcherBehaviorTick(): Promise<void> {
	try {
		await runRalphContinueSteerTick();
	} catch (error) {
		const message = error instanceof Error ? error.message : safeString(error);
		lastRalphContinueSteer = {
			...lastRalphContinueSteer,
			last_reason: "send_failed",
			last_error: message || "unknown_error",
		};
		await eventLog({
			type: "ralph_continue_steer",
			reason: "send_failed",
			pane_id: lastRalphContinueSteer.pane_id || null,
			state_path: lastRalphContinueSteer.state_path || null,
			current_phase: lastRalphContinueSteer.current_phase || null,
			error: lastRalphContinueSteer.last_error,
		});
	}
}

async function registerPidFile(): Promise<void> {
	await requireRetainedActiveAuthority();
	if (runOnce) return;
	if (testBootstrappedAuthority) return;
	const existingRecord = await readPidFileRecord(pidFilePath);
	const existingPid = existingRecord?.pid ?? null;
	const recordMatchesAuthority = existingRecord !== null
		&& !!retainedAuthority
		&& recordMatchesNotifyWatcherAuthority(existingRecord, retainedAuthority, cwd);
	if (existingPid && existingPid !== process.pid && recordMatchesAuthority && isPidAlive(existingPid)) {
		throw new Error("an authenticated notify fallback watcher is already active");
	}
	await writePidFileRecord();
}


function parentIsGone(): boolean {
	if (!Number.isFinite(parentPid) || parentPid <= 0) return false;
	if (parentPid === process.pid) return false;
	return !isPidAlive(parentPid);
}

async function writeState(extra: Record<string, unknown> = {}): Promise<void> {
	await requireRetainedActiveAuthority();
	const testControlPlaneEnabled = process.env.NODE_ENV === "test"
		&& process.env.OMX_NOTIFY_FALLBACK_TEST_BOOTSTRAP_AUTHORITY === "1";
	const state = {
		pid: process.pid,
		parent_pid: parentPid,
		started_at: new Date(startedAt).toISOString(),
		cwd,
		notify_script: notifyScript,
		authority_only: authorityOnly,
		poll_ms: pollMs,
		effective_poll_ms: adaptivePollState.current_ms,
		idle_max_poll_ms: idleMaxPollMs,
		pid_file: runOnce ? null : pidFilePath,
		max_lifetime_ms: maxLifetimeMs,
		tracked_files: fileState.size,
		seen_turns: seenTurnKeys.size,
		dispatch_drain: {
			max_per_tick: dispatchTickMax,
			...lastDispatchDrain,
			enabled: testControlPlaneEnabled,
			run_count: testControlPlaneEnabled ? dispatchDrainRuns : 0,
			reason: testControlPlaneEnabled ? undefined : "control_plane_disabled",
		},
		leader_nudge: {
			...lastLeaderNudge,
			enabled: testControlPlaneEnabled,
			run_count: testControlPlaneEnabled ? leaderNudgeRuns : 0,
			reason: testControlPlaneEnabled ? undefined : "control_plane_disabled",
		},
		ralph_continue_steer: {
			...lastRalphContinueSteer,
			enabled: true,
			cadence_ms: RALPH_CONTINUE_CADENCE_MS,
			message: RALPH_CONTINUE_TEXT,
		},
		fallback_auto_nudge: {
			...lastFallbackAutoNudge,
			enabled: testControlPlaneEnabled,
			reason: testControlPlaneEnabled ? undefined : "control_plane_disabled",
			stall_ms: AUTO_NUDGE_STALL_MS,
		},
		authority_backoff: lastAuthorityBackoff,
		adaptive_poll: {
			...adaptivePollState,
			enabled: true,
			base_ms: pollMs,
			max_ms: idleMaxPollMs,
		},
		...extra,
	};
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	await atomicWriteAuthorityFile(statePath, JSON.stringify(state, null, 2), {
		authority_root: retainedAuthority.canonical_state_root,
		expected_root_identity: retainedAuthority.generation.root_identity,
	}).catch(() => {});
}

async function writeAuthorityBackoffState(): Promise<void> {
	await requireRetainedActiveAuthority();
	const existing = await readJsonObject(statePath);
	const state =
		existing && typeof existing === "object"
			? { ...existing, authority_backoff: lastAuthorityBackoff }
			: { authority_backoff: lastAuthorityBackoff };
	if (!retainedAuthority) throw new Error("notify fallback watcher has no retained authority");
	await atomicWriteAuthorityFile(statePath, JSON.stringify(state, null, 2), {
		authority_root: retainedAuthority.canonical_state_root,
		expected_root_identity: retainedAuthority.generation.root_identity,
	}).catch(() => {});
}

async function readJsonObject(
	path: string,
): Promise<Record<string, unknown> | null> {
	return readFile(path, "utf-8")
		.then((content) => JSON.parse(content) as Record<string, unknown>)
		.catch(() => null);
}

async function readScopedJsonWithAuthority(
	authority: ResolvedStateAuthorityContext,
	fileName: string,
): Promise<Record<string, unknown> | null> {
	const path = await getScopedStatePath(authority.canonical_state_root, fileName);
	await ensureAuthorityDirectory(authority.canonical_state_root, dirname(path), {
		expected_root_identity: authority.generation.root_identity,
	});
	const content = await readAuthorityFileWithExpectedRoot(path, {
		authority_root: authority.canonical_state_root,
		expected_root_identity: authority.generation.root_identity,
	});
	return content === null ? null : JSON.parse(content) as Record<string, unknown>;
}

async function readAutoNudgeCount(authority: ResolvedStateAuthorityContext): Promise<number> {
	const parsed = await readScopedJsonWithAuthority(authority, "auto-nudge-state.json");
	return Math.max(
		0,
		Math.trunc(asNumber(parsed?.nudgeCount as string | number | undefined, 0)),
	);
}

async function readAutoNudgeState(
	authority: ResolvedStateAuthorityContext,
): Promise<Record<string, unknown> | null> {
	return await readScopedJsonWithAuthority(authority, "auto-nudge-state.json");
}



export async function runFallbackAutoNudgeTick(
	authority: ResolvedStateAuthorityContext,
): Promise<void> {
	const now = Date.now();
	const nowIso = new Date(now).toISOString();
	const hudState = await readScopedJsonWithAuthority(authority, "hud-state.json");


	lastFallbackAutoNudge = {
		...lastFallbackAutoNudge,
		enabled: true,
		stall_ms: AUTO_NUDGE_STALL_MS,
		last_tick_at: nowIso,
		last_error: null,
	};

	if (!hudState) {
		lastFallbackAutoNudge.last_reason = "hud_state_missing";
		return;
	}

	const lastTurnAt = safeString(hudState.last_turn_at);
	const turnCount = Number.isFinite(hudState.turn_count)
		? (hudState.turn_count as number)
		: null;
	const lastMessage = safeString(
		hudState.last_agent_output || hudState.last_agent_message || "",
	);
	const lastTurnMs = parseIsoMillis(lastTurnAt);

	lastFallbackAutoNudge.last_turn_at = lastTurnAt;
	lastFallbackAutoNudge.last_turn_count = turnCount;
	lastFallbackAutoNudge.last_message = lastMessage.slice(0, 400);

	if (
		!lastTurnAt ||
		lastTurnMs === null ||
		turnCount === null ||
		turnCount < 1
	) {
		lastFallbackAutoNudge.last_reason = "hud_state_incomplete";
		return;
	}
	if (!lastMessage.trim()) {
		lastFallbackAutoNudge.last_reason = "no_last_message";
		return;
	}
	if (now - lastTurnMs < AUTO_NUDGE_STALL_MS) {
		lastFallbackAutoNudge.last_reason = "recent_turn_activity";
		return;
	}

	const signature = await resolveAutoNudgeSignature(
		authority.canonical_state_root,
		{
			type: "agent-turn-complete",
			cwd,
			source: "notify-fallback-watcher-stall",
			"thread-id": "notify-fallback-watcher-stall",
			"turn-id": `stalled-turn-${turnCount}`,
			"input-messages": [
				"[notify-fallback] synthesized from stalled hud-state",
			],
			"last-assistant-message": lastMessage,
		},
		lastMessage,
	);

	const persistedAutoNudgeState = await readAutoNudgeState(authority);

	const autoNudgeConfig = await loadAutoNudgeConfig();
	const semanticSignature = normalizeAutoNudgeSignatureText(lastMessage);
	if (
		signature &&
		safeString(persistedAutoNudgeState?.lastSignature) === signature
	) {
		lastFallbackAutoNudge.last_reason = "already_nudged_for_signature";
		lastFallbackAutoNudge.last_nudged_signature = signature;
		return;
	}
	const lastNudgeAtMs = parseIsoMillis(
		safeString(persistedAutoNudgeState?.lastNudgeAt),
	);
	if (
		semanticSignature &&
		safeString(persistedAutoNudgeState?.lastSemanticSignature) ===
			semanticSignature &&
		autoNudgeConfig.ttlMs > 0 &&
		lastNudgeAtMs !== null &&
		now - lastNudgeAtMs < autoNudgeConfig.ttlMs
	) {
		lastFallbackAutoNudge.last_reason = "ttl_active";
		lastFallbackAutoNudge.last_nudged_signature = signature;
		return;
	}

	const beforeCount = await readAutoNudgeCount(authority);
	await requireRetainedActiveAuthority();
	await maybeAutoNudge({
		cwd,
		stateDir: authority.canonical_state_root,
		logsDir,
		authority,
		syncResult: {
			invocationSessionId: "",
			skillState: null,
			releaseReason: null,
		},
		payload: {
			type: "agent-turn-complete",
			cwd,
			source: "notify-fallback-watcher-stall",
			"thread-id": "notify-fallback-watcher-stall",
			"turn-id": `stalled-turn-${turnCount}`,
			"input-messages": [
				"[notify-fallback] synthesized from stalled hud-state",
			],
			"last-assistant-message": lastMessage,
		},
	});
	const afterCount = await readAutoNudgeCount(authority);

	if (afterCount > beforeCount) {
		lastFallbackAutoNudge.last_nudged_signature = signature;
		lastFallbackAutoNudge.last_nudged_at = nowIso;
		lastFallbackAutoNudge.last_reason = "sent";
		await eventLog({
			type: "fallback_auto_nudge_tick",
			reason: "sent",
			turn_count: turnCount,
			last_turn_at: lastTurnAt,
			stall_ms: AUTO_NUDGE_STALL_MS,
		});
		return;
	}

	lastFallbackAutoNudge.last_reason = "eligible_but_not_sent";
}

async function requestShutdown(
	reason: string,
	signal: string | null = null,
): Promise<void> {
	if (shutdownPromise) return shutdownPromise;
	stopping = true;
	shutdownPromise = (async () => {
		await terminateActiveNotifyHookChild();
		await activeDeliveryPromise?.catch(() => undefined);
		await writeState({
			stop_reason: reason,
			stop_signal: signal,
			stopping: true,
		});
		await eventLog({
			type: "watcher_stop",
			signal,
			reason,
			parent_pid: parentPid,
			pid_file: runOnce ? null : pidFilePath,
		});
		process.exit(0);
	})();
	return shutdownPromise;
}

async function enforceLifecycleGuards(): Promise<boolean> {
	if (runOnce) return false;
	if (parentIsGone()) {
		const activeRalph = await resolveActiveRalphState();
		if (activeRalph.active) {
			const currentPhase = safeString(activeRalph.state?.current_phase);
			const nextParentGuard: ParentGuardState = {
				reason: "parent_gone_deferred_for_active_ralph",
				state_path: activeRalph.path,
				current_phase: currentPhase,
			};
			if (
				lastParentGuard.reason !== nextParentGuard.reason ||
				lastParentGuard.state_path !== nextParentGuard.state_path ||
				lastParentGuard.current_phase !== nextParentGuard.current_phase ||
				lastParentGuard.team_name !== nextParentGuard.team_name ||
				lastParentGuard.pane_count !== nextParentGuard.pane_count
			) {
				await eventLog({
					type: "watcher_parent_guard",
					reason: nextParentGuard.reason,
					state_path: nextParentGuard.state_path,
					current_phase: currentPhase || null,
				});
				lastParentGuard = nextParentGuard;
			}
			return false;
		}

		const activeTeam = await resolveActiveTeamState();
		if (activeTeam.active) {
			const currentPhase = safeString(activeTeam.state?.current_phase);
			const nextParentGuard: ParentGuardState = {
				reason: "parent_gone_deferred_for_active_team",
				state_path: activeTeam.path,
				current_phase: currentPhase,
				team_name: activeTeam.team_name,
				pane_count: activeTeam.pane_count,
			};
			if (
				lastParentGuard.reason !== nextParentGuard.reason ||
				lastParentGuard.state_path !== nextParentGuard.state_path ||
				lastParentGuard.current_phase !== nextParentGuard.current_phase ||
				lastParentGuard.team_name !== nextParentGuard.team_name ||
				lastParentGuard.pane_count !== nextParentGuard.pane_count
			) {
				await eventLog({
					type: "watcher_parent_guard",
					reason: nextParentGuard.reason,
					state_path: nextParentGuard.state_path,
					current_phase: currentPhase || null,
					team_name: activeTeam.team_name,
					pane_count: activeTeam.pane_count,
				});
				lastParentGuard = nextParentGuard;
			}
			return false;
		}

		lastParentGuard = { reason: "", state_path: "", current_phase: "" };
		await requestShutdown("parent_gone");
		return true;
	}
	if (maxLifetimeMs > 0 && Date.now() - startedAt >= maxLifetimeMs) {
		await requestShutdown("max_lifetime_exceeded");
		return true;
	}
	return false;
}

function sessionDirs(): string[] {
	const now = new Date();
	const today = join(
		homedir(),
		".codex",
		"sessions",
		String(now.getUTCFullYear()),
		String(now.getUTCMonth() + 1).padStart(2, "0"),
		String(now.getUTCDate()).padStart(2, "0"),
	);
	const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const yesterday = join(
		homedir(),
		".codex",
		"sessions",
		String(yesterdayDate.getUTCFullYear()),
		String(yesterdayDate.getUTCMonth() + 1).padStart(2, "0"),
		String(yesterdayDate.getUTCDate()).padStart(2, "0"),
	);
	return Array.from(new Set([today, yesterday]));
}

async function readFirstLine(path: string): Promise<string> {
	const content = await readFile(path, "utf-8");
	const idx = content.indexOf("\n");
	return idx >= 0 ? content.slice(0, idx) : content;
}

function shouldTrackSessionMeta(line: string): string | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!parsed || parsed.type !== "session_meta" || !parsed.payload) return null;
	const payload = parsed.payload as Record<string, unknown>;
	if (safeString(payload.cwd) !== cwd) return null;
	const threadId = safeString(payload.id);
	return threadId || null;
}

async function discoverRolloutFiles(): Promise<string[]> {
	const discovered: string[] = [];
	for (const dir of sessionDirs()) {
		if (!existsSync(dir)) continue;
		const names = await readdir(dir).catch(() => [] as string[]);
		for (const name of names) {
			if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
			const path = join(dir, name);
			const st = await stat(path).catch(() => null);
			if (!st) continue;
			if (st.mtimeMs < startedAt - fileWindowMs) continue;
			discovered.push(path);
		}
	}
	discovered.sort();
	return discovered;
}

function turnKey(threadId: string, turnId: string): string {
	return `${threadId || "no-thread"}|${turnId || "no-turn"}`;
}

async function buildNotifyPayload(
	threadId: string,
	turnId: string,
	lastMessage: string,
): Promise<Record<string, unknown>> {
	const session = await readSessionState(cwd).catch(() => null);
	const payloadSessionId =
		normalizeValidSessionId(session?.session_id) || threadId;
	return {
		type: "agent-turn-complete",
		cwd,
		session_id: payloadSessionId,
		"thread-id": threadId,
		"turn-id": turnId,
		"input-messages": [
			"[notify-fallback] synthesized from rollout task_complete",
		],
		"last-assistant-message": lastMessage || "",
		source: "notify-fallback-watcher",
	};
}

async function invokeNotifyHook(
	payload: Record<string, unknown>,
): Promise<{
	spawned: boolean;
	childPid?: number;
	status?: number | null;
	signal?: string | null;
	error?: unknown;
	timedOut?: boolean;
	authorityDeadline?: boolean;
	terminationUnconfirmed?: boolean;
}> {
	return new Promise((resolveInvoke) => {
		let settled = false;
		let spawned = false;
		let timedOut = false;
		let deadlineTimedOut = false;
		const child = spawn(
			process.execPath,
			[notifyScript, JSON.stringify(payload)],
			{
				cwd,
				stdio: "ignore",
				env: { ...process.env, OMX_NOTIFY_HOOK_TRUSTED_MANAGED_CWD: cwd },
				windowsHide: true,
			},
		);
		const close = new Promise<{ status: number | null; signal: string | null }>(
			(resolveClose) => {
				child.once("close", (status, signal) =>
					resolveClose({ status, signal }),
				);
			},
		);
		activeNotifyHookChild = child;
		activeNotifyHookClose = close;
		const finish = (result: {
			spawned: boolean;
			childPid?: number;
			status?: number | null;
			signal?: string | null;
			error?: unknown;
			timedOut?: boolean;
			authorityDeadline?: boolean;
			terminationUnconfirmed?: boolean;
		}) => {
			if (settled) return;
			settled = true;
			clearTimeout(hookTimeout);
			clearTimeout(deadlineTimeout);
			if (activeNotifyHookChild === child) {
				activeNotifyHookChild = null;
				activeNotifyHookClose = null;
				activeNotifyHookTermination = null;
			}
			resolveInvoke(result);
		};
		const stopForTimeout = async (isDeadline: boolean) => {
			if (settled) return;
			if (isDeadline) deadlineTimedOut = true;
			else timedOut = true;
			const confirmed = await terminateActiveNotifyHookChild();
			const closed = await Promise.race([close, sleep(2_000).then(() => null)]);
			finish({
				spawned: true,
				childPid: child.pid,
				status: closed?.status ?? null,
				signal: closed?.signal ?? null,
				timedOut,
				authorityDeadline: deadlineTimedOut,
				terminationUnconfirmed: !confirmed || closed === null,
				error: isDeadline
					? new Error("authority_deadline")
					: new Error("hook_timeout"),
			});
		};
		const hookTimeout = setTimeout(() => {
			void stopForTimeout(false);
		}, 10_000);
		const deadlineTimeout = setTimeout(
			() => {
				void stopForTimeout(true);
			},
			Math.max(0, authorityDeadlineAtMs - Date.now()),
		);
		child.once("error", (error) =>
			finish({ spawned, childPid: child.pid, error }),
		);
		child.once("spawn", () => {
			spawned = true;
		});
		void close.then(({ status, signal }) =>
			finish({ spawned, childPid: child.pid, status, signal }),
		);
	});
}

async function processLine(
	meta: WatcherFileMeta,
	line: string,
	filePath: string,
): Promise<void> {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(line) as Record<string, unknown>;
	} catch {
		return;
	}

	if (!parsed || parsed.type !== "event_msg" || !parsed.payload) return;
	if ((parsed.payload as Record<string, unknown>).type !== "task_complete")
		return;
	const turnId = safeString(
		(parsed.payload as Record<string, unknown>).turn_id,
	);
	const evtTs = Date.parse(safeString(parsed.timestamp));
	const key = turnKey(meta.threadId, turnId);
	if (
		!turnId ||
		!Number.isFinite(evtTs) ||
		evtTs > Date.now() + 5 * 60 * 1000 ||
		evtTs < startedAt - 3000
	) {
		seenTurnKeys.add(key);
		return;
	}
	if (seenTurnKeys.has(key)) return;
	const payload = await buildNotifyPayload(
		meta.threadId,
		turnId,
		safeString((parsed.payload as Record<string, unknown>).last_agent_message),
	);
	let spawnResult: Awaited<ReturnType<typeof invokeNotifyHook>> | undefined;
	const deliveryPromise = deliverNotifyFallback({
		stateDir,
		threadId: meta.threadId,
		turnId,
		eventTimestampMs: evtTs,
		rolloutPath: filePath,
		watcherMode: runOnce ? "once" : "persistent",
		deadlineAtMs: authorityDeadlineAtMs,
		stopping: () => stopping,
		spawnHook: async () => {
			await requireRetainedActiveAuthority();
			spawnResult = await invokeNotifyHook(payload);
			return spawnResult;
		},
	});
	activeDeliveryPromise = deliveryPromise;
	const result = await deliveryPromise.finally(() => {
		if (activeDeliveryPromise === deliveryPromise) activeDeliveryPromise = null;
	});
	if (
		result.kind === "retry_eligible" &&
		!stopping &&
		Date.now() + 250 < authorityDeadlineAtMs
	) {
		await sleep(250);
		await processLine(meta, line, filePath);
		return;
	}
	seenTurnKeys.add(key);
	if (result.kind !== "acquired_effect") {
		await eventLog({
			type: "fallback_notify_claim",
			thread_id: meta.threadId,
			turn_id: turnId,
			file: filePath,
			reason: "reason" in result ? result.reason : result.kind,
			attempt: "attempt" in result ? result.attempt : undefined,
		});
	}
	if (spawnResult?.spawned) {
		await eventLog({
			type: "fallback_notify",
			ok: spawnResult.status === 0,
			thread_id: meta.threadId,
			turn_id: turnId,
			file: filePath,
			reason: spawnResult.status === 0 ? "sent" : "notify_hook_failed",
			error:
				spawnResult.status === 0
					? undefined
					: String(spawnResult.error || "").slice(0, 240),
		});
	}
}

async function ensureTrackedFiles(): Promise<void> {
	const files = await discoverRolloutFiles();
	for (const path of files) {
		if (fileState.has(path)) continue;
		const line = await readFirstLine(path).catch(() => "");
		const threadId = shouldTrackSessionMeta(line);
		if (!threadId) continue;
		const fileStat = await stat(path).catch(() => null);
		if (!fileStat) continue;
		const size = fileStat.size || 0;
		const offset = runOnce ? 0 : size;
		fileState.set(path, {
			threadId,
			offset,
			size,
			partial: "",
			decoder: new StringDecoder("utf8"),
		});
	}
}

function splitBufferedLines(
	partial: string,
	delta: string,
): { lines: string[]; partial: string } {
	const merged = partial + delta;
	const lines = merged.split("\n");
	return {
		lines,
		partial: lines.pop() || "",
	};
}

async function readFileDelta(
	path: string,
	offset: number,
	currentSize: number,
): Promise<{ bytes: Buffer; nextOffset: number }> {
	const length = currentSize - offset;
	if (length <= 0) return { bytes: Buffer.alloc(0), nextOffset: offset };
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		let totalBytesRead = 0;
		while (totalBytesRead < length) {
			const { bytesRead } = await handle.read(
				buffer,
				totalBytesRead,
				length - totalBytesRead,
				offset + totalBytesRead,
			);
			if (bytesRead === 0) break;
			totalBytesRead += bytesRead;
		}
		return {
			bytes: buffer.subarray(0, totalBytesRead),
			nextOffset: offset + totalBytesRead,
		};
	} finally {
		await handle.close().catch(() => {});
	}
}

async function pollFiles(): Promise<number> {
	let processedCount = 0;
	for (const [path, meta] of fileState.entries()) {
		const fileStat = await stat(path).catch(() => null);
		if (!fileStat) continue;
		const currentSize = fileStat.size || 0;
		if (currentSize < meta.offset) {
			meta.offset = 0;
			meta.partial = "";
			meta.decoder = new StringDecoder("utf8");
		}
		if (currentSize <= meta.offset) continue;
		const read = await readFileDelta(path, meta.offset, currentSize).catch(
			() => null,
		);
		if (!read || read.bytes.length === 0) continue;
		const { bytes, nextOffset } = read;
		meta.offset = nextOffset;
		const delta = meta.decoder.write(bytes);
		if (!delta) continue;
		const buffered = splitBufferedLines(meta.partial, delta);
		const lines = buffered.lines;
		meta.partial = buffered.partial;
		for (const line of lines) {
			if (!line.trim()) continue;
			await processLine(meta, line, path);
			processedCount += 1;
		}
	}
	return processedCount;
}

export async function runLeaderNudgeTick(
	authority: ResolvedStateAuthorityContext,
): Promise<boolean> {
	const startedIso = new Date().toISOString();
	const leaderOnly =
		safeString(process.env.OMX_TEAM_WORKER || "").trim() === "";
	const staleThresholdMs = resolveLeaderStalenessThresholdMs();

	if (!leaderOnly) {
		leaderNudgeRuns += 1;
		lastLeaderNudge = {
			enabled: true,
			leader_only: false,
			stale_threshold_ms: staleThresholdMs,
			precomputed_leader_stale: null,
			last_tick_at: startedIso,
			last_error: "worker_context",
		};
		return false;
	}

	try {
		const preComputedLeaderStale = await isLeaderStale(
			authority.canonical_state_root,
			staleThresholdMs,
			Date.now(),
		);
		await maybeNudgeTeamLeader({
			cwd,
			stateDir: authority.canonical_state_root,
			logsDir,
			authority,
			preComputedLeaderStale,
			allowFreshMailboxNudges: false,
			source: "notify_fallback_watcher",
		});


		leaderNudgeRuns += 1;
		lastLeaderNudge = {
			enabled: true,
			leader_only: true,
			stale_threshold_ms: staleThresholdMs,
			precomputed_leader_stale: preComputedLeaderStale,
			last_tick_at: startedIso,
			last_error: null,
		};
		const reason = preComputedLeaderStale
			? "leader_nudge_checked"
			: "leader_nudge_skipped_not_stale";
		if (shouldLogLeaderNudgeTick(reason)) {
			await eventLog({
				type: "leader_nudge_tick",
				leader_only: true,
				run_count: leaderNudgeRuns,
				stale_threshold_ms: staleThresholdMs,
				precomputed_leader_stale: preComputedLeaderStale,
				reason,
			});
		}
		return preComputedLeaderStale;
	} catch (err) {
		leaderNudgeRuns += 1;
		lastLeaderNudge = {
			enabled: true,
			leader_only: true,
			stale_threshold_ms: staleThresholdMs,
			precomputed_leader_stale: null,
			last_tick_at: startedIso,
			last_error: err instanceof Error ? err.message : safeString(err),
		};
		await eventLog({
			type: "leader_nudge_tick",
			leader_only: true,
			run_count: leaderNudgeRuns,
			stale_threshold_ms: staleThresholdMs,
			reason: "leader_nudge_failed",
			error: lastLeaderNudge.last_error,
		});
		return true;
	}
}

export async function runDispatchDrainTick(
	authority: ResolvedStateAuthorityContext,
): Promise<boolean> {

	const startedIso = new Date().toISOString();
	try {
		const result = await drainPendingTeamDispatch({
			cwd,
			stateDir: authority.canonical_state_root,
			logsDir,
			authority,
			maxPerTick: dispatchTickMax,
		} as any);

		dispatchDrainRuns += 1;
		lastDispatchDrain = {
			leader_only: safeString(process.env.OMX_TEAM_WORKER || "").trim() === "",
			last_tick_at: startedIso,
			last_result: result,
			last_error: null,
		};
		if (shouldLogDispatchDrainTick(result)) {
			await eventLog({
				type: "dispatch_drain_tick",
				leader_only: lastDispatchDrain.leader_only,
				dispatch_max_per_tick: dispatchTickMax,
				run_count: dispatchDrainRuns,
				...(result && typeof result === "object"
					? (result as Record<string, unknown>)
					: {}),
			});
		}
		return shouldLogDispatchDrainTick(result);
	} catch (err) {
		dispatchDrainRuns += 1;
		lastDispatchDrain = {
			leader_only: safeString(process.env.OMX_TEAM_WORKER || "").trim() === "",
			last_tick_at: startedIso,
			last_result: null,
			last_error: err instanceof Error ? err.message : safeString(err),
		};
		await eventLog({
			type: "dispatch_drain_tick",
			leader_only: lastDispatchDrain.leader_only,
			dispatch_max_per_tick: dispatchTickMax,
			run_count: dispatchDrainRuns,
			reason: "dispatch_drain_failed",
			error: lastDispatchDrain.last_error,
		});
		return true;
	}
}

async function shouldSuppressInteractiveFallbackTicks(): Promise<boolean> {
	const [deepInterviewStateActive, deepInterviewInputLockActive] =
		await Promise.all([
			isDeepInterviewStateActive(stateDir, undefined),
			isDeepInterviewInputLockActive(stateDir, undefined),
		]);
	return deepInterviewStateActive || deepInterviewInputLockActive;
}

async function pumpTeamControlPlaneTick(
	authority: ResolvedStateAuthorityContext,
): Promise<CycleActivitySummary> {
	if (process.env.NODE_ENV !== "test" || process.env.OMX_NOTIFY_FALLBACK_TEST_BOOTSTRAP_AUTHORITY !== "1") {
		return { active: false, reason: "control_plane_disabled" };
	}
	const dispatchActive = await runDispatchDrainTick(authority);
	if (await shouldSuppressInteractiveFallbackTicks()) {
		return { active: dispatchActive, reason: dispatchActive ? "dispatch_drain" : "deep_interview_locked" };
	}
	const leaderActive = await runLeaderNudgeTick(authority);
	await runFallbackAutoNudgeTick(authority);
	const autoNudgeActive = lastFallbackAutoNudge.last_reason === "sent";
	if (dispatchActive) return { active: true, reason: "dispatch_drain" };
	if (leaderActive) return { active: true, reason: "leader_nudge" };
	if (autoNudgeActive) return { active: true, reason: "fallback_auto_nudge" };
	return { active: false, reason: lastFallbackAutoNudge.last_reason || "control_plane_idle" };
}

async function runWatcherCycle(): Promise<number> {
	return await withRetainedAuthorityTransaction(async (authority) => {

		await requireRetainedActiveAuthority();
		await compactNotifyFallbackDeliveries(stateDir).catch(async (error) => {
			await eventLog({
				type: "fallback_notify_claim",
				reason: "compaction_io_skip",
				error: error instanceof Error ? error.message : String(error),
			});
		});
		let processedRolloutCount = 0;
		if (authorityOnly) {
			const authorityBackoff = await resolveAuthorityPrimaryWatcherHealth();
			lastAuthorityBackoff = authorityBackoff;
			if (authorityBackoff.active) {
				await writeAuthorityBackoffState();
				return processedRolloutCount;
			}
		} else {
			lastAuthorityBackoff = createAuthorityBackoffState("");
		}
		if (!authorityOnly) {
			await ensureTrackedFiles();
			processedRolloutCount = await pollFiles();
		}
		const controlPlaneSummary = await pumpTeamControlPlaneTick(authority);
		if (!authorityOnly && !(await shouldSuppressInteractiveFallbackTicks())) {
			await runRalphWatcherBehaviorTick();
		}
		const ralphActive = lastRalphContinueSteer.last_reason === "sent";
		const summary: CycleActivitySummary =
			processedRolloutCount > 0
				? { active: true, reason: "rollout_event" }
				: controlPlaneSummary.active
					? controlPlaneSummary
					: ralphActive
						? { active: true, reason: "ralph_continue_steer" }
						: {
								active: false,
								reason:
									controlPlaneSummary.reason ||
									lastRalphContinueSteer.last_reason ||
									"idle",
							};
		const nextDelayMs = updateAdaptivePollState(summary);
		await writeState({ last_cycle_activity: summary.reason });
		return nextDelayMs;
	});
}

async function tick(): Promise<void> {
	if (stopping) return;
	if (await enforceLifecycleGuards()) return;
	const nextDelayMs = await runWatcherCycle();
	if (await enforceLifecycleGuards()) return;
	setTimeout(() => {
		void tick();
	}, nextDelayMs);
}

function shutdown(signal: string): void {
	void requestShutdown("signal", signal);
}

async function main(): Promise<void> {
	if (
		process.env.NODE_ENV === "test" &&
		process.env.OMX_NOTIFY_FALLBACK_TEST_FATAL === "1"
	) {
		throw new Error("test fatal notify fallback failure");
	}
	if (process.env.NODE_ENV === "test"
		&& process.env.OMX_NOTIFY_FALLBACK_TEST_BOOTSTRAP_AUTHORITY === "1"
		&& !process.env.OMX_STATE_AUTHORITY_ID) {
		await mkdir(join(cwd, ".omx", "state"), { recursive: true, mode: 0o700 });
		const testSessionId = safeString(process.env.OMX_SESSION_ID).trim() || `watcher-test-${process.pid}`;
		const testAuthority = await initializeStateAuthority({
			startup_cwd: cwd,
			observed_cwd: cwd,
			launch_id: `notify-fallback-test-${process.pid}`,
			session_binding: { canonical_session_id: testSessionId },
		});
		await mintStateAuthorityTransportCapability(testAuthority);
		Object.assign(process.env, buildStateAuthorityTransportEnv(testAuthority));
		testBootstrappedAuthority = true;
	}
	retainedAuthority = await retainActiveAuthority();
	stateDir = retainedAuthority.canonical_state_root;
	omxDir = dirname(stateDir);
	logsDir = join(omxDir, "logs");
	statePath = join(stateDir, "notify-fallback-state.json");
	pidFilePath = join(stateDir, "notify-fallback.pid");
	if (process.argv.includes("--pid-file") && resolve(argValue("--pid-file")) !== pidFilePath) {
		throw new Error("notify fallback watcher pid path conflicts with authenticated state authority");
	}
	logPath = join(logsDir, `notify-fallback-${new Date().toISOString().split("T")[0]}.jsonl`);
	logRotatePath = `${logPath}.1`;
	logLockPath = `${logPath}.lock`;
	ralphSteerTimestampPath = join(stateDir, "ralph-last-steer-at");
	ralphSteerLockPath = join(stateDir, "ralph-continue-steer.lock");
	await requireRetainedActiveAuthority();
	if (!existsSync(notifyScript)) {
		const reason = `notify script missing: ${notifyScript}`;
		await eventLog({
			type: "watcher_error",
			reason: "notify_script_missing",
			notify_script: notifyScript,
		});
		process.stderr.write(`notify-fallback-watcher: ${reason}\n`);
		process.exit(1);
	}

	await withRetainedAuthorityTransaction(async () => {
		await registerPidFile();
	});
	await loadPersistedWatcherState();
	if (!(runOnce && authorityOnly)) {
		await eventLog({
			type: "watcher_start",
			cwd,
			notify_script: notifyScript,
			authority_only: authorityOnly,
			poll_ms: pollMs,
			effective_poll_ms: adaptivePollState.current_ms,
			idle_max_poll_ms: idleMaxPollMs,
			once: runOnce,
			parent_pid: parentPid,
			pid_file: runOnce ? null : pidFilePath,
			max_lifetime_ms: maxLifetimeMs,
		});
	}
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGHUP", () => shutdown("SIGHUP"));

	if (await enforceLifecycleGuards()) return;

	if (runOnce) {
		await runWatcherCycle();
		if (!authorityOnly) {
			await eventLog({
				type: "watcher_once_complete",
				authority_only: authorityOnly,
				seen_turns: seenTurnKeys.size,
			});
		}
		process.exit(0);
	}

	await tick();
}

main().catch((err) => {
	const message = err instanceof Error ? err.message : safeString(err);
	process.stderr.write(
		`notify-fallback-watcher: fatal: ${message || "unknown error"}\n`,
	);
	process.exit(1);
});
