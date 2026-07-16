import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { readSubagentTrackingState } from '../../subagents/tracker.js';
import { parseRoleIntentCorrelationToken } from '../../leader/contract.js';
import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';
import { AUTHORITY_DIAGNOSTIC_CODES, initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard, StateAuthorityError } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import { writeSessionStart } from '../../hooks/session.js';
import { resolveAuthorityRuntimeStateScope } from '../../mcp/state-paths.js';

async function invokeRoleIntent(
  cwd: string,
  args: string[],
  deps: Omit<RalplanCommandDependencies, 'cwd' | 'stdout' | 'stderr'> = {},
): Promise<{
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, {
      ...deps,
      cwd: () => cwd,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

async function writeCurrentSession(
  cwd: string,
  sessionId: string,
  nativeLeaderThreadId: string,
  trackerLeaderThreadId: string,
): Promise<() => void> {
  const stateDir = join(cwd, '.omx', 'state');
  const now = '2026-07-14T00:00:00.000Z';
  await mkdir(join(cwd, '.omx'), { recursive: true });
  await chmod(join(cwd, '.omx'), 0o700);
  await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `ralplan-role-intent-${sessionId}-${Date.now()}`,
    session_binding: { canonical_session_id: sessionId, aliases: { native_session_id: nativeLeaderThreadId } },
  });
  await writeSessionStart(cwd, sessionId, { nativeSessionId: nativeLeaderThreadId });
  await Promise.all([
    writeFile(join(stateDir, 'session.json'), JSON.stringify({
      session_id: sessionId,
      native_session_id: nativeLeaderThreadId,
      started_at: now,
      cwd,
    })),
    writeFile(join(stateDir, 'subagent-tracking.json'), JSON.stringify({
      schemaVersion: 1,
      sessions: {
        [sessionId]: {
          session_id: sessionId,
          leader_thread_id: trackerLeaderThreadId,
          updated_at: now,
          threads: {},
        },
      },
      pending_role_intents: [],
    })),
  ]);
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: sessionId,
  });
  await mintStateAuthorityTransportCapability(authority);
  const transport = buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId });
  const previous = new Map(Object.keys(transport).map((key) => [key, process.env[key]]));
  Object.assign(process.env, transport);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

describe('ralplan role-intent write', () => {
  it('rejects a supplied session that is not the current runtime session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    let restoreAuthority: (() => void) | undefined;
    try {
      restoreAuthority = await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'architect', '--parent-thread', 'tracker-leader', '--session', 'other-session', '--json',
      ]);

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'session_not_current' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      restoreAuthority?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails closed when explicit-session authority resolution rejects', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    let restoreAuthority: (() => void) | undefined;
    try {
      restoreAuthority = await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');
      let calls = 0;
      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'architect', '--parent-thread', 'tracker-leader', '--session', 'current-session', '--json',
      ], {
        resolveSessionScope: async (...args) => {
          calls += 1;
          if (calls === 2) {
            throw new StateAuthorityError(
              AUTHORITY_DIAGNOSTIC_CODES.sessionBindingConflict,
              'injected explicit-session authority conflict',
            );
          }
          return resolveAuthorityRuntimeStateScope(...args);
        },
      });

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'native_anchor_unavailable' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      restoreAuthority?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a parent thread that is not the current session leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    let restoreAuthority: (() => void) | undefined;
    try {
      restoreAuthority = await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'architect', '--parent-thread', 'untrusted-parent', '--json',
      ]);

      assert.equal(result.exitCode, 1);
      assert.deepEqual(result.stderr, []);
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'parent_not_active_leader' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      restoreAuthority?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records the authenticated current-session native leader intent with a correlation token receipt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    let restoreAuthority: (() => void) | undefined;
    try {
      // A real leader's tracker leader_thread_id equals its native session id; #3181
      // authorizes the legacy native path only against that positively-provenanced anchor.
      restoreAuthority = await writeCurrentSession(cwd, 'current-session', 'native-leader', 'native-leader');

      const result = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'ARCHITECT', '--parent-thread', 'native-leader', '--ttl-ms', '5000', '--json',
      ]);

      assert.equal(result.exitCode, undefined);
      assert.deepEqual(result.stderr, []);
      const receipt = JSON.parse(result.stdout.join('\n')) as {
        ok: boolean;
        intent: {
          role: string;
          session_id: string;
          parent_thread_id: string;
          correlation_token: string;
          expires_at: string;
        };
        spawn_task_name: string;
      };
      assert.equal(receipt.ok, true);
      assert.deepEqual(Object.keys(receipt.intent), ['role', 'session_id', 'parent_thread_id', 'correlation_token', 'expires_at']);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal(receipt.intent.session_id, 'current-session');
      assert.equal(receipt.intent.parent_thread_id, 'native-leader');
      assert.match(receipt.intent.correlation_token, /^[0-9a-f]{32}$/);
      assert.ok(Number.isFinite(Date.parse(receipt.intent.expires_at)));
      assert.match(receipt.spawn_task_name, /^[a-z0-9_]+$/);
      assert.ok(receipt.spawn_task_name.startsWith('omx_role_intent_'));
      assert.doesNotMatch(receipt.spawn_task_name, /[-:]/);
      const pendingIntent = (await readSubagentTrackingState(cwd)).pending_role_intents[0];
      assert.equal(pendingIntent?.correlation_token, receipt.intent.correlation_token);
      assert.equal(parseRoleIntentCorrelationToken(receipt.spawn_task_name), pendingIntent?.correlation_token);
    } finally {
      restoreAuthority?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('fails before persistence when an invalid generated token reaches the task-name builder', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    let restoreAuthority: (() => void) | undefined;
    try {
      restoreAuthority = await writeCurrentSession(cwd, 'current-session', 'native-leader', 'tracker-leader');

      await assert.rejects(
        () => invokeRoleIntent(cwd, [
          'role-intent', 'write', '--role', 'architect', '--parent-thread', 'native-leader', '--json',
        ], { generateCorrelationToken: () => 'abc_def' }),
        /Invalid role-intent correlation token/,
      );
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      restoreAuthority?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
