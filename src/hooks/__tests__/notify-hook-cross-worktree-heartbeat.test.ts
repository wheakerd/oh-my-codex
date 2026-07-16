import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import { hardenTestAuthorityTreeSync } from '../../team/__tests__/authority-fixture.js';
import { writeSessionStart } from '../session.js';

function withoutAmbientStateSelection(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.OMX_ROOT;
  delete sanitized.OMX_STATE_ROOT;
  delete sanitized.OMX_TEAM_STATE_ROOT;
  return sanitized;
}

async function persistLeaderTeamMetadata({
  leaderCwd,
  teamStateRoot,
  teamName,
  workerName,
  workerCwd,
  sessionId,
}: {
  leaderCwd: string;
  teamStateRoot: string;
  teamName: string;
  workerName: string;
  workerCwd: string;
  sessionId: string;
}): Promise<void> {
  const teamRoot = join(teamStateRoot, 'team', teamName);
  const worker = {
    name: workerName,
    index: 1,
    role: 'executor',
    assigned_tasks: [],
    worktree_path: workerCwd,
    team_state_root: teamStateRoot,
    session_id: sessionId,
    owner_session_id: sessionId,
  };
  await mkdir(join(teamRoot, 'workers', workerName), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(teamRoot, 'workers', workerName, 'identity.json'), JSON.stringify(worker, null, 2)),
    writeFile(join(teamRoot, 'config.json'), JSON.stringify({
      name: teamName,
      session_id: sessionId,
      owner_session_id: sessionId,
      leader_cwd: leaderCwd,
      team_state_root: teamStateRoot,
      workers: [worker],
    }, null, 2)),
    writeFile(join(teamRoot, 'manifest.v2.json'), JSON.stringify({
      version: 2,
      session_id: sessionId,
      owner_session_id: sessionId,
      leader: { session_id: sessionId, worker_id: 'leader-fixed', role: 'coordinator' },
      name: teamName,
      leader_cwd: leaderCwd,
      team_state_root: teamStateRoot,
      workers: [worker],
    }, null, 2)),
  ]);
}

async function createFixtureAuthority(cwd: string, sessionId: string) {
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true, mode: 0o700 });
  hardenTestAuthorityTreeSync(cwd);
  await writeFile(join(cwd, '.omx', 'managed'), 'test fixture managed workspace');
  await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `notify-cross-worktree-${sessionId}-${Date.now()}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await writeSessionStart(cwd, sessionId, { pid: process.pid });
  const refreshedAuthority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: sessionId,
  });
  await mintStateAuthorityTransportCapability(refreshedAuthority);
  hardenTestAuthorityTreeSync(cwd);
  return {
    authority: refreshedAuthority,
    env: Object.fromEntries(Object.entries(withoutAmbientStateSelection(buildStateAuthorityTransportEnv(refreshedAuthority, { OMX_SESSION_ID: sessionId }))).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  };
}

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

async function withTempDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-cross-worktree-'));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function runWorkerNotify(
  payloadCwd: string,
  teamWorker: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const payload = {
    cwd: payloadCwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-cross-worktree',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'input-messages': ['worktree heartbeat'],
    'last-assistant-message': 'heartbeat',
  };

  const inheritedEnv: NodeJS.ProcessEnv = {
    ...withoutAmbientStateSelection(process.env),
    OMX_TEAM_WORKER: teamWorker,
    TMUX: '',
    TMUX_PANE: '',
  };
  if (!Object.prototype.hasOwnProperty.call(extraEnv, 'OMX_TEAM_LEADER_CWD')) {
    delete inheritedEnv.OMX_TEAM_LEADER_CWD;
  }

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: { ...inheritedEnv, ...extraEnv },
  });
}

describe('notify-hook cross-worktree heartbeat resolution', () => {
  it('logs only the latest user input preview instead of concatenating prior inputs', async () => {
    await withTempDir(async (root) => {
      const cwd = join(root, 'latest-input-preview');
      await mkdir(join(cwd, '.omx', 'logs'), { recursive: true, mode: 0o700 });
      const fixture = await createFixtureAuthority(cwd, 'thread-latest-preview');
      const sessionStateRoot = join(fixture.authority.canonical_state_root, 'sessions', 'thread-latest-preview');
      await mkdir(sessionStateRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(cwd, '.omx', 'managed'), 'test fixture managed workspace');
      await writeFile(join(sessionStateRoot, 'session.json'), JSON.stringify({ session_id: 'thread-latest-preview' }));
      hardenTestAuthorityTreeSync(cwd);

      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-latest-preview',
        session_id: 'thread-latest-preview',
        'turn-id': 'turn-latest-preview',
        'input-messages': ['上一轮 query', '本轮 query'],
        'last-assistant-message': 'ok',
      };

      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: { ...withoutAmbientStateSelection(process.env), ...fixture.env, TMUX: '', TMUX_PANE: '' },
      });

      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
      const turnLogPath = join(cwd, '.omx', 'logs', `turns-${new Date().toISOString().split('T')[0]}.jsonl`);
      const lines = (await readFile(turnLogPath, 'utf8')).trim().split('\n');
      const entry = JSON.parse(lines[lines.length - 1]) as {
        input_preview?: string;
        input_message_count?: number;
      };
      assert.equal(entry.input_preview, '本轮 query');
      assert.equal(entry.input_message_count, 2);
    });
  });

  it('fails closed when payload cwd is an unrelated workspace despite inherited authority', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const workerCwd = join(root, 'worker-worktree');
      const teamName = 'cross-root';
      const workerName = 'worker-1';

      const fixture = await createFixtureAuthority(leaderCwd, 'cross-root-authority');
      const leaderStateRoot = fixture.authority.canonical_state_root;
      const leaderWorkerDir = join(leaderStateRoot, 'team', teamName, 'workers', workerName);
      await mkdir(workerCwd, { recursive: true });
      await mkdir(join(workerCwd, '.omx'), { recursive: true, mode: 0o700 });
      await writeFile(join(workerCwd, '.omx', 'managed'), 'test fixture managed worker');
      await persistLeaderTeamMetadata({
        leaderCwd,
        teamStateRoot: leaderStateRoot,
        teamName,
        workerName,
        workerCwd,
        sessionId: 'cross-root-authority',
      });
      hardenTestAuthorityTreeSync(leaderCwd);

      const result = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, { ...fixture.env, OMX_TEAM_LEADER_CWD: leaderCwd });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), false, 'unrelated worker cwd must not inherit mutation authority');

      const wrongHeartbeatPath = join(workerCwd, '.omx', 'state', 'team', teamName, 'workers', workerName, 'heartbeat.json');
      assert.equal(existsSync(wrongHeartbeatPath), false, 'heartbeat should not be written under worker cwd state root');
    });
  });

  it('keeps leader-owned heartbeat state when worker cwd uses the team worktree layout', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const teamName = 'cross-team-layout';
      const workerName = 'worker-1';
      const workerCwd = join(leaderCwd, '.omx', 'team', teamName, 'worktrees', workerName);

      const fixture = await createFixtureAuthority(leaderCwd, 'cross-team-layout-authority');
      const leaderStateRoot = fixture.authority.canonical_state_root;
      const leaderWorkerDir = join(leaderStateRoot, 'team', teamName, 'workers', workerName);
      await mkdir(workerCwd, { recursive: true });
      await mkdir(join(workerCwd, '.omx'), { recursive: true, mode: 0o700 });
      await writeFile(join(workerCwd, '.omx', 'managed'), 'test fixture managed worker');
      await persistLeaderTeamMetadata({
        leaderCwd,
        teamStateRoot: leaderStateRoot,
        teamName,
        workerName,
        workerCwd,
        sessionId: 'cross-team-layout-authority',
      });
      hardenTestAuthorityTreeSync(leaderCwd);

      const firstResult = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, { ...fixture.env, OMX_TEAM_LEADER_CWD: leaderCwd });
      assert.equal(firstResult.status, 0, `notify-hook failed: ${firstResult.stderr || firstResult.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), true, `heartbeat should still resolve to leader-owned team state: ${firstResult.stderr || firstResult.stdout}`);
      const firstHeartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')) as { turn_count?: number };
      assert.equal(firstHeartbeat.turn_count, 1, 'first authenticated worker turn must persist heartbeat increment');

      const secondResult = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, { ...fixture.env, OMX_TEAM_LEADER_CWD: leaderCwd });
      assert.equal(secondResult.status, 0, `notify-hook failed: ${secondResult.stderr || secondResult.stdout}`);
      const secondHeartbeat = JSON.parse(await readFile(heartbeatPath, 'utf8')) as { turn_count?: number };
      assert.equal(secondHeartbeat.turn_count, 2, 'second authenticated worker turn must increment persisted heartbeat');
      assert.equal(existsSync(heartbeatPath), true, 'heartbeat should still resolve to leader-owned team state');

      const wrongHeartbeatPath = join(workerCwd, '.omx', 'state', 'team', teamName, 'workers', workerName, 'heartbeat.json');
      assert.equal(existsSync(wrongHeartbeatPath), false, 'team worktree cwd should not become the authoritative team state root');
    });
  });

  it('does not authorize heartbeat mutation from worker identity/config metadata alone', async () => {
    await withTempDir(async (root) => {
      const leaderCwd = join(root, 'leader');
      const workerCwd = join(root, 'worker-worktree');
      const teamName = 'cross-meta';
      const workerName = 'worker-1';
      const fixture = await createFixtureAuthority(leaderCwd, 'cross-meta-authority');
      const teamStateRoot = fixture.authority.canonical_state_root;
      const leaderWorkerDir = join(teamStateRoot, 'team', teamName, 'workers', workerName);
      await mkdir(workerCwd, { recursive: true });
      await mkdir(join(workerCwd, '.omx'), { recursive: true, mode: 0o700 });
      await writeFile(join(workerCwd, '.omx', 'managed'), 'test fixture managed worker');
      await persistLeaderTeamMetadata({
        leaderCwd,
        teamStateRoot,
        teamName,
        workerName,
        workerCwd,
        sessionId: 'cross-meta-authority',
      });
      hardenTestAuthorityTreeSync(leaderCwd);

      const result = runWorkerNotify(workerCwd, `${teamName}/${workerName}`, {
        ...fixture.env,
        OMX_TEAM_LEADER_CWD: leaderCwd,
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const heartbeatPath = join(leaderWorkerDir, 'heartbeat.json');
      assert.equal(existsSync(heartbeatPath), false, 'metadata alone must not authorize leader-owned heartbeat mutation');
    });
  });
});
