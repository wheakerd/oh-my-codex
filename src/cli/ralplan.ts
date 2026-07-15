import { randomUUID } from 'node:crypto';

import { resolveRuntimeStateScope } from '../mcp/state-paths.js';
import { ensureLeaderAndRecordIntent, type PendingRoleIntent, readSubagentTrackingState, recordPendingRoleIntent } from '../subagents/tracker.js';
import {
  ROLE_INTENT_CORRELATION_TOKEN_PATTERN,
  buildRoleIntentSpawnTaskName,
  isAppCompatibleSpawnTaskName,
  parseRoleIntentCorrelationToken,
} from '../leader/contract.js';

export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]

role-intent write records the validated role required by the next adapted native spawn.
`;

type RoleIntentFailureReason = 'unknown_role' | 'invalid_correlation_token' | 'invalid_origin' | 'single_flight_conflict' | 'session_not_current' | 'parent_not_active_leader' | 'spawn_task_name_unsupported' | 'native_anchor_unavailable' | 'native_anchor_mismatch';

// Shared validation for the App-compatible correlation token / spawn task name. Throws
// (via buildRoleIntentSpawnTaskName) on structurally invalid tokens, matching the
// pre-#3181 fail-before-persistence contract.
function isSupportedCorrelationToken(token: string): boolean {
  const spawnTaskName = buildRoleIntentSpawnTaskName(token);
  return ROLE_INTENT_CORRELATION_TOKEN_PATTERN.test(token)
    && isAppCompatibleSpawnTaskName(spawnTaskName)
    && parseRoleIntentCorrelationToken(spawnTaskName) === token;
}

interface ParsedRoleIntentWriteArgs {
  role: string;
  parentThreadId: string;
  sessionId?: string;
  ttlMs?: number;
  json: boolean;
}

export interface RalplanCommandDependencies {
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  resolveSessionScope?: typeof resolveRuntimeStateScope;
  recordPendingIntent?: typeof recordPendingRoleIntent;
  ensureLeaderAndRecordIntent?: typeof ensureLeaderAndRecordIntent;
  generateCorrelationToken?: () => string;
}

export async function ralplanCommand(
  args: string[],
  deps: RalplanCommandDependencies = {},
): Promise<void> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  if (args.length === 0 || args.some((arg) => arg === '--help' || arg === '-h' || arg === 'help')) {
    stdout(RALPLAN_HELP);
    return;
  }

  if (args[0] !== 'role-intent' || args[1] !== 'write') {
    throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);
  }

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  const cwd = (deps.cwd ?? process.cwd)();
  const resolveSessionScope = deps.resolveSessionScope ?? resolveRuntimeStateScope;
  const currentScope = await resolveSessionScope(cwd);
  if (!currentScope.sessionId) {
    // #3181: no authenticated canonical session pointer exists in this turn, so there
    // is no verifiable native anchor to bootstrap from. Fail closed with a distinct
    // machine reason instead of the opaque `missing_session`.
    emitRoleIntentFailure('native_anchor_unavailable', parsed.json, stdout, stderr);
    return;
  }

  const requestedScope = parsed.sessionId === undefined
    ? currentScope
    : await resolveSessionScope(cwd, parsed.sessionId);
  if (requestedScope.sessionId !== currentScope.sessionId) {
    emitRoleIntentFailure('session_not_current', parsed.json, stdout, stderr);
    return;
  }

  // #3181: a durable native-hook leader attestation (leader_thread_id + leader_attested_at)
  // authorizes the in-turn atomic self-heal path, but ONLY when a usable current session
  // pointer maps to this session. resolveRuntimeStateScope will select an env-provided
  // session id (OMX_SESSION_ID/CODEX_SESSION_ID/SESSION_ID) even with no usable pointer or
  // a pointer owned by another session; in that case it omits metadata. Requiring metadata
  // that maps to currentScope.sessionId prevents a stale/foreign process from selecting an
  // attested session by environment alone and publishing/binding into it (shared state
  // root). Without a usable pointer, fall back to the legacy native-session path only.
  const hasUsableCurrentPointer = Boolean(
    currentScope.metadata && currentScope.metadata.sessionId === currentScope.sessionId,
  );
  const trackingState = await readSubagentTrackingState(currentScope.cwd);
  const attestedSession = trackingState.sessions[currentScope.sessionId];
  const attestedLeaderThreadId = hasUsableCurrentPointer && attestedSession?.leader_attested_at
    ? attestedSession.leader_thread_id?.trim()
    : undefined;
  const useAttestedBootstrap = Boolean(attestedLeaderThreadId);

  if (!useAttestedBootstrap) {
    const activeLeaderThreadIds = new Set([
      hasUsableCurrentPointer ? attestedSession?.leader_thread_id?.trim() : undefined,
      currentScope.metadata?.nativeSessionId?.trim(),
    ].filter((threadId): threadId is string => Boolean(threadId)));
    if (!activeLeaderThreadIds.has(parsed.parentThreadId.trim())) {
      emitRoleIntentFailure('parent_not_active_leader', parsed.json, stdout, stderr);
      return;
    }
  }

  const correlationToken = (deps.generateCorrelationToken ?? (() => randomUUID().replace(/-/g, '')))();
  if (!isSupportedCorrelationToken(correlationToken)) {
    emitRoleIntentFailure('spawn_task_name_unsupported', parsed.json, stdout, stderr);
    return;
  }

  let result: { ok: true; intent: PendingRoleIntent } | { ok: false; reason: RoleIntentFailureReason };
  if (useAttestedBootstrap) {
    const bootstrap = (deps.ensureLeaderAndRecordIntent ?? ensureLeaderAndRecordIntent)(currentScope.cwd, {
      role: parsed.role,
      sessionId: currentScope.sessionId,
      parentThreadId: parsed.parentThreadId,
      correlationToken,
      ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
    });
    result = bootstrap.ok ? { ok: true, intent: bootstrap.intent } : { ok: false, reason: bootstrap.reason };
  } else {
    const recordPendingIntent = deps.recordPendingIntent ?? recordPendingRoleIntent;
    result = recordPendingIntent(currentScope.cwd, {
      role: parsed.role,
      sessionId: currentScope.sessionId,
      parentThreadId: parsed.parentThreadId,
      correlationToken,
      ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
    });
  }
  if (!result.ok) {
    emitRoleIntentFailure(result.reason, parsed.json, stdout, stderr);
    return;
  }

  // Build the App-compatible spawn task name from the persisted correlation token so an
  // idempotent reuse (same-identity intent) returns the original receipt's task name.
  const spawnTaskName = buildRoleIntentSpawnTaskName(result.intent.correlation_token);
  if (!isSupportedCorrelationToken(result.intent.correlation_token) || parseRoleIntentCorrelationToken(spawnTaskName) !== result.intent.correlation_token) {
    emitRoleIntentFailure('spawn_task_name_unsupported', parsed.json, stdout, stderr);
    return;
  }
  const receipt = {
    ok: true,
    intent: {
      role: result.intent.role,
      session_id: result.intent.session_id,
      parent_thread_id: result.intent.parent_thread_id,
      correlation_token: result.intent.correlation_token,
      expires_at: result.intent.expires_at,
    },
    spawn_task_name: spawnTaskName,
  };
  if (parsed.json) {
    stdout(JSON.stringify(receipt));
    return;
  }
  stdout(`role-intent recorded: role=${receipt.intent.role} session=${receipt.intent.session_id} parent-thread=${receipt.intent.parent_thread_id} correlation-token=${receipt.intent.correlation_token} spawn-task-name=${receipt.spawn_task_name} expires-at=${receipt.intent.expires_at}`);
}

function parseRoleIntentWriteArgs(args: string[]): ParsedRoleIntentWriteArgs {
  let role: string | undefined;
  let parentThreadId: string | undefined;
  let sessionId: string | undefined;
  let ttlMs: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--role' || arg === '--parent-thread' || arg === '--session' || arg === '--ttl-ms') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}.`);
      if (arg === '--role') role = value;
      if (arg === '--parent-thread') parentThreadId = value;
      if (arg === '--session') sessionId = value;
      if (arg === '--ttl-ms') ttlMs = parseTtlMs(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--role=')) {
      role = arg.slice('--role='.length);
      continue;
    }
    if (arg.startsWith('--parent-thread=')) {
      parentThreadId = arg.slice('--parent-thread='.length);
      continue;
    }
    if (arg.startsWith('--session=')) {
      sessionId = arg.slice('--session='.length);
      continue;
    }
    if (arg.startsWith('--ttl-ms=')) {
      ttlMs = parseTtlMs(arg.slice('--ttl-ms='.length));
      continue;
    }
    throw new Error(`Unknown role-intent write argument: ${arg}`);
  }

  if (!role?.trim()) throw new Error('Missing --role.');
  if (!parentThreadId?.trim()) throw new Error('Missing --parent-thread.');
  return {
    role,
    parentThreadId,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    json,
  };
}

function parseTtlMs(value: string): number {
  const ttlMs = Number(value);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('--ttl-ms must be a positive integer.');
  }
  return ttlMs;
}

function emitRoleIntentFailure(
  reason: RoleIntentFailureReason | 'missing_session',
  json: boolean,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
