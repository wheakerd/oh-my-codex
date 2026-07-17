import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getStateFilePath, resolveStateScope, resolveWritableStateScope } from '../mcp/state-paths.js';
import {
  atomicWriteAuthorityJson,
  ensureAuthorityDirectory,
  resolveStateAuthorityForGuard,
} from '../state/authority.js';
import {
  classifyRunOutcome,
  compatibilityRunOutcomeFromTerminalLifecycleOutcome,
  inferTerminalLifecycleOutcome,
  isTerminalRunOutcome,
  normalizeTerminalLifecycleOutcome,
  normalizeRunOutcome,
  type RunOutcome,
  type TerminalLifecycleOutcome,
} from './run-outcome.js';

const RUN_STATE_FILENAME = 'run-state.json';

export interface RunStateLike {
  active?: unknown;
  mode?: unknown;
  current_phase?: unknown;
  task_description?: unknown;
  started_at?: unknown;
  completed_at?: unknown;
  iteration?: unknown;
  max_iterations?: unknown;
  error?: unknown;
  outcome?: unknown;
  run_outcome?: unknown;
  lifecycle_outcome?: unknown;
  terminal_outcome?: unknown;
  question_enforcement?: unknown;
  owner_omx_session_id?: unknown;
  [key: string]: unknown;
}

export interface RunState {
  version: 1;
  mode: string;
  active: boolean;
  outcome: RunOutcome;
  lifecycle_outcome?: TerminalLifecycleOutcome;
  updated_at: string;
  current_phase?: string;
  task_description?: string;
  started_at?: string;
  completed_at?: string;
  iteration?: number;
  max_iterations?: number;
  error?: string;
  owner_omx_session_id?: string;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function terminalOutcomeFromPhase(phase: string | undefined): RunOutcome | null {
  if (!phase) return null;
  const normalized = normalizeRunOutcome(phase).outcome;
  return normalized && isTerminalRunOutcome(normalized) ? normalized : null;
}

export function deriveRunOutcomeFromModeState(state: RunStateLike): RunOutcome {
  if (state.active === true) return 'continue';

  const lifecycleOutcome = inferTerminalLifecycleOutcome(state as Record<string, unknown>, {
    includeQuestionEnforcement: true,
  });
  if (lifecycleOutcome) return compatibilityRunOutcomeFromTerminalLifecycleOutcome(lifecycleOutcome);

  const explicitOutcome = normalizeRunOutcome(state.outcome ?? state.run_outcome).outcome;
  if (explicitOutcome) return explicitOutcome;

  const phaseOutcome = terminalOutcomeFromPhase(optionalString(state.current_phase));
  if (phaseOutcome) return phaseOutcome;

  if (optionalString(state.error)) return 'failed';
  if (optionalString(state.completed_at)) return 'finish';

  return classifyRunOutcome(state.current_phase);
}

export function buildRunState(
  state: RunStateLike,
  existing?: Partial<RunState> | null,
  nowIso: string = new Date().toISOString(),
): RunState {
  const lifecycleOutcome = normalizeTerminalLifecycleOutcome(
    state.lifecycle_outcome ?? state.terminal_outcome,
  ).outcome ?? inferTerminalLifecycleOutcome(state as Record<string, unknown>, {
    includeQuestionEnforcement: true,
  }) ?? existing?.lifecycle_outcome;
  const outcome = deriveRunOutcomeFromModeState(state);
  const active = state.active === true;
  const next: RunState = {
    version: 1,
    mode: optionalString(state.mode) ?? optionalString(existing?.mode) ?? 'unknown',
    active,
    outcome,
    updated_at: nowIso,
  };

  if (lifecycleOutcome) next.lifecycle_outcome = lifecycleOutcome;

  const currentPhase = optionalString(state.current_phase);
  if (currentPhase) next.current_phase = currentPhase;

  const taskDescription = optionalString(state.task_description);
  if (taskDescription) next.task_description = taskDescription;

  const startedAt = optionalString(state.started_at) ?? optionalString(existing?.started_at);
  if (startedAt) next.started_at = startedAt;

  const completedAt = active
    ? undefined
    : optionalString(state.completed_at)
      ?? (isTerminalRunOutcome(outcome) ? optionalString(existing?.completed_at) ?? nowIso : undefined);
  if (completedAt) next.completed_at = completedAt;

  const iteration = optionalFiniteNumber(state.iteration);
  if (iteration !== undefined) next.iteration = iteration;

  const maxIterations = optionalFiniteNumber(state.max_iterations);
  if (maxIterations !== undefined) next.max_iterations = maxIterations;

  const error = optionalString(state.error);
  if (error) next.error = error;

  const ownerSessionId = optionalString(state.owner_omx_session_id);
  if (ownerSessionId) next.owner_omx_session_id = ownerSessionId;

  return next;
}

function getRunStatePath(workingDirectory?: string, sessionId?: string): string {
  return getStateFilePath(RUN_STATE_FILENAME, workingDirectory, sessionId);
}


export async function readRunState(
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<RunState | null> {
  const scope = await resolveStateScope(workingDirectory, explicitSessionId);
  const path = getRunStatePath(workingDirectory, scope.sessionId);
  if (!existsSync(path)) return null;

  try {
    return JSON.parse(await readFile(path, 'utf-8')) as RunState;
  } catch {
    return null;
  }
}

export async function syncRunStateFromModeState(
  state: RunStateLike,
  workingDirectory?: string,
  explicitSessionId?: string,
): Promise<RunState> {
  const scope = await resolveWritableStateScope(workingDirectory, explicitSessionId);
  const cwd = workingDirectory ?? process.cwd();
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: scope.sessionId,
  });
  const path = join(scope.stateDir, RUN_STATE_FILENAME);
  await ensureAuthorityDirectory(authority.canonical_state_root, scope.stateDir, {
    expected_root_identity: authority.generation.root_identity,
  });

  let existing: RunState | null = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, 'utf-8')) as RunState;
    } catch {
      existing = null;
    }
  }
  const next = buildRunState(state, existing);
  await atomicWriteAuthorityJson(path, next, {
    authority_root: authority.canonical_state_root,
    expected_root_identity: authority.generation.root_identity,
  });
  return next;
}
