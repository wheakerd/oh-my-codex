import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { attestLeaderThread, readSubagentTrackingState, recordSubagentTurnForSession } from '../../subagents/tracker.js';
import { parseRoleIntentCorrelationToken } from '../../leader/contract.js';
import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const AUTHORITY_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_STARTUP_CWD',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;
async function invoke(cwd: string, args: string[], deps: Omit<RalplanCommandDependencies, 'cwd' | 'stdout' | 'stderr'> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { ...deps, cwd: () => cwd, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

// Simulate the state the native hook (Phase 1) leaves before the CLI runs: a reconciled
// canonical session pointer plus a durable leader attestation.
async function seedAuthenticatedPointer(
  cwd: string,
  sessionId: string,
  leaderThreadId: string,
  attest = true,
): Promise<string> {
  await mkdir(join(cwd, '.omx'), { recursive: true, mode: 0o700 });
  await chmod(join(cwd, '.omx'), 0o700);
  await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `ralplan-bootstrap-${sessionId}`,
    session_binding: { canonical_session_id: sessionId },
  });
  const stateDir = join(cwd, '.omx', 'state');
  await writeFile(join(stateDir, 'session.json'), JSON.stringify({
    session_id: sessionId,
    native_session_id: leaderThreadId,
    started_at: '2026-07-14T00:00:00.000Z',
    cwd,
  }));
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: sessionId,
  });
  await mintStateAuthorityTransportCapability(authority);
  Object.assign(process.env, buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId }));
  if (attest) {
    const result = attestLeaderThread(cwd, { sessionId, leaderThreadId, source: 'native-pretooluse' }, stateDir);
    assert.equal(result.ok, true);
  }
  return stateDir;
}

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-3181-'));
  const previous = new Map(AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
    delete process.env.CODEX_SESSION_ID;
    delete process.env.SESSION_ID;
    await fn(cwd);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('#3181 ralplan CLI fresh-turn bootstrap', () => {
  it('FR-05: fresh no-session/no-tracker fails closed with native_anchor_unavailable (not missing_session)', async () => {
    await withCwd(async (cwd) => {
      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-thread-fresh', '--json']);
      assert.equal(res.exitCode, 1);
      assert.deepEqual(JSON.parse(res.stdout.join('\n')), { ok: false, reason: 'native_anchor_unavailable' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('FR-03: authenticated fresh turn self-heals leader and records the adapted intent with an App-compatible spawn_task_name', async () => {
    await withCwd(async (cwd) => {
      await seedAuthenticatedPointer(cwd, 'sess-app', 'codex-leader-thread');
      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-leader-thread', '--json']);
      assert.equal(res.exitCode, undefined);
      const receipt = JSON.parse(res.stdout.join('\n')) as { ok: boolean; intent: { role: string; session_id: string; parent_thread_id: string; correlation_token: string }; spawn_task_name: string };
      assert.equal(receipt.ok, true);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal(receipt.intent.session_id, 'sess-app');
      assert.equal(receipt.intent.parent_thread_id, 'codex-leader-thread');
      assert.match(receipt.spawn_task_name, /^omx_role_intent_[a-z0-9_]+$/);
      assert.equal(parseRoleIntentCorrelationToken(receipt.spawn_task_name), receipt.intent.correlation_token);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions['sess-app']?.threads['codex-leader-thread']?.kind, 'leader');
      assert.equal(state.pending_role_intents.length, 1);
    });
  });

  it('FR-06: authenticated session with a spoofed --parent-thread fails closed with native_anchor_mismatch', async () => {
    await withCwd(async (cwd) => {
      await seedAuthenticatedPointer(cwd, 'sess-app', 'codex-leader-thread');
      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'attacker-thread', '--json']);
      assert.equal(res.exitCode, 1);
      assert.deepEqual(JSON.parse(res.stdout.join('\n')), { ok: false, reason: 'native_anchor_mismatch' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('FR-09: duplicate same-identity write reuses the original receipt (idempotent), one intent', async () => {
    await withCwd(async (cwd) => {
      await seedAuthenticatedPointer(cwd, 'sess-app', 'codex-leader-thread');
      const first = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-leader-thread', '--json']);
      const second = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-leader-thread', '--json']);
      const r1 = JSON.parse(first.stdout.join('\n')) as { spawn_task_name: string; intent: { correlation_token: string } };
      const r2 = JSON.parse(second.stdout.join('\n')) as { spawn_task_name: string; intent: { correlation_token: string } };
      assert.equal(r2.intent.correlation_token, r1.intent.correlation_token);
      assert.equal(r2.spawn_task_name, r1.spawn_task_name);
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
    });
  });

  it('FR-16: durable bootstrap-order recovery restores the exact intent/receipt after a simulated restart-before-spawn', async () => {
    await withCwd(async (cwd) => {
      await seedAuthenticatedPointer(cwd, 'sess-app', 'codex-leader-thread');
      const first = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-leader-thread', '--json']);
      const original = JSON.parse(first.stdout.join('\n')) as { spawn_task_name: string; intent: { correlation_token: string } };
      // Simulated restart-before-spawn: durable state persists; a resumed leader re-runs
      // role-intent write for the same identity and must recover the exact intent/receipt,
      // never a fresh unrelated intent.
      const resumed = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'codex-leader-thread', '--json']);
      const recovered = JSON.parse(resumed.stdout.join('\n')) as { spawn_task_name: string; intent: { correlation_token: string } };
      assert.equal(recovered.intent.correlation_token, original.intent.correlation_token);
      assert.equal(recovered.spawn_task_name, original.spawn_task_name);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 1);
      assert.equal(state.sessions['sess-app']?.leader_thread_id, 'codex-leader-thread');
    });
  });

  it('does not use a durable attestation for an env-selected session with no usable current pointer (stale/foreign guard)', async () => {
    await withCwd(async (cwd) => {
      // The usable pointer belongs to session B, but a stale process selects attested
      // session A via the environment. A has an attestation in the shared tracker.
      const stateDir = await seedAuthenticatedPointer(cwd, 'sess-real-B', 'native-B', false);
      const attest = attestLeaderThread(cwd, {
        sessionId: 'sess-attested-A',
        leaderThreadId: 'attacker-known-leader',
        source: 'native-pretooluse',
      }, stateDir);
      assert.equal(attest.ok, true);
      process.env.OMX_SESSION_ID = 'sess-attested-A';

      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'attacker-known-leader', '--json']);
      assert.equal(res.exitCode, 1);
      assert.deepEqual(JSON.parse(res.stdout.join('\n')), { ok: false, reason: 'native_anchor_unavailable' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });

  it('legacy native-session path: authenticates the native leader when it is not a subagent', async () => {
    await withCwd(async (cwd) => {
      // A reconciled pointer PLUS a positively-provenanced tracker leader (from a real
      // recorded leader turn); the leader thread equals the native session id, as in reality.
      await seedAuthenticatedPointer(cwd, 'sess-legacy', 'native-legacy', false);
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'sess-legacy', threadId: 'native-legacy', kind: 'leader', leaderThreadId: 'native-legacy', timestamp: new Date().toISOString(),
      });
      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'native-legacy', '--json']);
      assert.equal(res.exitCode, undefined);
      const receipt = JSON.parse(res.stdout.join('\n')) as { ok: boolean; intent: { role: string; parent_thread_id: string } };
      assert.equal(receipt.ok, true);
      assert.equal(receipt.intent.parent_thread_id, 'native-legacy');
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
    });
  });

  it('legacy native-session path: refuses a native leader that is also tracked as a subagent (atomic, no downgrade)', async () => {
    await withCwd(async (cwd) => {
      await seedAuthenticatedPointer(cwd, 'sess-legacy', 'native-legacy', false);
      // The session has a positively-provenanced tracker leader...
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'sess-legacy', threadId: 'native-legacy', kind: 'leader', leaderThreadId: 'native-legacy', timestamp: new Date().toISOString(),
      });
      // The native-session thread is also recorded as a subagent in another session (the
      // PreToolUse-attestation-lost-the-race outcome). The legacy path must NOT authorize it.
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'other-session', threadId: 'native-legacy', kind: 'subagent', leaderThreadId: 'other-session', timestamp: new Date().toISOString(),
      });
      const res = await invoke(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'native-legacy', '--json']);
      assert.equal(res.exitCode, 1);
      assert.deepEqual(JSON.parse(res.stdout.join('\n')), { ok: false, reason: 'native_anchor_mismatch' });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    });
  });
});
