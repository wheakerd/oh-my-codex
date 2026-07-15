import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStateAuthority } from '../../state/authority.js';

const stateServerRalphAuthorityInitByWorkspace = new Map<string, Promise<string>>();
const TEST_AUTHORITY_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'OMX_STARTUP_CWD',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;

let savedAuthorityEnv: Map<string, string | undefined>;

beforeEach(() => {
  savedAuthorityEnv = new Map(TEST_AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of TEST_AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of savedAuthorityEnv) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
});

async function ensureTestStateServerRalphAuthority(workingDirectory: string): Promise<string> {
  const existing = stateServerRalphAuthorityInitByWorkspace.get(workingDirectory);
  if (existing) return existing;
  const sessionId = `state-server-ralph-phase-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(join(workingDirectory, '.omx', 'state'), { recursive: true, mode: 0o700 });
  await chmod(join(workingDirectory, '.omx'), 0o700);
  await chmod(join(workingDirectory, '.omx', 'state'), 0o700);
  const initializing = initializeStateAuthority({
    startup_cwd: workingDirectory,
    observed_cwd: workingDirectory,
    launch_id: `state-server-ralph-phase-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    session_binding: { canonical_session_id: sessionId },
  }).then(() => sessionId);
  stateServerRalphAuthorityInitByWorkspace.set(workingDirectory, initializing);
  try {
    return await initializing;
  } catch (error) {
    stateServerRalphAuthorityInitByWorkspace.delete(workingDirectory);
    throw error;
  }
}

async function getTestStateToolCall() {
  const { handleStateToolCall } = await import('../state-server.js');
  return async (request: Parameters<typeof handleStateToolCall>[0]) => {
    const { name, arguments: rawArgs = {} } = request.params;
    if (name === 'state_write' || name === 'state_clear') {
      const workingDirectory = typeof rawArgs.workingDirectory === 'string'
        ? rawArgs.workingDirectory
        : process.cwd();
      await ensureTestStateServerRalphAuthority(workingDirectory);
    }
    return handleStateToolCall(request);
  };
}

describe('state-server Ralph phase contract', () => {
  it('normalizes legacy Ralph phase aliases on state_write', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    const sessionId = await ensureTestStateServerRalphAuthority(wd);
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'execution',
            started_at: '2026-02-22T00:00:00.000Z',
          },
        },
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'sessions', sessionId, 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'executing');
      assert.equal(state.ralph_phase_normalized_from, 'execution');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unknown Ralph phases on state_write', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'bananas',
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /Invalid Ralph phase|must be one of/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects terminal Ralph phase when active=true', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'complete',
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /terminal Ralph phases require active=false/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects fractional iteration values for Ralph state', async () => {
    process.env.OMX_STATE_SERVER_DISABLE_AUTO_START = '1';
    const handleStateToolCall = await getTestStateToolCall();

    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await handleStateToolCall({
        params: {
          name: 'state_write',
          arguments: {
            workingDirectory: wd,
            mode: 'ralph',
            active: true,
            current_phase: 'executing',
            iteration: 0.25,
            max_iterations: 10.5,
          },
        },
      });
      assert.equal(response.isError, true);
      const body = JSON.parse(response.content[0]?.text || '{}') as { error?: string };
      assert.match(body.error || '', /finite integer/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
