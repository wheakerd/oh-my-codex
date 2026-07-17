import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildRunState, syncRunStateFromModeState } from '../run-state.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const STATE_AUTHORITY_ENV_KEYS = [
  'OMX_STARTUP_CWD',
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
  'OMX_SESSION_ID',
] as const;

async function establishFixtureAuthority(cwd: string, sessionId: string): Promise<() => void> {
  const stateDir = join(cwd, '.omx', 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(join(cwd, '.omx'), 0o700);
  await chmod(stateDir, 0o700);
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `run-state-test-${sessionId}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  const previous = new Map(STATE_AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId }));
  return () => {
    for (const key of STATE_AUTHORITY_ENV_KEYS) {
      const value = previous.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  };
}

describe('run state sync', () => {
  it('preserves canonical askuserQuestion lifecycle while keeping legacy blocked_on_user outcome', () => {
    const state = buildRunState(
      {
        mode: 'deep-interview',
        active: false,
        run_outcome: 'blocked_on_user',
        lifecycle_outcome: 'askuserQuestion',
      },
      null,
      '2026-04-19T00:00:00.000Z',
    );

    assert.equal(state.outcome, 'blocked_on_user');
    assert.equal(state.lifecycle_outcome, 'askuserQuestion');
  });

  it('writes canonical askuserQuestion lifecycle to run-state.json during sync', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-run-state-'));
    let restoreAuthority = () => {};
    try {
      restoreAuthority = await establishFixtureAuthority(wd, 'run-state-sync');
      const synced = await syncRunStateFromModeState(
        {
          mode: 'deep-interview',
          active: false,
          run_outcome: 'blocked_on_user',
          lifecycle_outcome: 'askuserQuestion',
        },
        wd,
        'run-state-sync',
      );

      const persisted = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', 'run-state-sync', 'run-state.json'), 'utf-8'),
      ) as typeof synced;

      assert.equal(synced.outcome, 'blocked_on_user');
      assert.equal(synced.lifecycle_outcome, 'askuserQuestion');
      assert.equal(persisted.lifecycle_outcome, 'askuserQuestion');
    } finally {
      restoreAuthority();
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects run-state writes after the committed authority root is replaced', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-run-state-replaced-'));
    let restoreAuthority = () => {};
    try {
      restoreAuthority = await establishFixtureAuthority(wd, 'run-state-replaced');
      const stateRoot = join(wd, '.omx', 'state');
      const displacedRoot = join(wd, '.omx', 'state-old');
      await rename(stateRoot, displacedRoot);
      await mkdir(stateRoot, { recursive: true, mode: 0o700 });

      await assert.rejects(
        syncRunStateFromModeState({ mode: 'ralph', active: true }, wd, 'run-state-replaced'),
        /replaced|fingerprint|authority/i,
      );
      await assert.rejects(access(join(stateRoot, 'sessions', 'run-state-replaced', 'run-state.json')));
    } finally {
      restoreAuthority();
      await rm(wd, { recursive: true, force: true });
    }
  });
});
