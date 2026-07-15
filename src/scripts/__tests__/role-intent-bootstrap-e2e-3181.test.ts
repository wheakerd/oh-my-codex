import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../../cli/ralplan.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../../subagents/tracker.js';
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
  it('SessionStart reconcile alone neither attests nor authorizes a role intent (fail-closed; positive provenance required)', async () => {
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

      // 2. SessionStart reconciles the canonical pointer but does NOT attest a leader
      //    (a null transcript cannot positively classify a root vs a malformed child) and
      //    writes no positively-provenanced tracker leader.
      const afterStart = await readSubagentTrackingState(cwd);
      assert.equal(afterStart.sessions[nativeSessionId]?.leader_attested_at, undefined, 'SessionStart must not attest a leader');

      // 3. A role-intent write on the reconciled-pointer-only session FAILS CLOSED: the bare
      //    session.json native_session_id is not a trusted leader anchor (an ambiguous /
      //    malformed-child SessionStart could set it). Authorization requires positive
      //    provenance — a PreToolUse attestation (next test) or a recorded tracker leader.
      const res = await invokeRoleIntent(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', nativeSessionId, '--json']);
      assert.equal(res.exitCode, 1);
      assert.deepEqual(JSON.parse(res.stdout.join('\n')), { ok: false, reason: 'parent_not_active_leader' });

      const finalState = await readSubagentTrackingState(cwd);
      assert.deepEqual(finalState.pending_role_intents, []);
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('PreToolUse (leader turn) bootstraps the pointer + attestation when SessionStart did not, so the first role-intent write succeeds', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-pretool-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const nativeSessionId = 'codex-native-exec-leader';

      // Fresh exec turn where the first event reaching OMX is a leader PreToolUse (no
      // prior SessionStart pointer). The leader turn carries thread_id == session_id.
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'PreToolUse',
          cwd,
          session_id: nativeSessionId,
          thread_id: nativeSessionId,
          tool_name: 'Bash',
          tool_use_id: 'tool-exec-first',
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
        },
        { cwd, sessionOwnerPid: process.pid },
      );

      const afterPreTool = await readSubagentTrackingState(cwd);
      const attested = afterPreTool.sessions[nativeSessionId];
      assert.equal(attested?.leader_thread_id, nativeSessionId);
      assert.equal(attested?.leader_attest_source, 'native-pretooluse');

      const res = await invokeRoleIntent(cwd, ['role-intent', 'write', '--role', 'architect', '--parent-thread', nativeSessionId, '--json']);
      assert.equal(res.exitCode, undefined);
      const receipt = JSON.parse(res.stdout.join('\n')) as { ok: boolean; intent: { role: string } };
      assert.equal(receipt.ok, true);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal((await readSubagentTrackingState(cwd)).pending_role_intents.length, 1);
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('never attests a thread durably tracked as a subagent, even via a source-less leader-shaped PreToolUse', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-child-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const childThreadId = 'codex-native-child-thread';

      // A child is durably recorded as a subagent (e.g. at its own SessionStart).
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'leader-session',
        threadId: childThreadId,
        kind: 'subagent',
        leaderThreadId: 'leader-session',
        timestamp: new Date().toISOString(),
      });

      // The child then emits a source-less, untyped, leader-shaped PreToolUse
      // (thread_id === session_id). It must NOT be promoted to leader.
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'PreToolUse',
          cwd,
          session_id: childThreadId,
          thread_id: childThreadId,
          tool_name: 'Bash',
          tool_use_id: 'tool-child-selfpromote',
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
        },
        { cwd, sessionOwnerPid: process.pid },
      );

      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[childThreadId]?.leader_attested_at, undefined, 'child thread must not be attested as leader');
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('never bootstraps a leader from a PreToolUse carrying a malformed/blank thread_spawn carrier', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-malformed-spawn-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const childThreadId = 'codex-native-malformed-spawn';
      // Present-but-malformed thread_spawn carrier (blank parent id) is still child
      // provenance and must veto leader bootstrap: no pointer, no attestation.
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'PreToolUse',
          cwd,
          session_id: childThreadId,
          thread_id: childThreadId,
          tool_name: 'Bash',
          tool_use_id: 'tool-malformed-spawn',
          source: { subagent: { thread_spawn: { parent_thread_id: '' } } },
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
        },
        { cwd, sessionOwnerPid: process.pid },
      );
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[childThreadId]?.leader_attested_at, undefined, 'malformed thread_spawn must not attest as leader');
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('never bootstraps a leader from a PreToolUse carrying an explicit non-installed agent_role', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-unknown-role-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const childThreadId = 'codex-native-unknown-role';
      // An explicit but non-installed agent role is still role provenance and must veto
      // leader bootstrap even though it does not resolve to an installed OMX agent.
      await dispatchCodexNativeHook(
        {
          hook_event_name: 'PreToolUse',
          cwd,
          session_id: childThreadId,
          thread_id: childThreadId,
          agent_role: 'collaboration-child',
          tool_name: 'Bash',
          tool_use_id: 'tool-unknown-role',
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
        },
        { cwd, sessionOwnerPid: process.pid },
      );
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[childThreadId]?.leader_attested_at, undefined, 'explicit non-installed agent_role must not attest as leader');
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
