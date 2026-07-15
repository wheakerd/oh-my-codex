import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getPackageRoot } from '../utils/package.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

import { resolveHudAuthorityReadScope } from "./state.js";
import {
	atomicWriteAuthorityJson,
	resolveStateAuthorityForGuard,
	validateStateAuthority,
	type RootFilesystemIdentity,
} from "../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../state/transport-env.js";export interface RunHudAuthorityTickOptions {
  cwd: string;
	/** Live pane cwd is diagnostic/read context only and never selects writes. */
	frameCwd?: string;
  nodePath?: string;
  packageRoot?: string;
  pollMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  minIntervalMs?: number;
  jitterMs?: number;
}

export interface RunHudAuthorityTickDeps {
  runProcess?: (
    nodePath: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      timeoutMs: number;
    },
  ) => Promise<void> | void;
  nowMs?: () => number;
  random?: () => number;
  onLockAcquired?: () => Promise<void> | void;
}

interface HudAuthorityState {
  owner: 'hud';
  pid: number;
  cwd: string;
  heartbeat_at: string;
  last_spawn_at?: string;
  last_skip_at?: string;
  next_allowed_at?: string;
  cooldown_ms: number;
  jitter_ms: number;
  skip_count: number;
  last_status: 'spawned' | 'skipped' | 'failed' | 'locked';
  last_reason: string;
  last_error?: string;
}

interface AuthorityLock {
  path: string;
  token: string;
}

class AuthorityStateReadError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(`failed to read HUD authority state: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function isDeletedCwdMarkerPath(path: string): boolean {
  const currentPath = path.trim();
  return /(?:^|\s)\(deleted\)\s*$/.test(currentPath) && !existsSync(currentPath);
}

async function defaultRunProcess(
  nodePath: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<void> {
  const result = spawnSync(nodePath, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.error?.message, result.stderr, result.stdout]
      .map((value) => value?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();
    const suffix = result.signal
      ? `signal ${result.signal}`
      : `status ${result.status ?? 'unknown'}`;
    throw new Error(output ? `hud authority tick failed with ${suffix}: ${output}` : `hud authority tick failed with ${suffix}`);
  }
  if (result.error) {
    throw new Error(`hud authority tick failed: ${result.error.message}`);
	}
}

function asPositiveNumber(
	value: string | number | undefined,
	fallback: number,
): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function asNonNegativeNumber(
	value: string | number | undefined,
	fallback: number,
): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIsoMs(value: unknown): number | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	);
}

function resolveHudWatcherScript(
	packageRoot: string,
	scriptName: "notify-fallback-watcher.js" | "notify-hook.js",
	cwd: string,
	env: NodeJS.ProcessEnv,
): string {
	const packageScript = join(packageRoot, "dist", "scripts", scriptName);
	if (existsSync(packageScript)) return packageScript;

	const entryPath = resolveOmxCliEntryPath({ cwd, env });
	if (entryPath && entryPath.endsWith("/dist/cli/omx.js")) {
		const entryRoot = dirname(dirname(dirname(entryPath)));
		const entryScript = join(entryRoot, "dist", "scripts", scriptName);
		if (existsSync(entryScript)) return entryScript;
	}

	return packageScript;
}

function isAuthorityStatus(
	value: unknown,
): value is HudAuthorityState["last_status"] {
	return (
		value === "spawned" ||
		value === "skipped" ||
		value === "failed" ||
		value === "locked"
	);
}

function validateAuthorityState(value: unknown): HudAuthorityState {
	if (typeof value !== "object" || value === null) {
		throw new Error("authority state must be an object");
	}
	const state = value as Partial<HudAuthorityState>;
	if (state.owner !== "hud")
		throw new Error("authority state owner must be hud");
	if (
		typeof state.pid !== "number" ||
		!Number.isInteger(state.pid) ||
		state.pid <= 0
	) {
		throw new Error("authority state pid must be a positive integer");
	}
	if (typeof state.cwd !== "string" || !state.cwd)
		throw new Error("authority state cwd must be a non-empty string");
	if (parseIsoMs(state.heartbeat_at) === null)
		throw new Error(
			"authority state heartbeat_at must be a valid ISO timestamp",
		);
	if (parseIsoMs(state.next_allowed_at) === null)
		throw new Error(
			"authority state next_allowed_at must be a valid ISO timestamp",
		);
	if (
		typeof state.cooldown_ms !== "number" ||
		!Number.isFinite(state.cooldown_ms) ||
		state.cooldown_ms < 0
	) {
		throw new Error(
			"authority state cooldown_ms must be a non-negative number",
		);
	}
	if (
		typeof state.jitter_ms !== "number" ||
		!Number.isFinite(state.jitter_ms) ||
		state.jitter_ms < 0
	) {
		throw new Error("authority state jitter_ms must be a non-negative number");
	}
	if (
		typeof state.skip_count !== "number" ||
		!Number.isInteger(state.skip_count) ||
		state.skip_count < 0
	) {
		throw new Error(
			"authority state skip_count must be a non-negative integer",
		);
	}
	if (!isAuthorityStatus(state.last_status))
		throw new Error("authority state last_status is invalid");
	if (typeof state.last_reason !== "string" || !state.last_reason) {
		throw new Error("authority state last_reason must be a non-empty string");
	}
	return state as HudAuthorityState;
}

async function readAuthorityState(
	path: string,
): Promise<HudAuthorityState | null> {
	try {
		return validateAuthorityState(JSON.parse(await readFile(path, "utf-8")));
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new AuthorityStateReadError(path, error);
	}
}

async function writeAuthorityState(
	path: string,
	state: HudAuthorityState,
	authorityRoot: string,
	rootIdentity: RootFilesystemIdentity,
): Promise<boolean> {
	try {
		await atomicWriteAuthorityJson(path, state, {
			authority_root: authorityRoot,
			expected_root_identity: rootIdentity,
		});
		return true;
	} catch {
		return false;
	}
}

async function writeAuthorityStateUnlessNewerCooldown(
	path: string,
	state: HudAuthorityState,
	authorityRoot: string,
	rootIdentity: RootFilesystemIdentity,
): Promise<boolean> {
	const currentState = await readAuthorityState(path).catch(() => null);
	const currentNextAllowedMs = parseIsoMs(currentState?.next_allowed_at);
	const candidateNextAllowedMs = parseIsoMs(state.next_allowed_at);
	if (
		currentNextAllowedMs !== null &&
		candidateNextAllowedMs !== null &&
		currentNextAllowedMs > candidateNextAllowedMs
	) {
		return true;
	}
	return writeAuthorityState(path, state, authorityRoot, rootIdentity);
}

async function tryCreateAuthorityLock(
	lockPath: string,
	nowMs: number,
): Promise<AuthorityLock | null> {
	const token = randomUUID();
	let createdDir = false;
	try {
		await mkdir(lockPath, { recursive: false });
		createdDir = true;
		await writeFile(
			join(lockPath, "owner.json"),
			JSON.stringify(
				{
					token,
					pid: process.pid,
					acquired_at: new Date(nowMs).toISOString(),
				},
				null,
				2,
			),
		);
		return { path: lockPath, token };
	} catch {
		if (createdDir)
			await rm(lockPath, { recursive: true, force: true }).catch(() => {});
		return null;
	}
}

async function readAuthorityLockOwner(
	lockPath: string,
): Promise<{ token?: unknown } | null> {
	return readFile(join(lockPath, "owner.json"), "utf-8")
		.then((content) => JSON.parse(content) as { token?: unknown })
		.catch(() => null);
}

async function restoreMovedLock(
	fromPath: string,
	toPath: string,
): Promise<void> {
	const restored = await rename(fromPath, toPath)
		.then(() => true)
		.catch(() => false);
	if (!restored)
		await rm(fromPath, { recursive: true, force: true }).catch(() => {});
}

async function acquireAuthorityLock(
	lockPath: string,
	staleMs: number,
	nowMs: number,
): Promise<AuthorityLock | null> {
	const created = await tryCreateAuthorityLock(lockPath, nowMs);
	if (created) return created;

	const observedOwner = await readAuthorityLockOwner(lockPath);
	const lockStat = await stat(lockPath).catch(() => null);
	if (!lockStat || nowMs - lockStat.mtimeMs <= staleMs) return null;

	const reapPath = `${lockPath}.stale.${process.pid}.${nowMs}.${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch {
    return null;
  }

  const reapedOwner = await readAuthorityLockOwner(reapPath);
  const reapedStat = await stat(reapPath).catch(() => null);
  const reapedObservedLock = observedOwner?.token === reapedOwner?.token
    && reapedStat?.mtimeMs === lockStat.mtimeMs
    && nowMs - reapedStat.mtimeMs > staleMs;

  if (!reapedObservedLock) {
    await restoreMovedLock(reapPath, lockPath);
    return null;
  }

  await rm(reapPath, { recursive: true, force: true }).catch(() => {});
  return tryCreateAuthorityLock(lockPath, nowMs);
}

async function releaseAuthorityLock(lock: AuthorityLock): Promise<void> {
  const releasePath = `${lock.path}.release.${process.pid}.${Date.now()}.${lock.token}`;
	try {
		await rename(lock.path, releasePath);
	} catch {
		return;
	}

	const releaseOwner = await readAuthorityLockOwner(releasePath);
	if (releaseOwner?.token === lock.token) {
		await rm(releasePath, { recursive: true, force: true }).catch(() => {});
		return;
	}

	await restoreMovedLock(releasePath, lock.path);
}

function buildAuthorityState(
	cwd: string,
	nowMs: number,
	cooldownMs: number,
	jitterMs: number,
	overrides: Partial<HudAuthorityState>,
): HudAuthorityState {
	return {
		owner: "hud",
		pid: process.pid,
		cwd,
		heartbeat_at: new Date(nowMs).toISOString(),
		cooldown_ms: cooldownMs,
		jitter_ms: jitterMs,
		skip_count: 0,
		last_status: "spawned",
		last_reason: "spawned",
		...overrides,
	};
}

async function writeRateLimitSkipState(
	path: string,
	ownerPath: string,
	cwd: string,
	nowMs: number,
	cooldownMs: number,
	fallbackJitterMs: number,
	previousState: HudAuthorityState,
	reason: "rate_limited" | "rate_limited_after_lock",
	authorityRoot: string,
	rootIdentity: RootFilesystemIdentity,
): Promise<void> {
	const skippedState = buildAuthorityState(
		cwd,
		nowMs,
		cooldownMs,
		previousState.jitter_ms ?? fallbackJitterMs,
		{
			last_spawn_at: previousState.last_spawn_at,
			last_skip_at: new Date(nowMs).toISOString(),
			next_allowed_at: previousState.next_allowed_at,
			skip_count: (previousState.skip_count ?? 0) + 1,
			last_status: "skipped",
			last_reason: reason,
			last_error: previousState.last_error,
		},
	);
	await writeAuthorityState(
		ownerPath,
		skippedState,
		authorityRoot,
		rootIdentity,
	);
	await writeAuthorityStateUnlessNewerCooldown(
		path,
		skippedState,
		authorityRoot,
		rootIdentity,
	);
}

async function writeInvalidStateDiagnostic(
	path: string,
	ownerPath: string,
	cwd: string,
	nowMs: number,
	cooldownMs: number,
	jitterMs: number,
	error: unknown,
	authorityRoot: string,
	rootIdentity: RootFilesystemIdentity,
): Promise<boolean> {
	const failedState = buildAuthorityState(cwd, nowMs, cooldownMs, jitterMs, {
		last_skip_at: new Date(nowMs).toISOString(),
		next_allowed_at: new Date(nowMs + cooldownMs + jitterMs).toISOString(),
		last_status: "failed",
		last_reason: "invalid_authority_state",
		last_error: error instanceof Error ? error.message : String(error),
	});
	const ownerWritten = await writeAuthorityState(
		ownerPath,
		failedState,
		authorityRoot,
		rootIdentity,
	);
	const stateWritten = await writeAuthorityState(
		path,
		failedState,
		authorityRoot,
		rootIdentity,
	);
	return ownerWritten || stateWritten;
}

export async function runHudAuthorityTick(
	options: RunHudAuthorityTickOptions,
	deps: RunHudAuthorityTickDeps = {},
): Promise<void> {
	const authorityCwd = options.cwd;
	const frameCwd = options.frameCwd ?? authorityCwd;
	if (isDeletedCwdMarkerPath(authorityCwd) || isDeletedCwdMarkerPath(frameCwd))
		return;
	const nodePath = options.nodePath ?? process.execPath;
	const packageRoot = options.packageRoot ?? getPackageRoot();
	const pollMs = Math.max(1, options.pollMs ?? 75);
	const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
	const minIntervalMs = Math.max(
		250,
		asPositiveNumber(
			options.minIntervalMs ??
				options.env?.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS ??
				process.env.OMX_HUD_AUTHORITY_MIN_INTERVAL_MS,
			5_000,
		),
	);
	const jitterMaxMs = Math.max(
		0,
		asNonNegativeNumber(
			options.jitterMs ??
				options.env?.OMX_HUD_AUTHORITY_JITTER_MS ??
				process.env.OMX_HUD_AUTHORITY_JITTER_MS,
			250,
		),
	);
	const nowMs = deps.nowMs?.() ?? Date.now();
	const random = deps.random ?? Math.random;
	const jitterMs =
		jitterMaxMs > 0 ? Math.floor(random() * (jitterMaxMs + 1)) : 0;
	const mergedEnv = { ...process.env, ...options.env };
	const authority = await resolveStateAuthorityForGuard({
		startup_cwd: authorityCwd,
		observed_cwd: frameCwd,
		session_id: mergedEnv.OMX_SESSION_ID?.trim() || undefined,
	});
	const readScope = await resolveHudAuthorityReadScope(
		frameCwd,
		authority,
		mergedEnv,
	);
	if (
		!readScope.context ||
		readScope.stateRoot !== authority.canonical_state_root ||
		readScope.diagnostics.some((diagnostic) => diagnostic.fatal)
	) {
		return;
	}
	const childEnv = buildStateAuthorityTransportEnv(authority, mergedEnv);
	const watcherScript = resolveHudWatcherScript(
		packageRoot,
		"notify-fallback-watcher.js",
		authority.workspace_identity.canonical_path,
		childEnv,
	);
	const notifyScript = resolveHudWatcherScript(
		packageRoot,
		"notify-hook.js",
		authority.workspace_identity.canonical_path,
		childEnv,
	);
	const authorityStateDir = authority.canonical_state_root;
	const authorityOwnerPath = join(
		authorityStateDir,
		"notify-fallback-authority-owner.json",
	);
	const authorityStatePath = join(
		authorityStateDir,
		"notify-fallback-authority-state.json",
	);
	const authorityLockPath = join(
		authorityStateDir,
		"notify-fallback-authority.lock",
	);
	const runProcess = deps.runProcess ?? defaultRunProcess;
	const authorityRootIdentity = authority.generation.root_identity;

	let previousState: HudAuthorityState | null;
	try {
		previousState = await readAuthorityState(authorityStatePath);
	} catch (error) {
		if (
			!(await writeInvalidStateDiagnostic(
				authorityStatePath,
				authorityOwnerPath,
				frameCwd,
				nowMs,
				minIntervalMs,
				jitterMs,
				error,
				authorityStateDir,
				authorityRootIdentity,
			))
		) {
			throw new Error(
				"failed to persist HUD authority invalid-state diagnostic",
			);
		}
		return;
	}
	const previousNextAllowedMs = parseIsoMs(previousState?.next_allowed_at);
	if (
		previousState &&
		previousNextAllowedMs !== null &&
		nowMs < previousNextAllowedMs
	) {
		await writeRateLimitSkipState(
			authorityStatePath,
			authorityOwnerPath,
			frameCwd,
			nowMs,
			minIntervalMs,
			jitterMs,
			previousState,
			"rate_limited",
			authorityStateDir,
			authorityRootIdentity,
		);
		return;
	}

	const authorityValidation = await validateStateAuthority(
		authority.generation,
		{
			workspace_identity: authority.workspace_identity,
			session_id: authority.session_binding?.canonical_session_id,
		},
	);
	if (!authorityValidation.valid) return;

	const lock = await acquireAuthorityLock(
		authorityLockPath,
		timeoutMs + minIntervalMs,
		nowMs,
	);
	if (!lock) {
		const latestState = await readAuthorityState(authorityStatePath).catch(
			() => null,
		);
		const diagnosticState = latestState ?? previousState;
		const lockedState = buildAuthorityState(
			frameCwd,
			nowMs,
			minIntervalMs,
			diagnosticState?.jitter_ms ?? jitterMs,
			{
				last_spawn_at: diagnosticState?.last_spawn_at,
				last_skip_at: new Date(nowMs).toISOString(),
				next_allowed_at: diagnosticState?.next_allowed_at,
				skip_count: (diagnosticState?.skip_count ?? 0) + 1,
				last_status: "locked",
				last_reason: "spawn_lock_active",
				last_error: diagnosticState?.last_error,
			},
		);
		await writeAuthorityState(
			authorityOwnerPath,
			lockedState,
			authorityStateDir,
			authorityRootIdentity,
		);
		return;
	}

	await deps.onLockAcquired?.();

	let lockedState: HudAuthorityState | null;
	try {
		lockedState = await readAuthorityState(authorityStatePath);
	} catch (error) {
		const diagnosticWritten = await writeInvalidStateDiagnostic(
			authorityStatePath,
			authorityOwnerPath,
			frameCwd,
			nowMs,
			minIntervalMs,
			jitterMs,
			error,
			authorityStateDir,
			authorityRootIdentity,
		);
		await releaseAuthorityLock(lock);
		if (!diagnosticWritten)
			throw new Error("failed to persist HUD authority rate-limit state");
		return;
	}
	const lockedNextAllowedMs = parseIsoMs(lockedState?.next_allowed_at);
	if (
		lockedState &&
		lockedNextAllowedMs !== null &&
		nowMs < lockedNextAllowedMs
	) {
		await writeRateLimitSkipState(
			authorityStatePath,
			authorityOwnerPath,
			frameCwd,
			nowMs,
			minIntervalMs,
			jitterMs,
			lockedState,
			"rate_limited_after_lock",
			authorityStateDir,
			authorityRootIdentity,
		);
		await releaseAuthorityLock(lock);
		return;
	}

	const nextAllowedAt = new Date(
		nowMs + minIntervalMs + jitterMs,
	).toISOString();
	const spawnedState = buildAuthorityState(
		frameCwd,
		nowMs,
		minIntervalMs,
		jitterMs,
		{
			last_spawn_at: new Date(nowMs).toISOString(),
			next_allowed_at: nextAllowedAt,
			skip_count: previousState?.skip_count ?? 0,
			last_status: "spawned",
			last_reason: "spawned",
		},
	);
	await writeAuthorityState(
		authorityOwnerPath,
		spawnedState,
		authorityStateDir,
		authorityRootIdentity,
	);
	if (
		!(await writeAuthorityState(
			authorityStatePath,
			spawnedState,
			authorityStateDir,
			authorityRootIdentity,
		))
	) {
		await releaseAuthorityLock(lock);
		throw new Error("failed to persist HUD authority rate-limit state");
	}

	try {
		await runProcess(
			nodePath,
			[
				watcherScript,
				"--once",
				"--authority-only",
				"--cwd",
				authority.workspace_identity.canonical_path,
				"--notify-script",
				notifyScript,
				"--poll-ms",
				String(pollMs),
			],
			{
				cwd: authority.workspace_identity.canonical_path,
				env: {
					...childEnv,
					OMX_HUD_AUTHORITY: "1",
					OMX_HUD_AUTHORITY_MIN_INTERVAL_MS: String(minIntervalMs),
					OMX_HUD_AUTHORITY_JITTER_MS: String(jitterMaxMs),
				},
				timeoutMs,
			},
		);
	} catch (error) {
		const failedAt = deps.nowMs?.() ?? Date.now();
		const failedState = buildAuthorityState(
			frameCwd,
			failedAt,
			minIntervalMs,
			jitterMs,
			{
				last_spawn_at: spawnedState.last_spawn_at,
				next_allowed_at: nextAllowedAt,
				skip_count: previousState?.skip_count ?? 0,
				last_status: "failed",
				last_reason: "child_failed",
				last_error: error instanceof Error ? error.message : String(error),
			},
		);
		await writeAuthorityState(
			authorityOwnerPath,
			failedState,
			authorityStateDir,
			authorityRootIdentity,
		);
		await writeAuthorityState(
			authorityStatePath,
			failedState,
			authorityStateDir,
			authorityRootIdentity,
		);
		throw error;
	} finally {
		await releaseAuthorityLock(lock);
	}
}
