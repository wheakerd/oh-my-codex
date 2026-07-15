import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../../cli/ralplan.js';
import { readSubagentTrackingState } from '../../subagents/tracker.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';

async function invokeRoleIntent(cwd: string, args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, { cwd: () => cwd, stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
  }
}

describe('#3181 end-to-end fresh App turn bootstrap', () => {
  it('SessionStart attests the leader so a fresh in-turn role-intent write succeeds instead of missing_session', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const nativeSessionId = 'codex-native-fresh-app';

      // 1. Fresh App/outside-tmux turn start: no session.json, no tracker yet.
      await dispatchCodexNativeHook(
        { hook_event_name: 'SessionStart', cwd, session_id: nativeSessionId },
        { cwd, sessionOwnerPid: process.pid },
      );

      // 2. The leader is now durably attested by the native hook (Phase 1).
      const afterStart = await readSubagentTrackingState(cwd);
      const attested = afterStart.sessions[nativeSessionId];
      assert.equal(attested?.leader_thread_id, nativeSessionId);
      assert.equal(attested?.leader_attest_source, 'native-sessionstart');
      assert.ok(attested?.leader_attested_at);

      // 3. The first in-turn command (before any child spawn) now succeeds via self-heal
      //    (Phase 2), reproducing the exact #3181 repro command shape.
      const res = await invokeRoleIntent(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', nativeSessionId, '--json']);
      assert.equal(res.exitCode, undefined);
      const receipt = JSON.parse(res.stdout.join('\n')) as { ok: boolean; intent: { role: string; parent_thread_id: string; correlation_token: string }; spawn_task_name: string };
      assert.equal(receipt.ok, true);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal(receipt.intent.parent_thread_id, nativeSessionId);
      assert.match(receipt.spawn_task_name, /^omx_role_intent_[a-z0-9_]+$/);

      const finalState = await readSubagentTrackingState(cwd);
      assert.equal(finalState.pending_role_intents.length, 1);
      assert.equal(finalState.pending_role_intents[0]?.role, 'architect');
      assert.equal(finalState.sessions[nativeSessionId]?.threads[nativeSessionId]?.kind, 'leader');
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
