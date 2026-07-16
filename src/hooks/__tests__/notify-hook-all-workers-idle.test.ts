import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearTeamTestAuthority, hardenTestAuthorityTreeSync, installTeamTestAuthority } from '../../team/__tests__/authority-fixture.js';

const NOTIFY_HOOK_SCRIPT = new URL('../../../dist/scripts/notify-hook.js', import.meta.url);

async function withTempWorkingDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-notify-all-idle-'));
  try {
    await installTeamTestAuthority(cwd, 'notify-hook-all-workers-idle');
    await run(cwd);
  } finally {
    clearTeamTestAuthority();
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const persisted = /(?:config|manifest\.v2|heartbeat)\.json$/.test(path) && value && typeof value === 'object'
    ? {
        session_id: 'notify-hook-all-workers-idle',
        owner_session_id: 'notify-hook-all-workers-idle',
        ...value as Record<string, unknown>,
      }
    : value;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(persisted, null, 2));
  if (path.endsWith('status.json') && persisted && typeof persisted === 'object') {
    const status = persisted as { updated_at?: unknown };
    await writeFile(join(path, '..', 'heartbeat.json'), JSON.stringify({
      pid: process.pid,
      last_turn_at: typeof status.updated_at === 'string' ? status.updated_at : new Date().toISOString(),
      turn_count: 1,
      alive: true,
      session_id: 'notify-hook-all-workers-idle',
    }, null, 2));
  }
  if (path.endsWith('config.json') && persisted && typeof persisted === 'object') {
    const config = persisted as { workers?: unknown[]; tmux_session?: unknown; leader_pane_id?: unknown };
    await writeFile(join(path, '..', 'manifest.v2.json'), JSON.stringify({
      session_id: 'notify-hook-all-workers-idle',
      owner_session_id: 'notify-hook-all-workers-idle',
      leader: {
        session_id: 'notify-hook-all-workers-idle',
        worker_id: 'leader-fixed',
        role: 'coordinator',
      },
      tmux_session: config.tmux_session ?? null,
      leader_pane_id: config.leader_pane_id ?? null,
      workers: config.workers ?? [],
    }, null, 2));
  }
}

function buildFakeTmux(tmuxLogPath: string): string {
  return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  if [[ "\${@: -1}" == "#{session_name}\t#{pane_id}\t#{pane_pid}" ]]; then
    target=""
    while (($#)); do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'fixture-session\t%s\t12345\n' "$target"
  fi
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
}

function writeWorkerIdentityFixture(cwd: string, workerEnv: string): string {
  const [teamName, workerName] = workerEnv.split('/');
  assert.ok(teamName, 'worker env fixture should include a team name');
  assert.ok(workerName, 'worker env fixture should include a worker name');

  const stateRoot = join(cwd, '.omx', 'state');
  const workerDir = join(stateRoot, 'team', teamName, 'workers', workerName);
  const identityPath = join(workerDir, 'identity.json');
  if (!existsSync(identityPath)) {
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(identityPath, JSON.stringify({
      name: workerName,
      index: Number(workerName.replace(/^worker-/, '')) || 1,
      role: 'executor',
      assigned_tasks: [],
      worktree_path: cwd,
      team_state_root: stateRoot,
      session_id: 'notify-hook-all-workers-idle',
      owner_session_id: 'notify-hook-all-workers-idle',
    }, null, 2));
  }
  const manifestPath = join(stateRoot, 'team', teamName, 'manifest.v2.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { workers?: Array<Record<string, unknown>> };
    const workerIdentity = JSON.parse(readFileSync(identityPath, 'utf8')) as Record<string, unknown>;
    manifest.workers = [
      ...(manifest.workers ?? []).filter((candidate) => candidate.name !== workerName),
      {
        name: workerName,
        index: workerIdentity.index,
        role: workerIdentity.role,
        assigned_tasks: workerIdentity.assigned_tasks,
      },
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return stateRoot;
}

function runNotifyHookAsWorker(
  cwd: string,
  fakeBinDir: string,
  workerEnv: string,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  const stateRoot = writeWorkerIdentityFixture(cwd, workerEnv);
  hardenTestAuthorityTreeSync(cwd);
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    'thread-id': 'thread-worker',
    'turn-id': `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    'input-messages': ['working'],
    'last-assistant-message': 'task done',
  };

  return spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      OMX_TEST_TMUX_BIN: join(fakeBinDir, 'tmux'),
      OMX_TEAM_WORKER: workerEnv,
      OMX_TEAM_STATE_ROOT: stateRoot,
      OMX_TEAM_LEADER_CWD: '',
      OMX_MODEL_INSTRUCTIONS_FILE: '',
      OMX_TEAM_WORKER_IDLE_NOTIFY: 'false',
      OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '500', // short cooldown for tests
      TMUX: '',
      TMUX_PANE: '',
      ...extraEnv,
    },
  });
}

describe('notify-hook all-workers-idle notification', () => {
  it('sends notification to leader when all workers are idle', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'myteam';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      // Team config with 2 workers
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      // Both workers are idle
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /send-keys -t .*devsess:0/, 'must not inject to session when leader pane is missing');
      }

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist after deferred notification');
      const eventsContent = await readFile(eventsPath, 'utf-8');
      const events = eventsContent.trim().split('\n').map(line => JSON.parse(line));
      const deferredEvent = events.find((e: { type: string; reason?: string }) =>
        e.type === 'leader_notification_deferred' && e.reason === 'leader_pane_missing_no_injection');
      assert.ok(deferredEvent, 'should emit leader_notification_deferred with missing-pane reason');
      assert.equal(deferredEvent.to_worker, 'leader-fixed');
      assert.equal(deferredEvent.source_type, 'all_workers_idle');
      assert.equal(deferredEvent.tmux_session, 'devsess:0');
      assert.equal(deferredEvent.leader_pane_id, null);
      assert.equal(deferredEvent.tmux_injection_attempted, false);

      const idleStatePath = join(teamDir, 'all-workers-idle.json');
      assert.ok(existsSync(idleStatePath), 'cooldown state should be written even for deferred delivery');
      const idleState = JSON.parse(await readFile(idleStatePath, 'utf-8'));
      assert.equal(idleState.delivery, 'deferred');
      assert.equal(idleState.worker_count, 2);

      const logPath = join(logsDir, `tmux-hook-${new Date().toISOString().split('T')[0]}.jsonl`);
      assert.ok(existsSync(logPath), 'tmux hook log should exist');
      const logLines = (await readFile(logPath, 'utf-8')).trim().split('\n').filter(Boolean);
      const warn = logLines
        .map((line) => JSON.parse(line))
        .find((entry: { type?: string; reason?: string }) =>
          entry.type === 'leader_notification_deferred' && entry.reason === 'leader_pane_missing_no_injection');
      assert.ok(warn, 'should log leader_notification_deferred warning');
      assert.equal(warn.source_type, 'all_workers_idle');
      assert.equal(warn.tmux_injection_attempted, false);
    });
  });

  it('writes deferred visibility once per cooldown window when leader pane is missing', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'missing-pane-repeat';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:11',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: new Date().toISOString(),
        });
      }

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const first = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, { OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '600000' });
      assert.equal(first.status, 0, `notify-hook failed: ${first.stderr || first.stdout}`);
      const second = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, { OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '600000' });
      assert.equal(second.status, 0, `notify-hook failed: ${second.stderr || second.stdout}`);

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferredEvents = events.filter((event: { type?: string; reason?: string }) =>
        event.type === 'leader_notification_deferred' && event.reason === 'leader_pane_missing_no_injection');
      assert.equal(deferredEvents.length, 1, 'cooldown should bound repeated deferred all-workers-idle artifacts');
    });
  });


  it('does not inject all-workers-idle into a shell leader pane', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'shell-pane-all-idle';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:81',
        leader_pane_id: '%181',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: new Date().toISOString(),
        });
      }

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%181" ]]; then
    echo "zsh"
    exit 0
  fi
  if [[ "$format" == "#{session_name}\t#{pane_id}\t#{pane_pid}" && "$target" == "%181" ]]; then
    printf 'shell-pane-all-idle\t%%181\t12345\n'
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /display-message -p -t %181 #\{pane_current_command\}/);
      assert.doesNotMatch(tmuxLog, /send-keys -t %181/, 'must not inject into shell pane');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist');
      const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const deferred = events.find((event: { type?: string; reason?: string }) =>
        event.type === 'leader_notification_deferred' && event.reason === 'leader_pane_shell_no_injection');
      assert.ok(deferred, 'should defer shell-pane all-workers-idle notification');
      assert.equal(deferred.pane_current_command, 'zsh');

      const idleState = JSON.parse(await readFile(join(teamDir, 'all-workers-idle.json'), 'utf-8'));
      assert.equal(idleState.delivery, 'deferred_shell');
      assert.equal(idleState.pane_current_command, 'zsh');
    });
  });

  it('injects all-workers-idle notification even while the leader pane has an active task', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'busy-leader-all-idle';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'busy-all-idle:0',
        leader_pane_id: '%182',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      for (const worker of ['worker-1', 'worker-2']) {
        await mkdir(join(workersDir, worker), { recursive: true });
        await writeJson(join(workersDir, worker, 'status.json'), {
          state: 'idle',
          updated_at: new Date().toISOString(),
        });
      }

      const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%182" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%182" ]]; then
    echo "codex"
    exit 0
  fi
  if [[ "$format" == "#{session_name}\t#{pane_id}\t#{pane_pid}" && "$target" == "%182" ]]; then
    printf 'busy-leader-all-idle\t%%182\t12345\n'
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "• Running tests (1m 05s • esc to interrupt)\\n"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
      await writeFile(fakeTmuxPath, fakeTmux);
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /capture-pane/, 'busy-pane reminders should still inspect pane state');
      assert.match(tmuxLog, /send-keys -t %182/, 'all-workers-idle reminder should still inject into a busy leader pane');

      const eventsPath = join(teamDir, 'events', 'events.ndjson');
      if (existsSync(eventsPath)) {
        const events = (await readFile(eventsPath, 'utf-8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const deferred = events.find((entry: { type?: string; reason?: string }) =>
          entry.type === 'leader_notification_deferred' && entry.reason === 'pane_has_active_task');
        assert.equal(deferred, undefined, 'busy leader panes must not suppress all-workers-idle reminders');
      }
    });
  });

  it('targets leader pane id when leader_pane_id is present', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'pane-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:8',
        leader_pane_id: '%99',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /-t %99/, 'should target leader pane when available');
      assert.doesNotMatch(tmuxLog, /-t devsess:8/, 'should not target session when leader pane is available');
    });
  });

  it('does not notify when some workers are still working', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'busy-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      // worker-1 is idle, worker-2 is still working
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'working',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      // Should not send the all-workers-idle notification
      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'should NOT send all-idle message when some workers are busy');
      }
    });
  });

  it('does not notify when a worker heartbeat is stale', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'stale-heartbeat';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:0',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-1', 'heartbeat.json'), {
        pid: 123,
        last_turn_at: new Date().toISOString(),
        turn_count: 1,
        alive: true,
      });

      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeJson(join(workersDir, 'worker-2', 'heartbeat.json'), {
        pid: 456,
        last_turn_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        turn_count: 1,
        alive: true,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'stale heartbeat should suppress all-workers-idle notification');
      }
    });
  });

  it('does not notify when current worker is not idle', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'active-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:1',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      // worker-1 is working (not idle) - should not trigger
      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'working',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/);
      }
    });
  });

  it('respects cooldown: does not send repeated notifications', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'cooldown-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:2',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      // Pre-populate cooldown state with a recent notification
      await writeJson(join(teamDir, 'all-workers-idle.json'), {
        last_notified_at_ms: Date.now() - 100, // 100ms ago — well within cooldown
        last_notified_at: new Date().toISOString(),
        worker_count: 1,
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      // Use a long cooldown (10 minutes) so the 100ms-old entry blocks the notification
      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`, {
        OMX_TEAM_ALL_IDLE_COOLDOWN_MS: '600000',
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'cooldown should block repeated notification');
      }
    });
  });

  it('writes all_workers_idle event to events.ndjson', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'event-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const eventsDir = join(teamDir, 'events');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(eventsDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'omx-team-event',
        leader_pane_id: '%77',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
          { name: 'worker-2', index: 2, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await mkdir(join(workersDir, 'worker-2'), { recursive: true });
      await writeJson(join(workersDir, 'worker-2', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      const eventsPath = join(eventsDir, 'events.ndjson');
      assert.ok(existsSync(eventsPath), 'events.ndjson should exist after notification');
      const content = await readFile(eventsPath, 'utf-8');
      const events = content.trim().split('\n').map(line => JSON.parse(line));
      const idleEvent = events.find((e: { type: string; orchestration_intent?: string }) => e.type === 'all_workers_idle');
      assert.ok(idleEvent, 'should have an all_workers_idle event');
      assert.equal(idleEvent.team, teamName);
      assert.equal(idleEvent.worker, 'worker-1');
      assert.equal(idleEvent.worker_count, 2);
      assert.equal(idleEvent.orchestration_intent, 'done-review-or-shutdown');
      assert.ok(idleEvent.event_id, 'event should have an event_id');
      assert.ok(idleEvent.created_at, 'event should have a created_at timestamp');

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/);
    });
  });

  it('does not fire for leader (non-team-worker) context', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'leader-test';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'devsess:3',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      // Run as LEADER (no OMX_TEAM_WORKER env var)
      const payload = {
        cwd,
        type: 'agent-turn-complete',
        'thread-id': 'thread-leader',
        'turn-id': `turn-${Date.now()}`,
        'input-messages': ['leader turn'],
        'last-assistant-message': 'done',
      };
      const result = spawnSync(process.execPath, [NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
          OMX_TEAM_WORKER: '', // empty = not a worker
          OMX_TEAM_STATE_ROOT: '',
          OMX_TEAM_LEADER_CWD: '',
          OMX_MODEL_INSTRUCTIONS_FILE: '',
          TMUX: '',
          TMUX_PANE: '',
        },
      });
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      if (existsSync(tmuxLogPath)) {
        const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
        assert.doesNotMatch(tmuxLog, /\[OMX\] All .* idle/, 'leader context should not send all-idle notification');
      }
    });
  });

  it('handles single worker team correctly with singular message', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'solo-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });

      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'solo-session:0',
        leader_pane_id: '%13',
        workers: [
          { name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] },
        ],
      });

      await mkdir(join(workersDir, 'worker-1'), { recursive: true });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });

      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);

      assert.ok(existsSync(tmuxLogPath), 'tmux should have been called');
      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /\[OMX\] All 1 worker idle/, 'single worker uses singular form');
      assert.match(tmuxLog, /Run `omx team status solo-team` now, read unread worker messages, then assign the next concrete task, reconcile results, or shut the team down/, 'all-workers-idle notification should tell the agent to execute the runtime status check directly');
      assert.doesNotMatch(tmuxLog, /Next: run omx team status solo-team, read unread worker messages, then decide whether to assign the next concrete task, reconcile results, or shut the team down/, 'all-workers-idle notification should not fall back to human-advisory wording');
      assert.doesNotMatch(tmuxLog, /All 1 workers idle/, 'should not use plural for single worker');
    });
  });

  it('denies conflicting config.json and manifest.v2.json leader targets', async () => {
    await withTempWorkingDir(async (cwd) => {
      const omxDir = join(cwd, '.omx');
      const stateDir = join(omxDir, 'state');
      const logsDir = join(omxDir, 'logs');
      const teamName = 'manifest-team';
      const teamDir = join(stateDir, 'team', teamName);
      const workersDir = join(teamDir, 'workers');
      const fakeBinDir = join(cwd, 'fake-bin');
      const fakeTmuxPath = join(fakeBinDir, 'tmux');
      const tmuxLogPath = join(cwd, 'tmux.log');

      await mkdir(logsDir, { recursive: true });
      await mkdir(workersDir, { recursive: true });
      await mkdir(fakeBinDir, { recursive: true });
      await writeJson(join(teamDir, 'config.json'), {
        name: teamName,
        tmux_session: 'wrong-session:0',
        leader_pane_id: '%122',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });
      await writeJson(join(teamDir, 'manifest.v2.json'), {
        schema_version: 2,
        name: teamName,
        tmux_session: 'correct-session:1',
        leader_pane_id: '%123',
        workers: [{ name: 'worker-1', index: 1, role: 'executor', assigned_tasks: [] }],
      });
      await writeJson(join(workersDir, 'worker-1', 'status.json'), {
        state: 'idle',
        updated_at: new Date().toISOString(),
      });
      await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
      await chmod(fakeTmuxPath, 0o755);

      const result = runNotifyHookAsWorker(cwd, fakeBinDir, `${teamName}/worker-1`);
      assert.equal(result.status, 0, `notify-hook failed: ${result.stderr || result.stdout}`);
      assert.equal(existsSync(tmuxLogPath), false, 'conflicting targets must not reach tmux');
      assert.equal(existsSync(join(teamDir, 'all-workers-idle.json')), false, 'conflicting targets must not write delivery state');
    });
  });
});
