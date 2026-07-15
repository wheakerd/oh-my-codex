import { afterEach, beforeEach, describe, it } from 'node:test';

import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  AUTHORITY_DIAGNOSTIC_CODES,
  initializeStateAuthority,
  resolveStateAuthorityForGuard,
  StateAuthorityError,
} from '../../state/authority.js';

const isolatedEnvKeys = [
  'OMX_MCP_WORKDIR_ROOTS',
  'OMX_STATE_SERVER_DISABLE_AUTO_START',
  'OMX_AUTHORITY_MODULE_URL',
  'OMX_AUTHORITY_WORKSPACE',
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
  'OMX_STARTUP_CWD',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;

const originalEnv = Object.fromEntries(
  isolatedEnvKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof isolatedEnvKeys)[number], string | undefined>;

beforeEach(() => {
  for (const key of isolatedEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of isolatedEnvKeys) {
    const value = originalEnv[key];
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
});

const COMMITTED_TEST_OWNER_SESSION_ID = 'state-server-test-owner';

async function secureTestAuthorityDirectories(workingDirectory: string): Promise<void> {
  const omxRoot = join(workingDirectory, '.omx');
  const stateRoot = join(omxRoot, 'state');
  const sessionsRoot = join(stateRoot, 'sessions');
  const directories = [
    omxRoot,
    join(omxRoot, 'bootstrap'),
    stateRoot,
    join(stateRoot, 'authority'),
    sessionsRoot,
  ];
  for (const directory of directories) {
    if (existsSync(directory)) await chmod(directory, 0o700);
  }
  if (existsSync(sessionsRoot)) {
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) await chmod(join(sessionsRoot, entry.name), 0o700);
    }
  }
}

function committedTestOwnerStateDir(workingDirectory: string): string {
  return join(workingDirectory, '.omx', 'state', 'sessions', COMMITTED_TEST_OWNER_SESSION_ID);
}

const stateServerAuthorityInitByWorkspace = new Map<string, Promise<void>>();

async function ensureTestStateServerAuthority(
  workingDirectory: string,
): Promise<void> {
  const canonicalWorkingDirectory = await realpath(workingDirectory);
  const existing = stateServerAuthorityInitByWorkspace.get(canonicalWorkingDirectory);
  if (existing) return existing;
  const initializing = (async () => {
    try {
      await resolveStateAuthorityForGuard({
        startup_cwd: canonicalWorkingDirectory,
        observed_cwd: canonicalWorkingDirectory,
      });
      return;
    } catch (error) {
      if (
        !(error instanceof StateAuthorityError)
        || error.code !== AUTHORITY_DIAGNOSTIC_CODES.anchorMissing
      ) {
        throw error;
      }
    }
    if (existsSync(join(canonicalWorkingDirectory, '.omx', 'state', 'authority'))) {
      throw new Error('state-server test fixture contains authority protocol artifacts without a committed authenticated anchor');
    }

    const stateRoot = join(canonicalWorkingDirectory, '.omx', 'state');
    const stagedStateRoot = join(
      canonicalWorkingDirectory,
      '.omx',
      `.state-before-test-authority-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    const staged = existsSync(stateRoot);
    if (staged) await rename(stateRoot, stagedStateRoot);
    await mkdir(join(canonicalWorkingDirectory, '.omx'), { recursive: true, mode: 0o700 });
    await chmod(join(canonicalWorkingDirectory, '.omx'), 0o700);

    try {
      const requestedSessionId = COMMITTED_TEST_OWNER_SESSION_ID;

      await initializeStateAuthority({
        startup_cwd: canonicalWorkingDirectory,
        observed_cwd: canonicalWorkingDirectory,
        launch_id: `state-server-test-launch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        session_binding: { canonical_session_id: requestedSessionId },
      });
      if (staged) {
        for (const entry of await readdir(stagedStateRoot)) {
          await rename(join(stagedStateRoot, entry), join(stateRoot, entry));
        }
        await rm(stagedStateRoot, { recursive: true, force: true });
      }
      await secureTestAuthorityDirectories(canonicalWorkingDirectory);

    } catch (error) {
      if (staged && existsSync(stagedStateRoot) && !existsSync(stateRoot)) {
        await rename(stagedStateRoot, stateRoot);
      }
      throw error;
    }
  })();
  stateServerAuthorityInitByWorkspace.set(canonicalWorkingDirectory, initializing);
  try {
    await initializing;
  } catch (error) {
    stateServerAuthorityInitByWorkspace.delete(canonicalWorkingDirectory);
    throw error;
  }
}

async function handleStateToolCallWithCommittedAuthority(
  handleStateToolCall: typeof import('../state-server.js').handleStateToolCall,
  request: Parameters<typeof import('../state-server.js').handleStateToolCall>[0],
) {
  const { name, arguments: rawArgs = {} } = request.params;
  if (name === 'state_write' || name === 'state_clear') {
    const workingDirectory = typeof rawArgs.workingDirectory === 'string'
      ? rawArgs.workingDirectory
      : process.cwd();
    await ensureTestStateServerAuthority(workingDirectory);
  }
  return handleStateToolCall(request);
}

async function getTestStateToolCall() {
  const { handleStateToolCall } = await import('../state-server.js');
  return (request: Parameters<typeof handleStateToolCall>[0]) =>
    handleStateToolCallWithCommittedAuthority(handleStateToolCall, request);
}

async function withAmbientTmuxEnv<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const previousTmux = process.env.TMUX;
  const previousTmuxPane = process.env.TMUX_PANE;
  const previousPath = process.env.PATH;

  if (typeof env.TMUX === 'string') process.env.TMUX = env.TMUX;
  else delete process.env.TMUX;
  if (typeof env.TMUX_PANE === 'string') process.env.TMUX_PANE = env.TMUX_PANE;
  else delete process.env.TMUX_PANE;
  if (typeof env.PATH === 'string') process.env.PATH = env.PATH;
  else if ('PATH' in env) delete process.env.PATH;

  try {
    return await run();
  } finally {
    if (typeof previousTmux === 'string') process.env.TMUX = previousTmux;
    else delete process.env.TMUX;
    if (typeof previousTmuxPane === 'string') process.env.TMUX_PANE = previousTmuxPane;
    else delete process.env.TMUX_PANE;
    if (typeof previousPath === 'string') process.env.PATH = previousPath;
    else delete process.env.PATH;
  }
}

async function createFakeTmuxBin(wd: string): Promise<string> {
  const fakeBin = join(wd, 'bin');
  await mkdir(fakeBin, { recursive: true });
  const tmuxPath = join(fakeBin, 'tmux');
  await writeFile(
    tmuxPath,
    `#!/usr/bin/env bash
set -eu
cmd="\${1:-}"
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
  if [[ -z "$target" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ -z "$target" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#{pane_id}" ]]; then
    echo "%777"
    exit 0
  fi
  if [[ "$target" == "%777" && "$format" == "#S" ]]; then
    echo "maintainer-default"
    exit 0
  fi
fi
if [[ "$cmd" == "list-sessions" ]]; then
  echo "maintainer-default"
  exit 0
fi
exit 1
`,
  );
  await chmod(tmuxPath, 0o755);
  return fakeBin;
}

describe('state-server directory initialization', () => {
  it('keeps read-only state tools side-effect-free without setup', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_list_active',
          arguments: { workingDirectory: wd },
        },
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { active_modes: [] },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects conflicting ambient OMX_ROOT without mutating committed state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const previousOmxRoot = process.env.OMX_ROOT;
    const handleStateToolCall = await getTestStateToolCall();

    const root = await mkdtemp(join(tmpdir(), 'omx-state-server-boxed-'));
    const box = join(root, 'box');
    const wd = join(root, 'source');
    try {
      await mkdir(wd, { recursive: true });
      await ensureTestStateServerAuthority(wd);
      process.env.OMX_ROOT = box;

      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            iteration: 1,
            current_phase: 'executing',
          },
        },
      });

      assert.equal(response.isError, true);
      assert.equal(existsSync(join(committedTestOwnerStateDir(wd), 'ralph-state.json')), false);
      assert.equal(existsSync(join(wd, '.omx', 'tmux-hook.json')), false);
      assert.equal(existsSync(box), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects conflicting ambient OMX_ROOT before tracked-mode or canonical writes', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const handleStateToolCall = await getTestStateToolCall();

    const root = await mkdtemp(join(tmpdir(), 'omx-state-server-boxed-skill-'));
    const box = join(root, 'box');
    const wd = join(root, 'source');
    const sessionId = 'sess-boxed-ralplan';
    try {
      await mkdir(wd, { recursive: true });
      await ensureTestStateServerAuthority(wd);
      process.env.OMX_ROOT = box;
      delete process.env.OMX_STATE_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;

      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(response.isError, true);
      const ownerStateDir = committedTestOwnerStateDir(wd);
      assert.equal(existsSync(join(ownerStateDir, 'ralplan-state.json')), false);
      assert.equal(existsSync(join(ownerStateDir, 'skill-active-state.json')), false);
      assert.equal(existsSync(box), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects conflicting ambient OMX_TEAM_STATE_ROOT without creating state there', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const handleStateToolCall = await getTestStateToolCall();

    const root = await mkdtemp(join(tmpdir(), 'omx-state-server-team-skill-'));
    const teamStateRoot = join(root, 'team-state');
    const wd = join(root, 'source');
    const sessionId = 'sess-team-ralplan';
    try {
      await mkdir(wd, { recursive: true });
      await ensureTestStateServerAuthority(wd);
      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;

      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(response.isError, true);
      const ownerStateDir = committedTestOwnerStateDir(wd);
      assert.equal(existsSync(join(ownerStateDir, 'ralplan-state.json')), false);
      assert.equal(existsSync(join(ownerStateDir, 'skill-active-state.json')), false);
      assert.equal(existsSync(teamStateRoot), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects conflicting ambient OMX_TEAM_STATE_ROOT before workflow transition writes', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const handleStateToolCall = await getTestStateToolCall();

    const root = await mkdtemp(join(tmpdir(), 'omx-state-server-team-transition-'));
    const teamStateRoot = join(root, 'team-state');
    const wd = join(root, 'source');
    const sessionId = 'sess-team-transition';
    try {
      await mkdir(wd, { recursive: true });
      await ensureTestStateServerAuthority(wd);
      delete process.env.OMX_ROOT;
      delete process.env.OMX_STATE_ROOT;
      process.env.OMX_TEAM_STATE_ROOT = teamStateRoot;

      const deepInterview = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: sessionId,
            mode: 'deep-interview',
            active: true,
            current_phase: 'interviewing',
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Requirements are clarified and ready for ralplan consensus.',
            },
          },
        },
      });

      assert.equal(deepInterview.isError, true);
      const ownerStateDir = committedTestOwnerStateDir(wd);
      assert.equal(existsSync(join(ownerStateDir, 'deep-interview-state.json')), false);
      assert.equal(existsSync(join(ownerStateDir, 'ralplan-state.json')), false);
      assert.equal(existsSync(join(ownerStateDir, 'skill-active-state.json')), false);
      assert.equal(existsSync(teamStateRoot), false);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps missing state_read side-effect-free without setup', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-read-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: { workingDirectory: wd, mode: 'deep-interview' },
        },
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { exists: false, mode: 'deep-interview' },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps state_get_status side-effect-free without setup', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-status-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_get_status',
          arguments: { workingDirectory: wd },
        },
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { statuses: {} },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('bootstraps state-tool tmux-hook from the current tmux pane for mutating tools', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-live-'));
    try {
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      const fakeBin = await createFakeTmuxBin(wd);

      await withAmbientTmuxEnv(
        {
          TMUX: '/tmp/maintainer-default,123,0',
          TMUX_PANE: '%777',
          PATH: `${fakeBin}:${process.env.PATH || ''}`,
        },
        async () => {
          const response = await handleStateToolCall({
            params: {
              name: 'state_write',
              arguments: {
                workingDirectory: wd,
                mode: 'deep-interview',
                active: true,
                current_phase: 'deep-interview',
              },
            },
          });
          const payload = JSON.parse(response.content[0]?.text || '{}');
          assert.equal(payload.success, true);
        },
      );

      const tmuxConfig = JSON.parse(await readFile(tmuxHookConfig, 'utf-8')) as {
        target?: { type?: string; value?: string };
      };
      assert.deepEqual(tmuxConfig.target, { type: 'pane', value: '%777' });
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes and reads deep-interview state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const writeResponse = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: true,
            current_phase: 'deep-interview',
            state: {
              current_focus: 'intent',
              threshold: 0.2,
            },
          },
        },
      });

      assert.equal(writeResponse.isError, undefined);
      assert.deepEqual(
        JSON.parse(writeResponse.content[0]?.text || '{}'),
        {
          success: true,
          mode: 'deep-interview',
          path: join(committedTestOwnerStateDir(wd), 'deep-interview-state.json'),

        },
      );

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });

      assert.equal(readResponse.isError, undefined);
      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.active, true);
      assert.equal(readBody.current_phase, 'deep-interview');
      assert.equal(readBody.current_focus, 'intent');
      assert.equal(readBody.threshold, 0.2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts canonical lifecycle_outcome and backfills compatibility run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-'));
    try {
      const writeResponse = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
            active: false,
            lifecycle_outcome: 'askuserQuestion',
            state: {
              current_focus: 'intent',
            },
          },
        },
      });

      assert.equal(writeResponse.isError, undefined);

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'deep-interview',
          },
        },
      });

      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.lifecycle_outcome, 'askuserQuestion');
      assert.equal(readBody.run_outcome, 'blocked_on_user');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('derives canonical lifecycle_outcome from legacy run_outcome when needed', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-run-outcome-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: false,
            run_outcome: 'cancelled',
          },
        },
      });

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
          },
        },
      });

      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.lifecycle_outcome, 'userinterlude');
      assert.equal(readBody.run_outcome, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session-scoped state_get_status side-effect-free when session_id is provided', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionDir = join(wd, '.omx', 'state', 'sessions', 'sess1');
      const tmuxHookConfig = join(wd, '.omx', 'tmux-hook.json');
      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);

      const response = await handleStateToolCall({
        params: {
          name: 'state_get_status',
          arguments: { workingDirectory: wd, session_id: 'sess1' },
        },
      });

      assert.equal(existsSync(stateDir), false);
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(tmuxHookConfig), false);
      assert.deepEqual(
        JSON.parse(response.content[0]?.text || '{}'),
        { statuses: {} },
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('state_write accepts canonical lifecycle_outcome while preserving compatibility run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'autopilot',
            active: false,
            current_phase: 'waiting-for-user-answer',
            lifecycle_outcome: 'askuserQuestion',
          },
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(committedTestOwnerStateDir(wd), 'autopilot-state.json'), 'utf-8')) as {

        active?: boolean;
        lifecycle_outcome?: string;
        terminal_outcome?: string;
        run_outcome?: string;
        completed_at?: string;
      };
      assert.equal(state.active, false);
      assert.equal(state.lifecycle_outcome, 'askuserQuestion');
      assert.equal(state.terminal_outcome, undefined);
      assert.equal(state.run_outcome, 'blocked_on_user');
      assert.ok(state.completed_at);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('state_write lets canonical lifecycle_outcome take precedence over legacy run_outcome', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-lifecycle-precedence-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'autopilot',
            active: false,
            current_phase: 'user-stopped',
            run_outcome: 'failed',
            lifecycle_outcome: 'userinterlude',
          },
        },
      });

      assert.equal(response.isError, undefined);
      const state = JSON.parse(await readFile(join(committedTestOwnerStateDir(wd), 'autopilot-state.json'), 'utf-8')) as {

        lifecycle_outcome?: string;
        run_outcome?: string;
      };
      assert.equal(state.lifecycle_outcome, 'userinterlude');
      assert.equal(state.run_outcome, 'cancelled');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent state_write calls per mode file and preserves merged fields', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-test-'));
    try {
      const writes = Array.from({ length: 16 }, (_, i) => handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            state: { [`k${i}`]: i },
          },
        },
      }));

      const responses = await Promise.all(writes);
      for (const response of responses) {
        assert.equal(response.isError, undefined);
      }

      const filePath = join(committedTestOwnerStateDir(wd), 'team-state.json');

      const state = JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>;
      for (let i = 0; i < 16; i++) {
        assert.equal(state[`k${i}`], i);
      }
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('syncs canonical skill-active state for tracked mode writes and clears', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });

      const canonicalPath = join(committedTestOwnerStateDir(wd), 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{ skill: string; session_id?: string; activated_at?: string; updated_at?: string }>;
      };
      assert.deepEqual(canonical.active_skills, [{
        skill: 'ralph',
        phase: 'executing',
        active: true,
        activated_at: canonical.active_skills?.[0]?.activated_at,
        updated_at: canonical.active_skills?.[0]?.updated_at,
        session_id: COMMITTED_TEST_OWNER_SESSION_ID,
      }]);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralph',
          },
        },
      });

      const clearedCanonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        active_skills?: unknown[];
      };
      assert.equal(clearedCanonical.active, false);
      assert.deepEqual(clearedCanonical.active_skills, []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('writes a session-scoped inactive tombstone when clearing a mode under an active session', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-clear-root-fallback-'));
    try {
      const stateDir = join(wd, '.omx', 'state');
      const sessionId = COMMITTED_TEST_OWNER_SESSION_ID;
      const sessionDir = join(stateDir, 'sessions', sessionId);
      await ensureTestStateServerAuthority(wd);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      await chmod(sessionDir, 0o700);
      await writeFile(
        join(stateDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'legacy-root' }, null, 2),
      );
      await writeFile(
        join(sessionDir, 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'session-active' }, null, 2),
      );

      const clear = await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'deep-interview',
          },
        },
      });
      assert.equal(clear.isError, undefined, JSON.stringify(clear));

      const sessionState = JSON.parse(
        await readFile(join(sessionDir, 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionState.active, false);
      assert.equal(sessionState.current_phase, 'cleared');
      assert.equal(sessionState.session_id, sessionId);

      const listResponse = await handleStateToolCall({
        params: {
          name: 'state_list_active',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
          },
        },
      });
      assert.deepEqual(JSON.parse(listResponse.content[0]?.text || '{}'), { active_modes: [] });

      const readResponse = await handleStateToolCall({
        params: {
          name: 'state_read',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'deep-interview',
          },
        },
      });
      const readBody = JSON.parse(readResponse.content[0]?.text || '{}') as Record<string, unknown>;
      assert.equal(readBody.active, false);
      assert.equal(readBody.current_phase, 'cleared');
      const legacyRootState = JSON.parse(
        await readFile(join(stateDir, 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(legacyRootState.active, true);
      assert.equal(legacyRootState.current_phase, 'legacy-root');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows approved overlaps and preserves the remaining canonical state on clear', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-overlap-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });

      const canonicalPath = join(committedTestOwnerStateDir(wd), 'skill-active-state.json');
      const canonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active_skills?: Array<{ skill: string }>;
      };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team', 'ralph']);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'team',
          },
        },
      });

      const clearedCanonical = JSON.parse(await readFile(canonicalPath, 'utf-8')) as {
        active: boolean;
        skill: string;
        active_skills?: Array<{ skill: string }>;
      };
      assert.equal(clearedCanonical.active, true);
      assert.equal(clearedCanonical.skill, 'ralph');
      assert.deepEqual(clearedCanonical.active_skills?.map((entry) => entry.skill), ['ralph']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('denies unsupported overlaps without writing the requested mode state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-deny-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-deny',
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-deny',
            mode: 'autopilot',
            active: true,
            current_phase: 'ralplan',
          },
        },
      });

      assert.equal(denied.isError, true);
      assert.match(denied.content[0]?.text || '', /Unsupported workflow overlap: team \+ autopilot\./);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'autopilot-state.json')), false);

      const canonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-deny', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string }> };
      assert.deepEqual(canonical.active_skills?.map((entry) => entry.skill), ['team']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ultrawork when canonical session state is stricter than mode files', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-prevalidate-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny'), { recursive: true, mode: 0o700 });
      await secureTestAuthorityDirectories(wd);
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, mode: 'team', current_phase: 'running' }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'state', 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          active_skills: [{ skill: 'team', phase: 'running', active: true }],
        }, null, 2),
      );
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny', 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'team',
          session_id: 'sess-canonical-deny',
          active_skills: [
            { skill: 'team', phase: 'running', active: true },
            { skill: 'ralph', phase: 'executing', active: true, session_id: 'sess-canonical-deny' },
          ],
        }, null, 2),
      );

      const allowed = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-canonical-deny',
            mode: 'ultrawork',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(allowed.isError, undefined);
      assert.equal(
        existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-canonical-deny', 'ultrawork-state.json')),
        true,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('removes tracked workflows from canonical skill-active state on all_sessions clear', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-canonical-clear-all-'));
    try {
      const writeResponse = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      assert.equal(writeResponse.isError, undefined, JSON.stringify(writeResponse));

      const clearResponse = await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'team',
            all_sessions: true,
          },
        },
      });
      assert.equal(clearResponse.isError, undefined, JSON.stringify(clearResponse));

      const canonicalPath = join(committedTestOwnerStateDir(wd), 'skill-active-state.json');
      assert.equal(existsSync(canonicalPath), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('clears only the committed-owner canonical state and preserves unrelated session files', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-clear-propagate-'));
    const unrelatedSessionId = 'sess-root-clear';
    const unrelatedCanonicalPath = join(
      wd,
      '.omx',
      'state',
      'sessions',
      unrelatedSessionId,
      'skill-active-state.json',
    );
    try {
      const teamWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      assert.equal(teamWrite.isError, undefined);
      await writeFile(
        join(wd, '.omx', 'state', 'team-state.json'),
        JSON.stringify({ active: true, mode: 'team', current_phase: 'legacy-root' }, null, 2),
      );
      await mkdir(join(wd, '.omx', 'state', 'sessions', unrelatedSessionId), { recursive: true, mode: 0o700 });
      await secureTestAuthorityDirectories(wd);
      await writeFile(
        unrelatedCanonicalPath,
        JSON.stringify({
          active: true,
          skill: 'ralph',
          session_id: unrelatedSessionId,
          active_skills: [{ skill: 'ralph', session_id: unrelatedSessionId }],
        }, null, 2),
      );
      const clear = await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: { workingDirectory: wd, mode: 'team' },
        },
      });
      assert.equal(clear.isError, undefined);

      const ownerTombstone = JSON.parse(
        await readFile(join(committedTestOwnerStateDir(wd), 'team-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ownerTombstone.active, false);
      assert.equal(ownerTombstone.current_phase, 'cleared');
      assert.equal(ownerTombstone.session_id, COMMITTED_TEST_OWNER_SESSION_ID);
      const legacyRootState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'team-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(legacyRootState.active, true);
      assert.equal(legacyRootState.current_phase, 'legacy-root');
      const ownerCanonical = JSON.parse(
        await readFile(join(committedTestOwnerStateDir(wd), 'skill-active-state.json'), 'utf-8'),
      ) as { active?: boolean; active_skills?: unknown[] };
      assert.equal(ownerCanonical.active, false);
      assert.deepEqual(ownerCanonical.active_skills, []);
      const unrelatedCanonical = JSON.parse(await readFile(unrelatedCanonicalPath, 'utf-8')) as {
        active_skills?: Array<{ skill: string }>;
      };
      assert.deepEqual(unrelatedCanonical.active_skills?.map((entry) => entry.skill), ['ralph']);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps tracked team and ralph state in the committed-owner canonical state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-team-ralph-'));
    try {
      const teamWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'team',
            active: true,
            current_phase: 'running',
          },
        },
      });
      assert.equal(teamWrite.isError, undefined);

      const ralphWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 5,
            current_phase: 'executing',
          },
        },
      });
      assert.equal(ralphWrite.isError, undefined);

      const ownerCanonical = JSON.parse(

        await readFile(join(committedTestOwnerStateDir(wd), 'skill-active-state.json'), 'utf-8'),

      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        ownerCanonical.active_skills?.map(({ skill, phase, session_id }) => ({

          skill,
          phase,
          session_id,
        })),
        [
          { skill: 'team', phase: 'running', session_id: COMMITTED_TEST_OWNER_SESSION_ID },
          { skill: 'ralph', phase: 'executing', session_id: COMMITTED_TEST_OWNER_SESSION_ID },
        ],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone overlaps without mutating canonical state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-standalone-overlap-'));
    try {
      const autopilotWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-standalone',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(autopilotWrite.isError, undefined);

      const invalidTeamWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-standalone',
            mode: 'team',
            active: true,
            current_phase: 'starting',
          },
        },
      });

      assert.equal(invalidTeamWrite.isError, true);
      const body = JSON.parse(invalidTeamWrite.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /omx state/i);
      assert.match(body.error || '', /omx_state\.\*/i);

      const canonical = JSON.parse(
        await readFile(
          join(wd, '.omx', 'state', 'sessions', 'sess-standalone', 'skill-active-state.json'),
          'utf-8',
        ),
      ) as { active_skills?: Array<{ skill: string; phase?: string; session_id?: string }> };
      assert.deepEqual(
        canonical.active_skills?.map(({ skill, phase, session_id }) => ({
          skill,
          phase,
          session_id,
        })),
        [{ skill: 'autopilot', phase: 'planning', session_id: 'sess-standalone' }],
      );
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-standalone', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('auto-completes committed-owner deep-interview state when starting ralplan', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-handoff-interview-'));
    try {
      const ownerStateDir = committedTestOwnerStateDir(wd);
      const sourceWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'deep-interview',
            active: true,
            current_phase: 'intent-first',
            deep_interview_gate: {
              status: 'complete',
              rationale: 'Requirements are clarified and ready for ralplan consensus.',
            },
          },
        },
      });
      assert.equal(sourceWrite.isError, undefined, JSON.stringify(sourceWrite));

      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(response.isError, undefined, JSON.stringify(response));
      const body = JSON.parse(response.content[0]?.text || '{}') as { transition?: string };
      assert.equal(body.transition, 'mode transiting: deep-interview -> ralplan');

      const completed = JSON.parse(
        await readFile(join(ownerStateDir, 'deep-interview-state.json'), 'utf-8'),
      ) as {
        active?: boolean;
        current_phase?: string;
        completed_at?: string;
        auto_completed_reason?: string;
        run_outcome?: string;
        session_id?: string;
      };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
      assert.equal(typeof completed.completed_at, 'string');
      assert.equal(completed.run_outcome, 'finish');
      assert.equal(completed.session_id, COMMITTED_TEST_OWNER_SESSION_ID);
      assert.match(completed.auto_completed_reason || '', /mode transiting: deep-interview -> ralplan/);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects execution-to-planning rollback with clear-first guidance', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-rollback-'));
    try {
      await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-rollback',
            mode: 'ralph',
            active: true,
            current_phase: 'executing',
          },
        },
      });

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-rollback',
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });

      assert.equal(denied.isError, true);
      const body = JSON.parse(denied.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /Execution-to-planning rollback auto-complete is not allowed/i);
      assert.match(body.error || '', /First clear current state first and retry if this action is intended/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete existing workflow state when tracked write validation fails', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-validate-before-transition-'));
    try {
      await mkdir(join(wd, '.omx', 'state', 'sessions', 'sess-invalid'), { recursive: true, mode: 0o700 });
      await secureTestAuthorityDirectories(wd);
      await writeFile(
        join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'),
        JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'planning' }, null, 2),
      );

      const denied = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-invalid',
            mode: 'ralph',
            active: true,
            current_phase: 'definitely-invalid',
          },
        },
      });

      assert.equal(denied.isError, true);
      const body = JSON.parse(denied.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /ralph\.current_phase/i);

      const ralplanState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ralplanState.active, true);
      assert.equal(ralplanState.current_phase, 'planning');
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-invalid', 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('allows ultrawork overlap with any tracked mode', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-ultrawork-any-'));
    try {
      const first = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'autopilot',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(first.isError, undefined);

      const second = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-ulw',
            mode: 'ultrawork',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(second.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps session-scoped workflow states isolated across writes and clears', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-session-isolation-'));
    try {
      const writeA = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-a',
            mode: 'deep-interview',
            active: true,
            current_phase: 'interview-a',
          },
        },
      });
      assert.equal(writeA.isError, undefined);

      const writeB = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-b',
            mode: 'ralph',
            active: true,
            iteration: 1,
            max_iterations: 3,
            current_phase: 'executing',
          },
        },
      });
      assert.equal(writeB.isError, undefined);

      await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: 'sess-b',
            mode: 'ralph',
          },
        },
      });

      const sessionAState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-a', 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(sessionAState.active, true);
      assert.equal(sessionAState.current_phase, 'interview-a');

      const sessionACanonical = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'sess-a', 'skill-active-state.json'), 'utf-8'),
      ) as { active_skills?: Array<{ skill: string; session_id?: string }> };
      assert.deepEqual(
        sessionACanonical.active_skills?.map(({ skill, session_id }) => ({ skill, session_id })),
        [{ skill: 'deep-interview', session_id: 'sess-a' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('does not auto-complete unrelated session workflows from committed-owner writes', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-session-isolation-'));
    const unrelatedSessionId = 'sess-interview';
    const unrelatedStatePath = join(
      wd,
      '.omx',
      'state',
      'sessions',
      unrelatedSessionId,
      'deep-interview-state.json',
    );
    try {
      await ensureTestStateServerAuthority(wd);
      await mkdir(join(wd, '.omx', 'state', 'sessions', unrelatedSessionId), { recursive: true, mode: 0o700 });
      await secureTestAuthorityDirectories(wd);
      await writeFile(
        unrelatedStatePath,
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'asking',
          session_id: unrelatedSessionId,
        }, null, 2),
      );

      const ownerWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'ralplan',
            active: true,
            current_phase: 'planning',
          },
        },
      });
      assert.equal(ownerWrite.isError, undefined, JSON.stringify(ownerWrite));

      const unrelatedState = JSON.parse(await readFile(unrelatedStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(unrelatedState.active, true);
      assert.equal(unrelatedState.current_phase, 'asking');
      assert.equal(unrelatedState.session_id, unrelatedSessionId);
      assert.equal(unrelatedState.auto_completed_reason, undefined);
      const ownerRalplanState = JSON.parse(
        await readFile(join(committedTestOwnerStateDir(wd), 'ralplan-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ownerRalplanState.active, true);
      assert.equal(ownerRalplanState.session_id, COMMITTED_TEST_OWNER_SESSION_ID);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('clears the implicit committed-owner scope without touching unrelated session state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-server-root-clear-isolation-'));
    const unrelatedSessionId = 'sess-keep';
    const unrelatedStatePath = join(
      wd,
      '.omx',
      'state',
      'sessions',
      unrelatedSessionId,
      'deep-interview-state.json',
    );
    try {
      await ensureTestStateServerAuthority(wd);
      await mkdir(join(wd, '.omx', 'state', 'sessions', unrelatedSessionId), { recursive: true, mode: 0o700 });
      await secureTestAuthorityDirectories(wd);
      await writeFile(
        unrelatedStatePath,
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'asking',
          session_id: unrelatedSessionId,
        }, null, 2),
      );
      const ownerWrite = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'deep-interview',
            active: true,
            current_phase: 'owner-asking',
          },
        },
      });
      assert.equal(ownerWrite.isError, undefined);
      await writeFile(
        join(wd, '.omx', 'state', 'deep-interview-state.json'),
        JSON.stringify({ active: true, mode: 'deep-interview', current_phase: 'legacy-root' }, null, 2),
      );

      const clear = await handleStateToolCall({
        params: {
          name: 'state_clear',
          arguments: {
            workingDirectory: wd,
            session_id: COMMITTED_TEST_OWNER_SESSION_ID,
            mode: 'deep-interview',
          },
        },
      });
      assert.equal(clear.isError, undefined);

      const ownerTombstone = JSON.parse(
        await readFile(join(committedTestOwnerStateDir(wd), 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(ownerTombstone.active, false);
      assert.equal(ownerTombstone.current_phase, 'cleared');
      assert.equal(ownerTombstone.session_id, COMMITTED_TEST_OWNER_SESSION_ID);
      const legacyRootState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'deep-interview-state.json'), 'utf-8'),
      ) as Record<string, unknown>;
      assert.equal(legacyRootState.active, true);
      assert.equal(legacyRootState.current_phase, 'legacy-root');
      const ownerCanonical = JSON.parse(
        await readFile(join(committedTestOwnerStateDir(wd), 'skill-active-state.json'), 'utf-8'),
      ) as { active?: boolean; active_skills?: unknown[] };
      assert.equal(ownerCanonical.active, false);
      assert.deepEqual(ownerCanonical.active_skills, []);
      const unrelatedState = JSON.parse(await readFile(unrelatedStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(unrelatedState.active, true);
      assert.equal(unrelatedState.current_phase, 'asking');
      assert.equal(unrelatedState.session_id, unrelatedSessionId);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

});
