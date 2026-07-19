import { UNSUPPORTED_DOCUMENTED_LEADER_PROOF } from '../ralplan/documented-leader-preflight.js';
import { executeStateOperation } from '../state/operations.js';
import { resolveInstalledRoleName } from '../subagents/tracker.js';

export const RALPLAN_HELP = `omx ralplan - RALPLAN consensus support commands

Usage:
  omx ralplan preflight [--json]
  omx ralplan role-intent write --role <role> --parent-thread <id> [--session <id>] [--ttl-ms <n>] [--json]

preflight fails closed when adapted Ralplan lacks documented leader proof.
role-intent write is unavailable on that adapted surface.
`;

type RoleIntentFailureReason = 'unknown_role' | typeof UNSUPPORTED_DOCUMENTED_LEADER_PROOF;

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
  clearRalplanState?: typeof executeStateOperation;
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

  if (args[0] === 'preflight') {
    const json = parsePreflightArgs(args.slice(1));
    await neutralizeRoutingOnlyRalplanState(
      (deps.cwd ?? process.cwd)(),
      deps.clearRalplanState ?? executeStateOperation,
    );
    emitRoleIntentFailure(UNSUPPORTED_DOCUMENTED_LEADER_PROOF, json, stdout, stderr);
    return;
  }

  if (args[0] !== 'role-intent' || args[1] !== 'write') {
    throw new Error(`Unknown ralplan command: ${args.join(' ')}\n${RALPLAN_HELP}`);
  }

  const parsed = parseRoleIntentWriteArgs(args.slice(2));
  if (!resolveInstalledRoleName(parsed.role)) {
    emitRoleIntentFailure('unknown_role', parsed.json, stdout, stderr);
    return;
  }
  emitRoleIntentFailure(UNSUPPORTED_DOCUMENTED_LEADER_PROOF, parsed.json, stdout, stderr);
  return;
}


function parsePreflightArgs(args: string[]): boolean {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === '--json') return true;
  throw new Error(`Unknown ralplan preflight argument: ${args.join(' ')}`);
}

// Keyword selection can have created ordinary Ralplan mode state before the
// native task schema is available. Clearing it also removes its canonical
// skill state and current-session native Stop state. A missing authority is
// already fail-closed and cannot turn this unsupported preflight into success.
async function neutralizeRoutingOnlyRalplanState(
  cwd: string,
  clearRalplanState: typeof executeStateOperation,
): Promise<void> {
  try {
    await clearRalplanState('state_clear', { workingDirectory: cwd, mode: 'ralplan' });
  } catch {
    // The denial below is deterministic even when there is no committed state
    // authority to clear (and therefore no authoritative routing state).
  }
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
  reason: RoleIntentFailureReason,
  json: boolean,
  stdout: (line: string) => void,
  stderr: (line: string) => void,
): void {
  const failure = { ok: false, reason };
  if (json) stdout(JSON.stringify(failure));
  else stderr(`role-intent write failed: ${reason}`);
  process.exitCode = 1;
}
