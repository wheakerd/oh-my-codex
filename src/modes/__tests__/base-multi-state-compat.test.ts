import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import { readModeState, startMode as rawStartMode } from '../base.js';

const AUTHORITY_ENV_KEYS = [
  'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_STARTUP_CWD', 'OMX_SESSION_ID',
  'OMX_STATE_AUTHORITY_PATH', 'OMX_STATE_AUTHORITY_ID', 'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST', 'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;
let savedAuthorityEnvironment: Map<string, string | undefined>;

async function installTestAuthority(cwd: string): Promise<void> {
  const sessionFile = join(cwd, '.omx', 'state', 'session.json');
  const sessionId = await readFile(sessionFile, 'utf-8')
    .then((raw) => (JSON.parse(raw) as { session_id?: string }).session_id?.trim())
    .catch(() => undefined)
    ?? `mode-multi-state-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
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

describe('modes/base multi-state compatibility', () => {
  it('allows the approved team + ralph overlap across root and session scopes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-team-ralph-'));
    try {
      await mkdir(join(wd, '.omx', 'state'), { recursive: true, mode: 0o700 });
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({ session_id: 'sess-team-ralph' }),
      );
      await startMode('team', 'coordinate execution', 5, wd);
      await startMode('ralph', 'complete the approved plan', 5, wd);

      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-team-ralph', 'team-state.json')), true);
      assert.equal(
        existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-team-ralph', 'ralph-state.json')),
        true,
      );
      assert.equal((await readModeState('team', wd))?.active, true);
      assert.equal((await readModeState('ralph', wd))?.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects standalone autopilot + team overlaps with actionable clearing guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-team-'));
    try {
      await startMode('autopilot', 'run solo automation', 5, wd);

      await assert.rejects(
        () => startMode('team', 'attempt invalid overlap', 5, wd),
        /omx state.*omx_state\.\*/i,
      );

      const autopilotState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'sessions', process.env.OMX_SESSION_ID!, 'autopilot-state.json'), 'utf-8'),
      ) as { active?: boolean };
      assert.equal(autopilotState.active, true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
