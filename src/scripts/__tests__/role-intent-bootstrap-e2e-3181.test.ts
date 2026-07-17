import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../../cli/ralplan.js';
import { readSubagentTrackingState, recordSubagentTurnForSession } from '../../subagents/tracker.js';
import { dispatchCodexNativeHook } from '../codex-native-hook.js';
import {
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
  resolveStateAuthorityForGuard,
} from '../../state/authority.js';
import {
  buildStateAuthorityTransportEnv,
  OMX_STATE_AUTHORITY_PATH_ENV,
  OMX_STATE_AUTHORITY_ID_ENV,
  OMX_STATE_AUTHORITY_GENERATION_ID_ENV,
  OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV,
  OMX_STATE_AUTHORITY_CAPABILITY_ENV,
} from '../../state/transport-env.js';

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

function compiledPath(...segments: string[]): string {
  return resolve(process.cwd(), 'dist', ...segments);
}

function buildHermeticChildEnvironment(home: string, codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  for (const key of [
    'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_SESSION_ID', 'OMX_RUN_ID',
    'OMX_ACTIVE_SESSION_PID', 'OMX_SOURCE_CWD', 'OMX_STARTUP_CWD', 'OMX_TEAM_WORKER',
    'OMX_TEAM_INTERNAL_WORKER', 'OMX_TEAM_LEADER_CWD', 'OMX_TEAM_MODE',
    'OMX_QUESTION_RETURN_PANE', 'OMX_LEADER_PANE_ID', 'OMX_TMUX_HUD_OWNER',
    'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TURN_ID', 'SESSION_ID', 'TMUX', 'TMUX_PANE',
    OMX_STATE_AUTHORITY_PATH_ENV, OMX_STATE_AUTHORITY_ID_ENV, OMX_STATE_AUTHORITY_GENERATION_ID_ENV,
    OMX_STATE_AUTHORITY_WORKSPACE_DIGEST_ENV, OMX_STATE_AUTHORITY_CAPABILITY_ENV,
  ]) delete environment[key];
  return environment;
}

function runCompiled(cwd: string, environment: NodeJS.ProcessEnv, script: string, args: string[], input?: Record<string, unknown>) {
  return spawnSync(process.execPath, [compiledPath(script), ...args], {
    cwd,
    env: environment,
    input: input ? JSON.stringify(input) : undefined,
    encoding: 'utf8',
  });
}


async function installAuthenticatedAuthority(cwd: string, sessionId: string): Promise<NodeJS.ProcessEnv> {
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
  return buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId });
}

async function refreshAuthenticatedAuthority(
  cwd: string,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: sessionId,
  });
  await mintStateAuthorityTransportCapability(authority);
  return buildStateAuthorityTransportEnv(authority, { ...environment, OMX_SESSION_ID: sessionId });
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
      Object.assign(process.env, await installAuthenticatedAuthority(cwd, nativeSessionId));

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

  it('denies the canonical installed-role command before undocumented native fields can attest authority', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-pretool-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const nativeSessionId = 'codex-native-exec-leader';
      Object.assign(process.env, await installAuthenticatedAuthority(cwd, nativeSessionId));

      const result = await dispatchCodexNativeHook(
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

      assert.deepEqual(result.outputJson, {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[nativeSessionId]?.leader_attested_at, undefined);
      assert.deepEqual(state.pending_role_intents, []);
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('compiled hook denies the documented canonical role-intent command without attesting a leader', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-compiled-'));
    const home = await mkdtemp(join(tmpdir(), 'omx-3181-home-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-3181-codex-home-'));
    const nativeSessionId = 'codex-native-compiled-leader';
    const environment = {
      ...buildHermeticChildEnvironment(home, codexHome),
      ...await installAuthenticatedAuthority(cwd, nativeSessionId),
    };
    try {
      const preToolUse = runCompiled(cwd, environment, 'scripts/codex-native-hook.js', [], {
        hook_event_name: 'PreToolUse',
        cwd,
        session_id: nativeSessionId,
        thread_id: nativeSessionId,
        tool_name: 'Bash',
        tool_use_id: 'tool-compiled-leader',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      });
      assert.equal(preToolUse.status, 0, String(preToolUse.stderr));
      assert.deepEqual(JSON.parse(String(preToolUse.stdout)), {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'unsupported_documented_leader_proof: Codex 0.144.5 hooks do not expose documented root identity required for adapted Ralplan.',
        },
      });
      const tracking = await readSubagentTrackingState(cwd);
      assert.equal(tracking.sessions[nativeSessionId]?.leader_attested_at, undefined);
      assert.deepEqual(tracking.pending_role_intents, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
    }
  });

  it('compiled foreign canonical pointer refuses PreToolUse without mutation, attestation, or role-intent authorization', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-foreign-'));
    const home = await mkdtemp(join(tmpdir(), 'omx-3181-home-foreign-'));
    const codexHome = await mkdtemp(join(tmpdir(), 'omx-3181-codex-home-foreign-'));
    const canonicalNativeSessionId = 'codex-native-canonical-a';
    const foreignNativeSessionId = 'codex-native-foreign-b';
    const environment = {
      ...buildHermeticChildEnvironment(home, codexHome),
      ...await installAuthenticatedAuthority(cwd, canonicalNativeSessionId),
    };
    try {
      assert.equal(runCompiled(cwd, environment, 'scripts/codex-native-hook.js', [], {
        hook_event_name: 'SessionStart', cwd, session_id: canonicalNativeSessionId,
      }).status, 0);
      const pointerPath = join(cwd, '.omx', 'state', 'session.json');
      const pointerBefore = await readFile(pointerPath);
      const trackerBefore = await readSubagentTrackingState(cwd);

      Object.assign(environment, await refreshAuthenticatedAuthority(cwd, canonicalNativeSessionId, environment));
      const preToolUse = runCompiled(cwd, environment, 'scripts/codex-native-hook.js', [], {
        hook_event_name: 'PreToolUse',
        cwd,
        session_id: foreignNativeSessionId,
        thread_id: foreignNativeSessionId,
        tool_name: 'Bash',
        tool_use_id: 'tool-foreign-leader',
        tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
      });
      assert.equal(preToolUse.status, 0, String(preToolUse.stderr));
      assert.deepEqual(await readFile(pointerPath), pointerBefore, 'foreign PreToolUse must not replace or mutate the canonical pointer');
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions[foreignNativeSessionId]?.leader_attested_at, undefined);
      assert.deepEqual(state.pending_role_intents, []);
      assert.deepEqual(state, trackerBefore, 'foreign PreToolUse must not add an A or B attestation or role intent');

      Object.assign(environment, await installAuthenticatedAuthority(cwd, canonicalNativeSessionId));
      const cli = runCompiled(cwd, environment, 'cli/omx.js', [
        'ralplan', 'role-intent', 'write', '--role', 'architect', '--parent-thread', foreignNativeSessionId, '--json',
      ]);
      assert.notEqual(cli.status, 0, 'foreign native thread must not authorize the actual CLI');
      assert.deepEqual(JSON.parse(String(cli.stdout)), { ok: false, reason: 'parent_not_active_leader' });
      assert.deepEqual(await readSubagentTrackingState(cwd), trackerBefore, 'foreign CLI denial must preserve both-session tracker state');
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await rm(codexHome, { recursive: true, force: true });
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
      for (const [index, threadSpawn] of [
        { parent_thread_id: '' },
        { parent_thread_id: null },
        null,
        '',
        { parent_thread_id: { malformed: true } },
      ].entries()) {
        const childThreadId = `codex-native-malformed-spawn-${index}`;
        await dispatchCodexNativeHook(
          {
            hook_event_name: 'PreToolUse',
            cwd,
            session_id: childThreadId,
            thread_id: childThreadId,
            tool_name: 'Bash',
            tool_use_id: `tool-malformed-spawn-${index}`,
            source: { subagent: { thread_spawn: threadSpawn } },
            tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
          },
          { cwd, sessionOwnerPid: process.pid },
        );
        const state = await readSubagentTrackingState(cwd);
        assert.equal(state.sessions[childThreadId]?.leader_attested_at, undefined, `thread_spawn variant ${index} must not attest as leader`);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'session.json')), false, `thread_spawn variant ${index} must not bootstrap a pointer`);
      }
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
  it('rejects conflicting thread carriers and every nonempty direct or nested role alias at the leader-attestation boundary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-conflicting-carriers-'));
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      const malformedRoleCarrierValues: unknown[] = [{ malformed: true }, [], 1, true, null];
      const variants: Record<string, unknown>[] = [
        { threadId: 'conflicting-thread' },
        { owner_codex_thread_id: 'conflicting-owner' },
        { agent_role: 'architect' },
        { agentRole: 'architect' },
        { agent_type: 'architect' },
        { agentType: 'architect' },
        { source: { subagent: { agentRole: 'architect' } } },
        { source: { subagent: { thread_spawn: { agentType: 'architect' } } } },
        ...malformedRoleCarrierValues.flatMap((agent_role) => [
          { agent_role },
          { source: { subagent: { agent_role } } },
          { source: { subagent: { thread_spawn: { agent_role } } } },
        ]),
      ];
      for (const [index, variant] of variants.entries()) {
        const nativeSessionId = `codex-native-conflicting-${index}`;
        await dispatchCodexNativeHook({
          hook_event_name: 'PreToolUse', cwd, session_id: nativeSessionId, thread_id: nativeSessionId,
          tool_name: 'Bash', tool_use_id: `tool-conflicting-${index}`,
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
          ...variant,
        }, { cwd, sessionOwnerPid: process.pid });
        const state = await readSubagentTrackingState(cwd);
        assert.equal(state.sessions[nativeSessionId]?.leader_attested_at, undefined, `carrier variant ${index} must not attest`);
        assert.deepEqual(state.pending_role_intents, [], `carrier variant ${index} must not bootstrap a role intent`);
        assert.equal(existsSync(join(cwd, '.omx', 'state', 'session.json')), false, `carrier variant ${index} must not bootstrap a pointer`);
      }
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it('preserves canonical-pointer bytes when its native binding is missing, blank, or malformed', async () => {
    const priorEnv = { OMX_SESSION_ID: process.env.OMX_SESSION_ID, CODEX_SESSION_ID: process.env.CODEX_SESSION_ID, SESSION_ID: process.env.SESSION_ID };
    const root = await mkdtemp(join(tmpdir(), 'omx-3181-e2e-invalid-binding-'));
    try {
      delete process.env.OMX_SESSION_ID;
      delete process.env.CODEX_SESSION_ID;
      delete process.env.SESSION_ID;
      for (const [index, nativeBinding] of [undefined, '', { malformed: true }].entries()) {
        const cwd = join(root, String(index));
        const nativeSessionId = `codex-native-invalid-binding-${index}`;
        Object.assign(process.env, await installAuthenticatedAuthority(cwd, nativeSessionId));
        await dispatchCodexNativeHook({ hook_event_name: 'SessionStart', cwd, session_id: nativeSessionId }, { cwd, sessionOwnerPid: process.pid });
        const pointerPath = join(cwd, '.omx', 'state', 'session.json');
        const pointer = JSON.parse(String(await readFile(pointerPath))) as Record<string, unknown>;
        if (nativeBinding === undefined) delete pointer.native_session_id;
        else pointer.native_session_id = nativeBinding;
        const invalidBytes = Buffer.from(`${JSON.stringify(pointer)}\n`);
        await writeFile(pointerPath, invalidBytes);
        await dispatchCodexNativeHook({
          hook_event_name: 'PreToolUse', cwd, session_id: nativeSessionId, thread_id: nativeSessionId,
          tool_name: 'Bash', tool_use_id: `tool-invalid-binding-${index}`,
          tool_input: { command: 'omx ralplan role-intent write --role architect --parent-thread "$CODEX_THREAD_ID" --json' },
        }, { cwd, sessionOwnerPid: process.pid });
        assert.deepEqual(await readFile(pointerPath), invalidBytes, `invalid native binding variant ${index} must be byte-preserved`);
        assert.equal((await readSubagentTrackingState(cwd)).sessions[nativeSessionId]?.leader_attested_at, undefined);
      }
    } finally {
      if (priorEnv.OMX_SESSION_ID !== undefined) process.env.OMX_SESSION_ID = priorEnv.OMX_SESSION_ID;
      if (priorEnv.CODEX_SESSION_ID !== undefined) process.env.CODEX_SESSION_ID = priorEnv.CODEX_SESSION_ID;
      if (priorEnv.SESSION_ID !== undefined) process.env.SESSION_ID = priorEnv.SESSION_ID;
      await rm(root, { recursive: true, force: true });
    }
  });
});
