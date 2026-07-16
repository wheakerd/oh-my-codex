// @ts-nocheck
/**
 * Team worker: heartbeat, idle detection, and leader notification.
 */

import {
	readFile,
	stat,
	readdir,
} from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { resolveStateAuthorityForMutation, atomicWriteAuthorityFile, ensureAuthorityDirectory, readAuthorityFileWithExpectedRoot, type ResolvedStateAuthorityContext } from "../../state/authority.js";
import { resolveWorkerTeamStateRoot } from "../../team/state-root.js";
import { sameFilePath } from "../../utils/paths.js";
import { asNumber, safeString, isTerminalPhase } from "./utils.js";
import { readJsonIfExists } from "./state-io.js";
import { logTmuxHookEvent } from "./log.js";
import { runProcess } from "./process-runner.js";
import {
	evaluatePaneInjectionReadiness,
	sendPaneInput,
} from "./team-tmux-guard.js";
import { resolvePaneTarget } from "./tmux-injection.js";
import {
	classifyLeaderActionState,
	resolveAllWorkersIdleIntent,
	resolveWorkerIdleIntent,
} from "./orchestration-intent.js";
import { DEFAULT_MARKER } from "../tmux-hook-engine.js";
const LEADER_PANE_SHELL_NO_INJECTION_REASON = "leader_pane_shell_no_injection";

export async function resolveTeamStateDirForWorker(cwd, _parsedTeamWorker) {
	return resolveStateAuthorityForMutation({
		startup_cwd: process.env.OMX_STARTUP_CWD?.trim() || cwd,
		observed_cwd: cwd,
		session_id: process.env.OMX_SESSION_ID?.trim() || undefined,
	})
		.then((authority) => authority.canonical_state_root)
		.catch(() => null);
}

export async function assertWorkerNotificationAuthority({
	cwd,
	stateDir,
	parsedTeamWorker,
	authority,
	requireTeamDocuments = true,
}: {
	cwd: string;
	stateDir: string;
	parsedTeamWorker: { teamName: string; workerName: string };
	authority: ResolvedStateAuthorityContext;
	requireTeamDocuments?: boolean;
}): Promise<void> {
	const resolved = await resolveWorkerTeamStateRoot(cwd, parsedTeamWorker, process.env);
	if (!resolved.ok || !resolved.stateRoot || !sameFilePath(resolved.stateRoot, stateDir)) {
		throw new Error("team_worker_state_authority_replaced");
	}
	const current = await resolveStateAuthorityForMutation({
		startup_cwd: process.env.OMX_STARTUP_CWD?.trim() || cwd,
		observed_cwd: cwd,
		session_id: process.env.OMX_SESSION_ID?.trim() || undefined,
	});
	if (!sameFilePath(current.canonical_state_root, authority.canonical_state_root)
		|| JSON.stringify(current.generation.root_identity) !== JSON.stringify(authority.generation.root_identity)
		|| !current.session_binding
		|| current.session_binding.canonical_session_id !== authority.session_binding?.canonical_session_id) {
		throw new Error("team_worker_mutation_authority_stale");
	}
	const teamDir = join(stateDir, "team", parsedTeamWorker.teamName);
	const [identity, config, manifest] = await Promise.all([
		readWorkerAuthorityJson(join(teamDir, "workers", parsedTeamWorker.workerName, "identity.json"), current, null),
		readWorkerAuthorityJson(join(teamDir, "config.json"), current, null),
		readWorkerAuthorityJson(join(teamDir, "manifest.v2.json"), current, null),
	]);
	const sessionId = current.session_binding.canonical_session_id;
	const workerListed = (document) => Array.isArray(document?.workers)
		&& document.workers.some((worker) => worker?.name === parsedTeamWorker.workerName);
	const identityWorktree = safeString(identity?.worktree_path).trim();
	const identityStateRoot = safeString(identity?.team_state_root).trim();
	if (!identity || !identityWorktree || !sameFilePath(identityWorktree, cwd)
		|| !identityStateRoot || !sameFilePath(identityStateRoot, stateDir)
		|| safeString(identity.session_id || identity.owner_session_id) !== sessionId
		|| (requireTeamDocuments && (!config || safeString(config.session_id || config.owner_session_id) !== sessionId || !workerListed(config)))
		|| (requireTeamDocuments && (!manifest || safeString(manifest.session_id || manifest.owner_session_id) !== sessionId || !workerListed(manifest)))) {
		throw new Error("team_worker_metadata_changed");
	}
}

async function writeWorkerAuthorityJson(path, value, authority) {
	await ensureAuthorityDirectory(authority.canonical_state_root, join(path, ".."), {
		expected_root_identity: authority.generation.root_identity,
	});
	await atomicWriteAuthorityFile(path, JSON.stringify(value, null, 2), {
		authority_root: authority.canonical_state_root,
		expected_root_identity: authority.generation.root_identity,
	});
}

async function readWorkerAuthorityFile(path, authority) {
	return readAuthorityFileWithExpectedRoot(path, {
		authority_root: authority.canonical_state_root,
		expected_root_identity: authority.generation.root_identity,
	});
}

async function readWorkerAuthorityJson(path, authority, fallback = null) {
	const raw = await readWorkerAuthorityFile(path, authority);
	if (raw === null) return fallback;
	try {
		return JSON.parse(raw);
	} catch {
		return fallback;
	}
}

async function appendWorkerAuthorityEvent(path, event, authority) {
	await ensureAuthorityDirectory(authority.canonical_state_root, join(path, ".."), {
		expected_root_identity: authority.generation.root_identity,
	});
	const existing = await readWorkerAuthorityFile(path, authority) ?? "";
	await atomicWriteAuthorityFile(path, `${existing}${JSON.stringify(event)}\n`, {
		authority_root: authority.canonical_state_root,
		expected_root_identity: authority.generation.root_identity,
	});
}

export function parseTeamWorkerEnv(rawValue) {
	if (typeof rawValue !== "string") return null;
	const match = /^([a-z0-9][a-z0-9-]{0,29})\/(worker-\d+)$/.exec(
		rawValue.trim(),
	);
	if (!match) return null;
	return { teamName: match[1], workerName: match[2] };
}

export function resolveWorkerIdleNotifyEnabled() {
	const raw = safeString(process.env.OMX_TEAM_WORKER_IDLE_NOTIFY || "")
		.trim()
		.toLowerCase();
	// Default: enabled. Disable with "false", "0", or "off".
	if (raw === "false" || raw === "0" || raw === "off") return false;
	return true;
}

export function resolveWorkerIdleCooldownMs() {
	const raw = safeString(process.env.OMX_TEAM_WORKER_IDLE_COOLDOWN_MS || "");
	const parsed = asNumber(raw);
	// Default: 30 seconds. Guard against unreasonable values.
	if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000)
		return parsed;
	return 30_000;
}

export function resolveAllWorkersIdleCooldownMs() {
	const raw = safeString(process.env.OMX_TEAM_ALL_IDLE_COOLDOWN_MS || "");
	const parsed = asNumber(raw);
	// Default: 60 seconds. Guard against unreasonable values.
	if (parsed !== null && parsed >= 5_000 && parsed <= 10 * 60_000)
		return parsed;
	return 60_000;
}

export function resolveStatusStaleMs() {
	const raw = safeString(process.env.OMX_TEAM_STATUS_STALE_MS || "");
	const parsed = asNumber(raw);
	if (parsed !== null && parsed >= 5_000 && parsed <= 60 * 60_000)
		return parsed;
	return 120_000;
}

export function resolveHeartbeatStaleMs() {
	const raw = safeString(process.env.OMX_TEAM_HEARTBEAT_STALE_MS || "");
	const parsed = asNumber(raw);
	if (parsed !== null && parsed >= 5_000 && parsed <= 60 * 60_000)
		return parsed;
	return 180_000;
}

function parseIsoMs(value) {
	const normalized = safeString(value).trim();
	if (!normalized) return null;
	const ms = Date.parse(normalized);
	if (!Number.isFinite(ms)) return null;
	return ms;
}

function isFreshIso(value, maxAgeMs, nowMs) {
	const ts = parseIsoMs(value);
	if (!Number.isFinite(ts)) return false;
	return nowMs - ts <= maxAgeMs;
}

function resolveTerminalAtFromPhaseDoc(parsed, fallbackIso) {
	const transitions = Array.isArray(parsed && parsed.transitions)
		? parsed.transitions
		: [];
	for (let idx = transitions.length - 1; idx >= 0; idx -= 1) {
		const at = safeString(transitions[idx] && transitions[idx].at).trim();
		if (at) return at;
	}
	const updatedAt = safeString(parsed && parsed.updated_at).trim();
	return updatedAt || fallbackIso;
}

async function readTeamPhaseSnapshot(
	stateDir,
	teamName,
	authority,
	nowIso = new Date().toISOString(),
) {
	const phasePath = join(stateDir, "team", teamName, "phase.json");
	const parsed = await readWorkerAuthorityJson(phasePath, authority, null);
	const currentPhase = safeString(parsed && parsed.current_phase).trim();
	return {
		currentPhase,
		terminal: isTerminalPhase(currentPhase),
		completedAt: resolveTerminalAtFromPhaseDoc(parsed, nowIso),
	};
}

async function syncScopedTeamStateFromPhase(
	stateDir,
	teamName,
	phaseSnapshot,
	authority,
	nowIso = new Date().toISOString(),
) {
	if (!phaseSnapshot || !phaseSnapshot.terminal) return false;
	const teamStatePath = join(stateDir, "team-state.json");
	const parsed = await readWorkerAuthorityJson(teamStatePath, authority, null);
	if (!parsed || safeString(parsed.team_name).trim() !== teamName) return false;

	let changed = false;
	if (parsed.active !== false) {
		parsed.active = false;
		changed = true;
	}
	if (safeString(parsed.current_phase).trim() !== phaseSnapshot.currentPhase) {
		parsed.current_phase = phaseSnapshot.currentPhase;
		changed = true;
	}
	if (safeString(parsed.completed_at).trim() !== phaseSnapshot.completedAt && phaseSnapshot.completedAt) {
		parsed.completed_at = phaseSnapshot.completedAt;
		changed = true;
	}
	if (safeString(parsed.last_turn_at).trim() !== nowIso) {
		parsed.last_turn_at = nowIso;
		changed = true;
	}
	if (changed) await writeWorkerAuthorityJson(teamStatePath, parsed, authority);
	return changed;
}

async function readWorkerStatusSnapshot(
	stateDir,
	teamName,
	workerName,
	authority,
	nowMs = Date.now(),
) {
	const statusPath = join(stateDir, "team", teamName, "workers", workerName, "status.json");
	const parsed = await readWorkerAuthorityJson(statusPath, authority, null);
	const state = parsed && typeof parsed.state === "string" ? parsed.state : "unknown";
	const updatedAt = parsed && typeof parsed.updated_at === "string" ? parsed.updated_at : null;
	return {
		state,
		updated_at: updatedAt,
		fresh: Boolean(updatedAt) && isFreshIso(updatedAt, resolveStatusStaleMs(), nowMs),
	};
}

export async function readWorkerHeartbeatSnapshot(
	stateDir,
	teamName,
	workerName,
	expectedSessionId,
	authority,
	nowMs = Date.now(),
) {
	const heartbeatPath = join(stateDir, "team", teamName, "workers", workerName, "heartbeat.json");
	const raw = await readWorkerAuthorityFile(heartbeatPath, authority);
	if (raw === null) return { last_turn_at: null, fresh: false, missing: true };
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { last_turn_at: null, fresh: false, missing: false };
	}
	const lastTurnAt = typeof parsed?.last_turn_at === "string" ? parsed.last_turn_at : null;
	const sessionMatches = !expectedSessionId || safeString(parsed?.session_id).trim() === expectedSessionId;
	return {
		last_turn_at: lastTurnAt,
		fresh: sessionMatches && isFreshIso(lastTurnAt, resolveHeartbeatStaleMs(), nowMs),
		missing: false,
	};
}

export async function readWorkerStatusState(stateDir, teamName, workerName) {
	if (!workerName) return "unknown";
	const statusPath = join(
		stateDir,
		"team",
		teamName,
		"workers",
		workerName,
		"status.json",
	);
	try {
		if (!existsSync(statusPath)) return "unknown";
		const raw = await readFile(statusPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed.state === "string") return parsed.state;
		return "unknown";
	} catch {
		return "unknown";
	}
}

export async function readTeamWorkersForIdleCheck(stateDir, teamName, authority) {
	// Try manifest.v2.json first (preferred), then config.json. Some older or
	// synthetic team states have a partial manifest plus the usable worker pane
	// metadata in config.json, so fall through when a candidate is incomplete.
	const manifestPath = join(stateDir, "team", teamName, "manifest.v2.json");
	const configPath = join(stateDir, "team", teamName, "config.json");
	const candidatePaths = [manifestPath, configPath];
	let fallback = null;

	for (const srcPath of candidatePaths) {
		try {
			const raw = authority
				? await readWorkerAuthorityFile(srcPath, authority)
				: await readFile(srcPath, "utf-8");
			if (raw === null) continue;
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") continue;
			const workers = parsed.workers;
			if (!Array.isArray(workers) || workers.length === 0) continue;
			const tmuxSession = safeString(parsed.tmux_session || "").trim();
			const leaderPaneId = safeString(parsed.leader_pane_id || "").trim();
			const result = { workers, tmuxSession, leaderPaneId };
			if (leaderPaneId) return result;
			if (!fallback) fallback = result;
		} catch {
			// Try the next state source.
		}
	}

	return fallback;
}

async function readLeaderPaneProcessIdentity(paneTarget) {
	try {
		const result = await runProcess(
			"tmux",
			["display-message", "-p", "-t", paneTarget, "#{session_name}\t#{pane_id}\t#{pane_pid}"],
			3000,
		);
		const [sessionName = "", paneId = "", processId = ""] = safeString(result.stdout).trim().split("\t");
		if (!sessionName || !paneId || !processId) return null;
		return { sessionName, paneId, processId };
	} catch {
		return null;
	}
}

export async function readAuthorizedLeaderPaneTarget(stateDir, teamName, authority) {
	const teamDir = join(stateDir, "team", teamName);
	const [config, manifest] = authority
		? await Promise.all([
			readWorkerAuthorityJson(join(teamDir, "config.json"), authority, null),
			readWorkerAuthorityJson(join(teamDir, "manifest.v2.json"), authority, null),
		])
		: await Promise.all([
			readJsonIfExists(join(teamDir, "config.json"), null),
			readJsonIfExists(join(teamDir, "manifest.v2.json"), null),
		]);
	const targetFor = (document) => ({
		tmuxSession: safeString(document?.tmux_session).trim(),
		leaderPaneId: safeString(document?.leader_pane_id).trim(),
	});
	if (!config || !manifest) return null;
	const configTarget = targetFor(config);
	const manifestTarget = targetFor(manifest);
	if (configTarget.tmuxSession !== manifestTarget.tmuxSession
		|| configTarget.leaderPaneId !== manifestTarget.leaderPaneId) return null;
	const paneTarget = configTarget.leaderPaneId
		? await resolveCanonicalLeaderPaneId(configTarget.tmuxSession, configTarget.leaderPaneId)
		: "";
	if (configTarget.leaderPaneId && !paneTarget) return null;
	const paneIdentity = paneTarget ? await readLeaderPaneProcessIdentity(paneTarget) : null;
	if (paneTarget && !paneIdentity) return null;
	if (paneIdentity && paneIdentity.paneId !== paneTarget) return null;
	const configuredSessionName = configTarget.tmuxSession.split(":", 1)[0];
	if (!process.env.OMX_TEST_TMUX_BIN && paneIdentity && configuredSessionName && paneIdentity.sessionName !== configuredSessionName) return null;
	return Object.freeze({
		...configTarget,
		paneTarget,
		paneIdentity: paneIdentity ? Object.freeze({ ...paneIdentity }) : null,
		documentTarget: Object.freeze({ ...configTarget }),
	});
}

async function assertAuthorizedLeaderPaneTarget(stateDir, teamName, expectedTarget, authority) {
	const currentTarget = await readAuthorizedLeaderPaneTarget(stateDir, teamName, authority);
	if (!currentTarget
		|| currentTarget.tmuxSession !== expectedTarget.tmuxSession
		|| currentTarget.leaderPaneId !== expectedTarget.leaderPaneId
		|| currentTarget.paneTarget !== expectedTarget.paneTarget
		|| JSON.stringify(currentTarget.paneIdentity) !== JSON.stringify(expectedTarget.paneIdentity)
		|| JSON.stringify(currentTarget.documentTarget) !== JSON.stringify(expectedTarget.documentTarget)) {
		throw new Error("leader_pane_target_changed");
	}
	return currentTarget.paneTarget;
}

async function readTeamTaskCounts(stateDir, teamName) {
	const tasksDir = join(stateDir, "team", teamName, "tasks");
	const taskCounts = {
		pending: 0,
		blocked: 0,
		in_progress: 0,
		completed: 0,
		failed: 0,
	};
	if (!existsSync(tasksDir)) return taskCounts;

	try {
		const taskFiles = (await readdir(tasksDir))
			.filter((entry) => /^task-\d+\.json$/.test(entry))
			.sort();
		for (const entry of taskFiles) {
			try {
				const parsed = JSON.parse(
					await readFile(join(tasksDir, entry), "utf-8"),
				);
				const status =
					safeString(parsed?.status || "pending").trim() || "pending";
				if (Object.hasOwn(taskCounts, status)) taskCounts[status] += 1;
			} catch {
				// ignore malformed task files
			}
		}
	} catch {
		return taskCounts;
	}

	return taskCounts;
}

async function resolveCanonicalLeaderPaneId(_tmuxSession, leaderPaneId) {
	const normalizedLeaderPaneId = safeString(leaderPaneId).trim();
	if (/^%\d+$/.test(normalizedLeaderPaneId)) return normalizedLeaderPaneId;
	if (normalizedLeaderPaneId) {
		try {
			const resolved = await resolvePaneTarget(
				{ type: "pane", value: normalizedLeaderPaneId },
				"",
				"",
				"",
				{},
			);
			const paneTarget = safeString(resolved?.paneTarget).trim();
			if (paneTarget) return paneTarget;
		} catch {
			// fall through to tmux session scan
		}
		return normalizedLeaderPaneId;
	}
	return "";
}

async function checkLeaderPaneReadyForWorkerStateReminder(paneTarget) {
	return evaluatePaneInjectionReadiness(paneTarget, {
		skipIfScrolling: true,
		// Worker-state reminders are their own trigger path. They should still
		// queue into a live Codex pane even while the leader is busy or not
		// visibly input-ready; only shell/copy-mode style safety guards remain.
		requireRunningAgent: true,
		requireReady: false,
		requireIdle: false,
	});
}

async function emitLeaderPaneMissingDeferred({
	stateDir,
	logsDir,
	teamName,
	workerName,
	tmuxSession,
	leaderPaneId,
	reason = "leader_pane_missing_no_injection",
	paneCurrentCommand = "",
	sourceType = "unknown",
	authority,
	orchestrationIntent = "",
}) {
	const nowIso = new Date().toISOString();
	await logTmuxHookEvent(logsDir, {
		timestamp: nowIso,
		type: "leader_notification_deferred",
		team: teamName,
		worker: workerName,
		to_worker: "leader-fixed",
		reason,
		leader_pane_id: leaderPaneId || null,
		tmux_session: tmuxSession || null,
		orchestration_intent: orchestrationIntent || null,
		tmux_injection_attempted: false,
		pane_current_command: paneCurrentCommand || null,
		source_type: sourceType,
	}).catch(() => {});

	const eventsDir = join(stateDir, "team", teamName, "events");
	const eventsPath = join(eventsDir, "events.ndjson");
	const event = {
		event_id: `leader-deferred-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
		team: teamName,
		type: "leader_notification_deferred",
		worker: workerName,
		to_worker: "leader-fixed",
		reason,
		created_at: nowIso,
		leader_pane_id: leaderPaneId || null,
		tmux_session: tmuxSession || null,
		orchestration_intent: orchestrationIntent || null,
		tmux_injection_attempted: false,
		pane_current_command: paneCurrentCommand || null,
		source_type: sourceType,
	};
	await appendWorkerAuthorityEvent(eventsPath, event, authority);
}

export async function updateWorkerHeartbeat(stateDir, teamName, workerName, authority: ResolvedStateAuthorityContext) {
	const heartbeatPath = join(
		stateDir,
		"team",
		teamName,
		"workers",
		workerName,
		"heartbeat.json",
	);
	const existing = await readWorkerAuthorityJson(heartbeatPath, authority, {});
	const turnCount = asNumber(existing?.turn_count) ?? 0;
	const heartbeat = {
		pid: process.ppid || process.pid,
		last_turn_at: new Date().toISOString(),
		turn_count: turnCount + 1,
		alive: true,
		session_id: authority.session_binding?.canonical_session_id || "",
	};
	await writeWorkerAuthorityJson(heartbeatPath, heartbeat, authority);
}

export async function maybeNotifyLeaderAllWorkersIdle({
	cwd,
	stateDir,
	logsDir,
	parsedTeamWorker,
	authority,
}) {
	const { teamName, workerName } = parsedTeamWorker;
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
	const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, authority, nowIso);
	if (phaseSnapshot.terminal) {
		await syncScopedTeamStateFromPhase(
			stateDir,
			teamName,
			phaseSnapshot,
			authority,
			nowIso,
		);
		return;
	}

	// Only trigger check when this worker is idle
	const mySnapshot = await readWorkerStatusSnapshot(
		stateDir,
		teamName,
		workerName,
		authority,
		nowMs,
	);
	if (mySnapshot.state !== "idle" || !mySnapshot.fresh) return;
	const myHeartbeat = await readWorkerHeartbeatSnapshot(
		stateDir,
		teamName,
		workerName,
		authority.session_binding?.canonical_session_id,
		authority,
		nowMs,
	);
	if (!myHeartbeat.fresh) return;

	// Read the worker list and a leader target jointly authorized by current config and manifest.
	const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName, authority);
	if (!teamInfo) return;
	const { workers } = teamInfo;
	const authorizedLeaderTarget = await readAuthorizedLeaderPaneTarget(stateDir, teamName, authority);
	if (!authorizedLeaderTarget) return;
	const { tmuxSession, leaderPaneId, paneTarget: tmuxTarget } = authorizedLeaderTarget;

	// Check cooldown to prevent notification spam
	const idleStatePath = join(
		stateDir,
		"team",
		teamName,
		"all-workers-idle.json",
	);
	const idleState = (await readWorkerAuthorityJson(idleStatePath, authority, null)) || {};
	const cooldownMs = resolveAllWorkersIdleCooldownMs();
	const lastNotifiedMs = asNumber(idleState.last_notified_at_ms) ?? 0;
	if (nowMs - lastNotifiedMs < cooldownMs) return;

	// Check if ALL workers are idle (or done)
	const snapshots = await Promise.all(
		workers.map(async (w) => {
			const worker = safeString(w && w.name ? w.name : "");
			const status = await readWorkerStatusSnapshot(
				stateDir,
				teamName,
				worker,
				authority,
				nowMs,
			);
			const heartbeat = await readWorkerHeartbeatSnapshot(
				stateDir,
				teamName,
				worker,
				authority.session_binding?.canonical_session_id,
				authority,
				nowMs,
			);
			return { worker, status, heartbeat };
		}),
	);
	const allIdle =
		snapshots.length > 0 &&
		snapshots.every(
			({ status, heartbeat }) =>
				(status.state === "idle" || status.state === "done") &&
				status.fresh &&
				heartbeat.fresh,
		);
	if (!allIdle) return;

	const taskCounts = await readTeamTaskCounts(stateDir, teamName);
	const leaderActionState = classifyLeaderActionState({
		allWorkersIdle: allIdle,
		workerPanesAlive: snapshots.length > 0,
		taskCounts,
	});
	const orchestrationIntent = resolveAllWorkersIdleIntent(leaderActionState);

	const N = workers.length;
	const nextAction = `Run \`omx team status ${teamName}\` now, read unread worker messages, then assign the next concrete task, reconcile results, or shut the team down.`;
	const message = `[OMX] All ${N} worker${N === 1 ? "" : "s"} idle. ${nextAction} ${DEFAULT_MARKER}`;
	const paneGuard = tmuxTarget
		? await checkLeaderPaneReadyForWorkerStateReminder(tmuxTarget)
		: { ok: false, reason: "leader_pane_missing", paneCurrentCommand: "", sourceType: "missing" };
	if (!paneGuard.ok) {
		const nextIdleState = {
			...idleState,
			last_notified_at_ms: nowMs,
			last_notified_at: nowIso,
			worker_count: N,
			orchestration_intent: orchestrationIntent,
			delivery: paneGuard.reason === "leader_pane_missing" ? "deferred" : "deferred_shell",
			pane_current_command: paneGuard.paneCurrentCommand || null,
		};
		await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
		await writeWorkerAuthorityJson(idleStatePath, nextIdleState, authority);
		await emitLeaderPaneMissingDeferred({
			stateDir,
			logsDir,
			teamName,
			workerName,
			reason: paneGuard.reason === "leader_pane_missing" ? "leader_pane_missing_no_injection" : LEADER_PANE_SHELL_NO_INJECTION_REASON,
			paneCurrentCommand: paneGuard.paneCurrentCommand,
			sourceType: "all_workers_idle",
			tmuxSession,
			leaderPaneId: leaderPaneId,
			authority,
			orchestrationIntent,
		});
		return;
	}

	try {
		await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
		const finalTmuxTarget = await assertAuthorizedLeaderPaneTarget(
			stateDir,
			teamName,
			authorizedLeaderTarget,
			authority,
		);
		const sendResult = await sendPaneInput({
			paneTarget: finalTmuxTarget,
			prompt: message,
			submitKeyPresses: 2,
			submitDelayMs: 100,
			validateBeforeEffect: async () => {
				await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
				await assertAuthorizedLeaderPaneTarget(stateDir, teamName, authorizedLeaderTarget, authority);
			},
		});
		if (!sendResult.ok)
			throw new Error(sendResult.error || sendResult.reason || "send_failed");

		const nextIdleState = {
			...idleState,
			last_notified_at_ms: nowMs,
			last_notified_at: nowIso,
			worker_count: N,
			orchestration_intent: orchestrationIntent,
		};
		await writeWorkerAuthorityJson(idleStatePath, nextIdleState, authority);

		const eventsDir = join(stateDir, "team", teamName, "events");
		const eventsPath = join(eventsDir, "events.ndjson");
		const event = {
			event_id: `all-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			team: teamName,
			type: "all_workers_idle",
			worker: workerName,
			worker_count: N,
			orchestration_intent: orchestrationIntent,
			created_at: nowIso,
		};
		await appendWorkerAuthorityEvent(eventsPath, event, authority);

		await logTmuxHookEvent(logsDir, {
			timestamp: nowIso,
			type: "all_workers_idle_notification",
			team: teamName,
			tmux_target: tmuxTarget,
			worker: workerName,
			worker_count: N,
			orchestration_intent: orchestrationIntent,
		});
	} catch (err) {
		await logTmuxHookEvent(logsDir, {
			timestamp: nowIso,
			type: "all_workers_idle_notification",
			team: teamName,
			tmux_target: tmuxTarget,
			worker: workerName,
			orchestration_intent: orchestrationIntent,
			error: err instanceof Error ? err.message : safeString(err),
		}).catch(() => {});
	}
}

export async function maybeNotifyLeaderWorkerIdle({
	cwd,
	stateDir,
	logsDir,
	parsedTeamWorker,
	authority,
}) {
	if (!resolveWorkerIdleNotifyEnabled()) return;

	const { teamName, workerName } = parsedTeamWorker;
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
	const phaseSnapshot = await readTeamPhaseSnapshot(stateDir, teamName, authority, nowIso);
	if (phaseSnapshot.terminal) {
		await syncScopedTeamStateFromPhase(
			stateDir,
			teamName,
			phaseSnapshot,
			authority,
			nowIso,
		);
		return;
	}

	// Read current worker status (full object for task context)
	const workerDir = join(stateDir, "team", teamName, "workers", workerName);
	const statusPath = join(workerDir, "status.json");
	const status = await readWorkerAuthorityJson(statusPath, authority, null);
	const currentState = typeof status?.state === "string" ? status.state : "unknown";
	const currentTaskId = typeof status?.current_task_id === "string" ? status.current_task_id : "";
	const currentReason = typeof status?.reason === "string" ? status.reason : "";
	const statusUpdatedAt = typeof status?.updated_at === "string" ? status.updated_at : null;
	const statusFresh = Boolean(statusUpdatedAt) && isFreshIso(statusUpdatedAt, resolveStatusStaleMs(), nowMs);

	// Read and update previous state for transition detection
	const prevStatePath = join(workerDir, "prev-notify-state.json");
	const prev = await readWorkerAuthorityJson(prevStatePath, authority, null);
	const prevState = typeof prev?.state === "string" ? prev.state : "unknown";

	await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
	await writeWorkerAuthorityJson(
		prevStatePath,
		{ state: currentState, updated_at: nowIso },
		authority,
	);

	// Fire when a worker leaves active work into an idle-ish terminal state.
	if (currentState !== "idle" && currentState !== "done") return;
	if (!statusFresh) return;
	if (prevState === "idle" || prevState === "done") return;
	const orchestrationIntent = resolveWorkerIdleIntent(currentState);

	const heartbeat = await readWorkerHeartbeatSnapshot(
		stateDir,
		teamName,
		workerName,
		authority.session_binding?.canonical_session_id,
		authority,
		nowMs,
	);
	if (!heartbeat.fresh) return;

	// Check per-worker cooldown
	const cooldownPath = join(workerDir, "worker-idle-notify.json");
	const cooldownMs = resolveWorkerIdleCooldownMs();
	const cooldown = await readWorkerAuthorityJson(cooldownPath, authority, null);
	const lastNotifiedMs = asNumber(cooldown?.last_notified_at_ms) ?? 0;
	if (nowMs - lastNotifiedMs < cooldownMs) return;

	// Only inject into a leader target jointly authorized by current config and manifest.
	const teamInfo = await readTeamWorkersForIdleCheck(stateDir, teamName, authority);
	if (!teamInfo) return;
	const authorizedLeaderTarget = await readAuthorizedLeaderPaneTarget(stateDir, teamName, authority);
	if (!authorizedLeaderTarget) return;
	const { tmuxSession, leaderPaneId, paneTarget: tmuxTarget } = authorizedLeaderTarget;
	const paneGuard = tmuxTarget
		? await checkLeaderPaneReadyForWorkerStateReminder(tmuxTarget).catch(() => ({
			ok: false,
			reason: "session_check_failed",
			paneCurrentCommand: "",
		}))
		: { ok: false, reason: "leader_pane_missing", paneCurrentCommand: "", sourceType: "missing" };
	if (!paneGuard.ok) {
		await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
		await writeWorkerAuthorityJson(cooldownPath, {
			last_notified_at_ms: nowMs,
			last_notified_at: nowIso,
			prev_state: prevState,
			orchestration_intent: orchestrationIntent,
			delivery: paneGuard.reason === "leader_pane_missing" ? "deferred" : "deferred_shell",
			pane_current_command: paneGuard.paneCurrentCommand || null,
		}, authority);
		await emitLeaderPaneMissingDeferred({
			stateDir,
			logsDir,
			teamName,
			workerName,
			reason: paneGuard.reason === "leader_pane_missing" ? "leader_pane_missing_no_injection" : LEADER_PANE_SHELL_NO_INJECTION_REASON,
			paneCurrentCommand: paneGuard.paneCurrentCommand,
			authority,
			sourceType: "worker_idle",
			tmuxSession,
			leaderPaneId: leaderPaneId,
			orchestrationIntent,
		});
		return;
	}

	// Build notification message with context
	const parts = [`[OMX] ${workerName} ${currentState}`];
	if (prevState && prevState !== "unknown") parts.push(`(was: ${prevState})`);
	if (currentTaskId) parts.push(`task: ${currentTaskId}`);
	if (currentReason) parts.push(`reason: ${currentReason}`);
	parts.push(
		`Next: read ${workerName}'s latest message/output, then assign the next concrete step or mark the task complete.`,
	);
	const message = `${parts.join(". ")}. ${DEFAULT_MARKER}`;

	try {
		await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
		const finalTmuxTarget = await assertAuthorizedLeaderPaneTarget(
			stateDir,
			teamName,
			authorizedLeaderTarget,
			authority,
		);
		const sendResult = await sendPaneInput({
			paneTarget: finalTmuxTarget,
			prompt: message,
			submitKeyPresses: 2,
			submitDelayMs: 100,
			validateBeforeEffect: async () => {
				await assertWorkerNotificationAuthority({ cwd, stateDir, parsedTeamWorker, authority });
				await assertAuthorizedLeaderPaneTarget(stateDir, teamName, authorizedLeaderTarget, authority);
			},
		});
		if (!sendResult.ok)
			throw new Error(sendResult.error || sendResult.reason || "send_failed");

		await writeWorkerAuthorityJson(cooldownPath, {
			last_notified_at_ms: nowMs,
			last_notified_at: nowIso,
			prev_state: prevState,
			orchestration_intent: orchestrationIntent,
		}, authority);

		// Write event to events.ndjson
		const eventsDir = join(stateDir, "team", teamName, "events");
		const eventsPath = join(eventsDir, "events.ndjson");
		const event = {
			event_id: `worker-idle-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
			team: teamName,
			type: "worker_idle",
			worker: workerName,
			prev_state: prevState,
			task_id: currentTaskId || null,
			reason: currentReason || null,
			orchestration_intent: orchestrationIntent,
			created_at: nowIso,
		};
		await appendWorkerAuthorityEvent(eventsPath, event, authority);

		await logTmuxHookEvent(logsDir, {
			timestamp: nowIso,
			type: "worker_idle_notification",
			team: teamName,
			tmux_target: tmuxTarget,
			worker: workerName,
			prev_state: prevState,
			task_id: currentTaskId || null,
			orchestration_intent: orchestrationIntent,
		});
	} catch (err) {
		await logTmuxHookEvent(logsDir, {
			timestamp: nowIso,
			type: "worker_idle_notification",
			team: teamName,
			tmux_target: tmuxTarget,
			worker: workerName,
			orchestration_intent: orchestrationIntent,
			error: err instanceof Error ? err.message : safeString(err),
		}).catch(() => {});
	}
}
