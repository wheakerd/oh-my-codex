import { existsSync } from 'fs';
import { mkdir, readdir, stat } from 'fs/promises';
import { dirname, join } from 'path';
import {
  atomicWriteAuthorityFile,
  captureRootFilesystemIdentity,
  ensureAuthorityDirectory,
  readAuthorityFileWithExpectedRoot,
  removeAuthorityDirectory,
  sameRootFilesystemIdentity,
  type ResolvedStateAuthorityContext,
  type RootFilesystemIdentity,
  StateAuthorityError,
} from '../../state/authority.js';
import { captureTmuxPaneFromEnv } from '../../state/mode-state-context.js';
import { resolveCodexPane } from '../tmux-hook-engine.js';
import { safeString } from './utils.js';
import type { PromptMutationAuthorization } from '../../hooks/prompt-session-provenance.js';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RALPH_TERMINAL_PHASES = new Set(['blocked_on_user', 'complete', 'failed', 'cancelled', 'interrupted']);
const DEFAULT_RALPH_ACTIVE_STATE_STALE_MS = 24 * 60 * 60 * 1000;
const RALPH_RESUME_LOCK_STALE_MS = 10_000;
const RALPH_RESUME_LOCK_TIMEOUT_MS = 5_000;
const RALPH_RESUME_LOCK_RETRY_MS = 25;

interface RalphSessionResumeHooks {
  afterLockAcquired?: () => Promise<void> | void;
  afterTargetWrite?: () => Promise<void> | void;
}

interface RalphSessionResumeParams {
  /** Already authenticated, committed state authority for every resume mutation. */
  stateAuthority: Readonly<ResolvedStateAuthorityContext>;
  authorization?: PromptMutationAuthorization;
  payloadThreadId?: string;
  env?: NodeJS.ProcessEnv;
  hooks?: RalphSessionResumeHooks;
}

export interface RalphSessionResumeResult {
  currentOmxSessionId: string;
  resumed: boolean;
  updatedCurrentOwner: boolean;
  reason: string;
  sourcePath?: string;
  targetPath?: string;
}

interface RalphStateCandidate {
  sessionId: string;
  path: string;
  state: Record<string, unknown>;
}

interface RalphStateFreshness {
  stale: boolean;
  ageMs: number;
  checkedAtMs: number;
  staleThresholdMs: number;
  timestampSource: string;
}

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeRecoverStaleLock(
  lockDir: string,
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    if (Date.now() - info.mtimeMs <= RALPH_RESUME_LOCK_STALE_MS) return false;
    await removeAuthorityDirectory(lockDir, {
      authority_root: stateDir,
      expected_root_identity: rootIdentity,
    });
    return true;
  } catch {
    return false;
  }
}

async function withRalphResumeLock<T>(
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
  fn: () => Promise<T>,
): Promise<T | null> {
  const lockDir = join(stateDir, '.lock.ralph-session-resume');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + RALPH_RESUME_LOCK_TIMEOUT_MS;
  await ensureAuthorityDirectory(stateDir, dirname(lockDir), { expected_root_identity: rootIdentity });

  while (true) {
    try {
      await mkdir(lockDir, { recursive: false, mode: 0o700 });
      try {
        await atomicWriteAuthorityFile(ownerPath, ownerToken, {
          authority_root: stateDir,
          expected_root_identity: rootIdentity,
        });
      } catch (error) {
        await removeAuthorityDirectory(lockDir, {
          authority_root: stateDir,
          expected_root_identity: rootIdentity,
        }).catch(() => {});
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, stateDir, rootIdentity)) continue;
      if (Date.now() > deadline) return null;
      await sleep(RALPH_RESUME_LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readAuthorityFileWithExpectedRoot(ownerPath, {
        authority_root: stateDir,
        expected_root_identity: rootIdentity,
      });
      if (currentOwner?.trim() === ownerToken) {
        await removeAuthorityDirectory(lockDir, {
          authority_root: stateDir,
          expected_root_identity: rootIdentity,
        });
      }
    } catch {
      // Lock may already be gone after stale recovery or process interruption.
    }
  }
}

async function readJson(
  path: string,
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<Record<string, unknown> | null> {
  try {
    const content = await readAuthorityFileWithExpectedRoot(path, {
      authority_root: stateDir,
      expected_root_identity: rootIdentity,
    });
    return content ? JSON.parse(content) as Record<string, unknown> : null;
  } catch (error) {
    if (error instanceof StateAuthorityError) throw error;
    return null;
  }
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<void> {
  await ensureAuthorityDirectory(stateDir, dirname(path), { expected_root_identity: rootIdentity });
  await atomicWriteAuthorityFile(path, JSON.stringify(value, null, 2), {
    authority_root: stateDir,
    expected_root_identity: rootIdentity,
  });
}

function isTerminalRalphPhase(value: unknown): boolean {
  return RALPH_TERMINAL_PHASES.has(safeString(value).trim().toLowerCase());
}

function isActiveRalphCandidate(state: Record<string, unknown> | null): state is Record<string, unknown> {
  if (!state || typeof state !== 'object') return false;
  return state.active === true && !isTerminalRalphPhase(state.current_phase);
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(safeString(value).trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveActiveStateStaleThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInteger(env.OMX_RALPH_ACTIVE_STATE_STALE_MS)
    ?? parsePositiveInteger(env.OMX_RALPH_RESUME_STALE_MS)
    ?? DEFAULT_RALPH_ACTIVE_STATE_STALE_MS;
}

function parseTimestampMs(value: unknown): number | null {
  const raw = safeString(value).trim();
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stateActivityTimestampMs(state: Record<string, unknown>): { ms: number; source: string } | null {
  let newest: { ms: number; source: string } | null = null;
  for (const key of ['updated_at', 'last_turn_at', 'tmux_pane_set_at']) {
    const ms = parseTimestampMs(state[key]);
    if (ms !== null && (!newest || ms > newest.ms)) {
      newest = { ms, source: key };
    }
  }
  return newest;
}

async function readRalphStateFreshness(
  path: string,
  state: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RalphStateFreshness> {
  const checkedAtMs = Date.now();
  const threshold = resolveActiveStateStaleThresholdMs(env);
  let timestamp = stateActivityTimestampMs(state);
  if (!timestamp) {
    try {
      const info = await stat(path);
      timestamp = { ms: info.mtimeMs, source: 'mtime' };
    } catch {
      timestamp = { ms: checkedAtMs, source: 'missing_mtime' };
    }
  }
  const ageMs = Math.max(0, checkedAtMs - timestamp.ms);
  return {
    stale: ageMs > threshold,
    ageMs,
    checkedAtMs,
    staleThresholdMs: threshold,
    timestampSource: timestamp.source,
  };
}

async function markRalphStateAbandoned(
  path: string,
  state: Record<string, unknown>,
  freshness: RalphStateFreshness,
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<void> {
  const nowIso = new Date(freshness.checkedAtMs).toISOString();
  await writeJsonAtomic(path, {
    ...state,
    active: false,
    current_phase: 'cancelled',
    completed_at: nowIso,
    abandoned_at: nowIso,
    stop_reason: 'stale_active_state',
    stale_resume_age_ms: freshness.ageMs,
    stale_resume_threshold_ms: freshness.staleThresholdMs,
    stale_resume_timestamp_source: freshness.timestampSource,
  }, stateDir, rootIdentity);
}

function resolveResumePane(env: NodeJS.ProcessEnv = process.env): string {
  const injectedPane = captureTmuxPaneFromEnv(env);
  if (env !== process.env && injectedPane) return injectedPane;
  return resolveCodexPane() || injectedPane || '';
}

function bindCurrentPane(state: Record<string, unknown>, nowIso: string, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const paneId = resolveResumePane(env);
  if (!paneId) return state;

  return {
    ...state,
    tmux_pane_id: paneId,
    tmux_pane_set_at: nowIso,
  };
}

async function scanMatchingRalphCandidates(
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
  currentOmxSessionId: string,
  ownerCodexSessionId: string,
  payloadThreadId: string,
  allowedStorageSessionIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ candidates: RalphStateCandidate[]; abandonedCount: number }> {
  const sessionsRoot = join(stateDir, 'sessions');
  if (!existsSync(sessionsRoot)) return { candidates: [], abandonedCount: 0 };

  const entries = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const matches: RalphStateCandidate[] = [];
  let abandonedCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name) || entry.name === currentOmxSessionId || !allowedStorageSessionIds.includes(entry.name)) continue;
    const path = join(sessionsRoot, entry.name, 'ralph-state.json');
    if (!existsSync(path)) continue;
    const state = await readJson(path, stateDir, rootIdentity);
    if (!isActiveRalphCandidate(state)) continue;
    const ownerSessionId = safeString(state.owner_codex_session_id).trim();
    const ownerThreadId = safeString(state.owner_codex_thread_id).trim();
    if (ownerSessionId !== ownerCodexSessionId) continue;
    if (ownerThreadId && payloadThreadId && ownerThreadId !== payloadThreadId) continue;
    const freshness = await readRalphStateFreshness(path, state, env);
    if (freshness.stale) {
      await markRalphStateAbandoned(path, state, freshness, stateDir, rootIdentity);
      abandonedCount += 1;
      continue;
    }
    matches.push({ sessionId: entry.name, path, state });
  }
  return { candidates: matches, abandonedCount };
}

interface RalphTransferJournal {
  schema_version: 1;
  status: 'prepared' | 'committed';
  transfer_id: string;
  source_path: string;
  target_path: string;
  source_state: Record<string, unknown>;
  previous_state: Record<string, unknown>;
  next_state: Record<string, unknown>;
}

function transferJournalPath(stateDir: string): string {
  return join(stateDir, 'ralph-session-resume-transfer.json');
}

async function recoverRalphTransfer(
  stateDir: string,
  rootIdentity: RootFilesystemIdentity,
): Promise<void> {
  const journal = await readJson(transferJournalPath(stateDir), stateDir, rootIdentity) as RalphTransferJournal | null;
  if (!journal || journal.schema_version !== 1 || journal.status === 'committed'
    || !journal.transfer_id || !journal.source_path || !journal.target_path) return;
  const source = await readJson(journal.source_path, stateDir, rootIdentity);
  const target = await readJson(journal.target_path, stateDir, rootIdentity);
  const sourceTransferred = source?.ownership_transfer_id === journal.transfer_id && source.active === false;
  if (sourceTransferred) {
    if (target?.ownership_transfer_id !== journal.transfer_id || target.active !== true) {
      await writeJsonAtomic(journal.target_path, journal.next_state, stateDir, rootIdentity);
    }
    await writeJsonAtomic(transferJournalPath(stateDir), { ...journal, status: 'committed' }, stateDir, rootIdentity);
    return;
  }
  if (target?.ownership_transfer_id === journal.transfer_id) {
    await atomicWriteAuthorityFile(journal.target_path, JSON.stringify({ ...target, active: false, current_phase: 'cancelled', stop_reason: 'ownership_transfer_rolled_back' }, null, 2), {
      authority_root: stateDir,
      expected_root_identity: rootIdentity,
    });
  }
  await writeJsonAtomic(journal.source_path, journal.source_state, stateDir, rootIdentity);
  await writeJsonAtomic(transferJournalPath(stateDir), { ...journal, status: 'committed' }, stateDir, rootIdentity);
}

export async function reconcileRalphSessionResume({
  stateAuthority,
  authorization,
  payloadThreadId = '',
  env = process.env,
  hooks,
}: RalphSessionResumeParams): Promise<RalphSessionResumeResult> {
  if (!authorization) {
    return {
      currentOmxSessionId: '',
      resumed: false,
      updatedCurrentOwner: false,
      reason: 'authorization_missing',
    };
  }
  const stateDir = stateAuthority.canonical_state_root;
  const rootIdentity = stateAuthority.generation.root_identity;
  const actualRootIdentity = await captureRootFilesystemIdentity(stateDir);
  if (!sameRootFilesystemIdentity(rootIdentity, actualRootIdentity)) {
    throw new StateAuthorityError('authority_root_fingerprint_mismatch', 'Ralph resume authority root does not match its committed filesystem identity');
  }
  const lockedResult = await withRalphResumeLock(stateDir, rootIdentity, async () => {
    await recoverRalphTransfer(stateDir, rootIdentity);
    await hooks?.afterLockAcquired?.();

    const currentOmxSessionId = authorization.targetSessionId;
    if (!SESSION_ID_PATTERN.test(currentOmxSessionId) || !authorization.allowedStorageSessionIds.includes(currentOmxSessionId)) {
      return {
        currentOmxSessionId: '',
        resumed: false,
        updatedCurrentOwner: false,
        reason: 'current_omx_session_unauthorized',
      };
    }

    const currentSessionDir = join(stateDir, 'sessions', currentOmxSessionId);
    const currentRalphPath = join(currentSessionDir, 'ralph-state.json');
    const currentRalphState = await readJson(currentRalphPath, stateDir, rootIdentity);
    const currentRalphExists = currentRalphState !== null || existsSync(currentRalphPath);
    const nowIso = new Date().toISOString();

    const currentOwnerCodexSessionId = safeString(currentRalphState?.owner_codex_session_id).trim();
    if (currentRalphState && currentOwnerCodexSessionId && currentOwnerCodexSessionId !== authorization.ownerCodexSessionId) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: 'current_ralph_owner_unauthorized',
        targetPath: currentRalphPath,
      };
    }
    if (currentRalphState && currentRalphState.active === true) {
      const freshness = await readRalphStateFreshness(currentRalphPath, currentRalphState, env);
      if (freshness.stale) {
        await markRalphStateAbandoned(currentRalphPath, currentRalphState, freshness, stateDir, rootIdentity);
        return {
          currentOmxSessionId,
          resumed: false,
          updatedCurrentOwner: false,
          reason: 'current_ralph_abandoned_stale',
          targetPath: currentRalphPath,
        };
      }

      let changed = false;
      const updated: Record<string, unknown> = { ...currentRalphState };
      const normalizedPayloadThreadId = safeString(payloadThreadId).trim();
      if (safeString(updated.owner_omx_session_id).trim() !== currentOmxSessionId) {
        updated.owner_omx_session_id = currentOmxSessionId;
        changed = true;
      }
      if (!safeString(updated.owner_codex_session_id).trim()) {
        updated.owner_codex_session_id = authorization.ownerCodexSessionId;
        changed = true;
      }
      if (
        !safeString(updated.owner_codex_session_id).trim()
        && normalizedPayloadThreadId
        && safeString(updated.owner_codex_thread_id).trim() !== normalizedPayloadThreadId
      ) {
        updated.owner_codex_thread_id = normalizedPayloadThreadId;
        changed = true;
      }
      if (
        typeof updated.owner_codex_thread_id === 'string'
        && safeString(updated.owner_codex_session_id).trim()
      ) {
        delete updated.owner_codex_thread_id;
        changed = true;
      }
      const currentPaneId = resolveResumePane(env);
      const currentStatePaneId = safeString(updated.tmux_pane_id).trim();
      if (currentPaneId && currentPaneId !== currentStatePaneId) {
        Object.assign(updated, bindCurrentPane(updated, nowIso, env));
        changed = true;
      }
      if (changed) {
        await writeJsonAtomic(currentRalphPath, updated, stateDir, rootIdentity);
      }
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: changed,
        reason: 'current_ralph_active',
        targetPath: currentRalphPath,
      };
    }

    if (currentRalphExists) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: currentRalphState ? 'current_ralph_present' : 'current_ralph_unreadable',
        targetPath: currentRalphPath,
      };
    }

    const normalizedPayloadSessionId = authorization.ownerCodexSessionId;
    const normalizedPayloadThreadId = safeString(payloadThreadId).trim();
    if (!normalizedPayloadSessionId) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: 'authorized_owner_missing',
      };
    }

    const { candidates, abandonedCount } = await scanMatchingRalphCandidates(
      stateDir,
      rootIdentity,
      currentOmxSessionId,
      normalizedPayloadSessionId,
      normalizedPayloadThreadId,
      authorization.allowedStorageSessionIds,
      env,
    );
    if (candidates.length !== 1) {
      return {
        currentOmxSessionId,
        resumed: false,
        updatedCurrentOwner: false,
        reason: candidates.length === 0
          ? (abandonedCount > 0 ? 'matching_prior_ralph_abandoned_stale' : 'no_matching_prior_ralph')
          : 'multiple_matching_prior_ralphs',
      };
    }

    const source = candidates[0];
    await ensureAuthorityDirectory(stateDir, currentSessionDir, { expected_root_identity: rootIdentity });

    const transferId = lockOwnerToken();
    const nextState = bindCurrentPane({
      ...source.state,
      owner_omx_session_id: currentOmxSessionId,
      owner_codex_session_id: normalizedPayloadSessionId,
      ownership_transfer_id: transferId,
    }, nowIso, env);
    delete nextState.owner_codex_thread_id;
    delete nextState.completed_at;
    delete nextState.stop_reason;

    const previousState: Record<string, unknown> = {
      ...source.state,
      active: false,
      current_phase: 'cancelled',
      completed_at: nowIso,
      stop_reason: 'ownership_transferred',
      ownership_transfer_id: transferId,
    };
    const journal: RalphTransferJournal = {
      schema_version: 1,
      status: 'prepared',
      transfer_id: transferId,
      source_path: source.path,
      target_path: currentRalphPath,
      source_state: source.state,
      previous_state: previousState,
      next_state: nextState,
    };
    await writeJsonAtomic(transferJournalPath(stateDir), journal, stateDir, rootIdentity);
    try {
      // Deactivate first: an interrupted transfer may briefly have no owner, never two.
      await writeJsonAtomic(source.path, previousState, stateDir, rootIdentity);
      await writeJsonAtomic(currentRalphPath, nextState, stateDir, rootIdentity);
      await hooks?.afterTargetWrite?.();
      await writeJsonAtomic(transferJournalPath(stateDir), { ...journal, status: 'committed' }, stateDir, rootIdentity);
    } catch (error) {
      await writeJsonAtomic(source.path, source.state, stateDir, rootIdentity).catch(() => {});
      const target = await readJson(currentRalphPath, stateDir, rootIdentity);
      if (target?.ownership_transfer_id === transferId) {
        await writeJsonAtomic(currentRalphPath, {
          ...target,
          active: false,
          current_phase: 'cancelled',
          stop_reason: 'ownership_transfer_rolled_back',
        }, stateDir, rootIdentity).catch(() => {});
      }
      throw error;
    }

    return {
      currentOmxSessionId,
      resumed: true,
      updatedCurrentOwner: false,
      reason: 'resumed_same_codex_session',
      sourcePath: source.path,
      targetPath: currentRalphPath,
    };
  });

  if (lockedResult) {
    return lockedResult;
  }

  return {
    currentOmxSessionId: '',
    resumed: false,
    updatedCurrentOwner: false,
    reason: 'resume_lock_timeout',
  };
}
