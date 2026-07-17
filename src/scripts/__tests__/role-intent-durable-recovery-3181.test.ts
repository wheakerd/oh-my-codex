import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dispatchCodexNativeHook } from '../codex-native-hook.js';
import { readSubagentTrackingState } from '../../subagents/tracker.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

async function installAuthenticatedAuthority(cwd: string, sessionId: string): Promise<void> {
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true, mode: 0o700 });
  await chmod(join(cwd, '.omx'), 0o700);
  await chmod(join(cwd, '.omx', 'state'), 0o700);
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `${sessionId}-launch`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  Object.assign(process.env, buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId }));
}

const CANONICAL_ROLE_INTENT_COMMAND =
  'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json';

const UNSUPPORTED_DENIAL = {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
  },
};

describe('#3181 documented leader-proof boundary', () => {
  it('does not turn a shared session id, undocumented thread id, pointer alias, or absent child marker into a role-intent authority proof', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-proof-boundary-'));
    const prior = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const sessionId = 'codex-native-shared-session';
      await installAuthenticatedAuthority(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse',
        cwd,
        session_id: sessionId,
        thread_id: sessionId,
        tool_name: 'Bash',
        tool_use_id: 'tool-undocumented-proof',
        tool_input: { command: CANONICAL_ROLE_INTENT_COMMAND },
      }, { cwd, sessionOwnerPid: process.pid });

      assert.deepEqual(result.outputJson, UNSUPPORTED_DENIAL);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[sessionId]?.leader_attested_at, undefined);
      assert.deepEqual(state.pending_role_intents, []);
    } finally {
      if (prior.OMX_SESSION_ID === undefined) delete process.env.OMX_SESSION_ID;
      else process.env.OMX_SESSION_ID = prior.OMX_SESSION_ID;
      if (prior.CODEX_SESSION_ID === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = prior.CODEX_SESSION_ID;
      if (prior.SESSION_ID === undefined) delete process.env.SESSION_ID;
      else process.env.SESSION_ID = prior.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps the documented unknown-role validation path distinct from leader authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-proof-unknown-role-'));
    const sessionId = 'codex-native-unknown-role';
    const authorityEnvKeys = [
      'OMX_SESSION_ID',
      'CODEX_SESSION_ID',
      'SESSION_ID',
      'OMX_STARTUP_CWD',
      'OMX_ROOT',
      'OMX_STATE_ROOT',
      'OMX_TEAM_STATE_ROOT',
      'OMX_STATE_AUTHORITY_PATH',
      'OMX_STATE_AUTHORITY_ID',
      'OMX_STATE_AUTHORITY_GENERATION_ID',
      'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
      'OMX_STATE_AUTHORITY_CAPABILITY',
    ] as const;
    const priorEnv = Object.fromEntries(authorityEnvKeys.map((key) => [key, process.env[key]]));
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      await installAuthenticatedAuthority(cwd, sessionId);

      const result = await dispatchCodexNativeHook({
        hook_event_name: 'PreToolUse',
        cwd,
        session_id: sessionId,
        thread_id: sessionId,
        tool_name: 'Bash',
        tool_input: {
          command: 'omx ralplan role-intent write --role uninstalled-role --parent-thread "$CODEX_THREAD_ID" --json',
        },
      }, { cwd, sessionOwnerPid: process.pid });

      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Ralplan role-intent denied: unknown_role.',
        },
      });
      assert.deepEqual((await readSubagentTrackingState(cwd)).pending_role_intents, []);
    } finally {
      for (const key of authorityEnvKeys) {
        if (priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
