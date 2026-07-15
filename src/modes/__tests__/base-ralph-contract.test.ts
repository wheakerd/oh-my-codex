import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import { readModeState, startMode as rawStartMode, updateModeState as rawUpdateModeState } from '../base.js';

const AUTHORITY_ENV_KEYS = [
  'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_STARTUP_CWD', 'OMX_SESSION_ID',
  'OMX_STATE_AUTHORITY_PATH', 'OMX_STATE_AUTHORITY_ID', 'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST', 'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;
let savedAuthorityEnvironment: Map<string, string | undefined>;

async function installTestAuthority(cwd: string): Promise<void> {
  const sessionId = `mode-ralph-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
  await mkdir(join(cwd, '.omx', 'state'), { recursive: true, mode: 0o700 });
  await chmod(cwd, 0o700);
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

async function startMode(...args: Parameters<typeof rawStartMode>): ReturnType<typeof rawStartMode> {
  await installTestAuthority(args[3] ?? process.cwd());
  return rawStartMode(...args);
}

async function updateModeState(...args: Parameters<typeof rawUpdateModeState>): ReturnType<typeof rawUpdateModeState> {
  await installTestAuthority(args[2] ?? process.cwd());
  return rawUpdateModeState(...args);
}

beforeEach(() => {
  savedAuthorityEnvironment = new Map(AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of savedAuthorityEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
describe('modes/base ralph contract integration', () => {
  it('startMode rejects invalid Ralph max_iterations values', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-contract-'));
    try {
      await assert.rejects(
        () => startMode('ralph', 'demo', 0, wd),
        /ralph\.max_iterations must be a finite (number|integer) > 0/,
      );
      assert.equal(existsSync(join(wd, '.omx', 'state', 'ralph-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects invalid Ralph phase and keeps previous persisted state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-contract-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      const before = await readModeState('ralph', wd);
      assert.ok(before);

      await assert.rejects(
        () => updateModeState(
          'ralph',
          { current_phase: 'bananas', iteration: -1, max_iterations: 0 },
          wd,
        ),
        /ralph\.current_phase must be one of:/,
      );

      const after = await readModeState('ralph', wd);
      assert.ok(after);
      assert.equal(after?.current_phase, before?.current_phase);
      assert.equal(after?.iteration, before?.iteration);
      assert.equal(after?.max_iterations, before?.max_iterations);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState normalizes legacy Ralph phase aliases via shared contract', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-contract-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      const updated = await updateModeState('ralph', { current_phase: 'verification' }, wd);
      assert.equal(updated.current_phase, 'verifying');
      assert.equal(updated.ralph_phase_normalized_from, 'verification');
      assert.equal(updated.run_outcome, 'continue');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState persists terminal run outcomes on blocked_on_user', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-contract-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      const updated = await updateModeState('ralph', { active: false, current_phase: 'blocked_on_user' }, wd);
      assert.equal(updated.current_phase, 'blocked_on_user');
      assert.equal(updated.run_outcome, 'blocked_on_user');
      assert.equal(updated.active, false);
      assert.ok(typeof updated.completed_at === 'string' && updated.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
