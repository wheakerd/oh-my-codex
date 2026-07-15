import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState, startMode as rawStartMode, updateModeState as rawUpdateModeState } from '../base.js';
import { listActiveSkills, readVisibleSkillActiveState } from '../../state/skill-active.js';

import { createHash } from 'node:crypto';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const AUTHORITY_ENV_KEYS = [
  'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_STARTUP_CWD', 'OMX_SESSION_ID',
  'OMX_STATE_AUTHORITY_PATH', 'OMX_STATE_AUTHORITY_ID', 'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST', 'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;
let savedAuthorityEnvironment: Map<string, string | undefined>;

async function installTestAuthority(cwd: string): Promise<void> {
  const sessionId = `mode-autoresearch-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
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

function restoreAuthorityEnvironment(): void {
  for (const [key, value] of savedAuthorityEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  savedAuthorityEnvironment = new Map(AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => restoreAuthorityEnvironment());

describe('modes/base deep-interview contract integration', () => {
  it('startMode persists deep-interview state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-deep-interview-contract-'));
    try {
      const started = await startMode('deep-interview', 'clarify a vague request', 3, wd);
      assert.equal(started.mode, 'deep-interview');
      assert.equal(started.active, true);
      assert.equal(started.current_phase, 'starting');
      const persisted = await readModeState('deep-interview', wd);
      assert.equal(persisted?.mode, 'deep-interview');
      assert.equal(persisted?.task_description, 'clarify a vague request');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});

describe('modes/base autoresearch contract integration', () => {
  it('startMode auto-completes deep-interview when starting ralplan with completion gate evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-interview-ralplan-handoff-'));
    try {
      await startMode('deep-interview', 'clarify contract', 3, wd);
      await updateModeState('deep-interview', {
        deep_interview_gate: {
          status: 'complete',
          rationale: 'Requirements are clarified and ready for ralplan consensus.',
        },
      }, wd);
      const started = await startMode('ralplan', 'plan contract', 5, wd);
      assert.equal(started.mode, 'ralplan');
      assert.equal(started.active, true);
      assert.equal(started.transition_message, 'mode transiting: deep-interview -> ralplan');

      const completed = await readModeState('deep-interview', wd) as {
        active?: boolean;
        current_phase?: string;
        completed_at?: string;
      };
      assert.equal(completed.active, false);
      assert.equal(completed.current_phase, 'completed');
      assert.equal(typeof completed.completed_at, 'string');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode allows the approved team + ralph overlap', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-team-ralph-overlap-'));
    try {
      await startMode('team', 'demo team', 5, wd);
      const started = await startMode('ralph', 'demo ralph', 5, wd);
      assert.equal(started.mode, 'ralph');
      assert.equal(started.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode blocks autoresearch when ralph is active', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-contract-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      await assert.rejects(
        () => startMode('autoresearch', 'demo mission', 1, wd),
        /Cannot start autoresearch: ralph is already active/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode allows ultrawork overlap with any tracked mode', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-ralph-ultrawork-allow-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      const started = await startMode('ultrawork', 'demo mission', 1, wd);
      assert.equal(started.mode, 'ultrawork');
      assert.equal(started.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode blocks execution-to-planning rollback auto-complete', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-rollback-deny-'));
    try {
      await startMode('ralph', 'demo', 5, wd);
      await assert.rejects(
        () => startMode('ralplan', 'plan again', 5, wd),
        /Execution-to-planning rollback auto-complete is not allowed/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('startMode persists autoresearch state when no exclusive conflict exists', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-contract-'));
    try {
      const started = await startMode('autoresearch', 'demo mission', 1, wd);
      assert.equal(started.mode, 'autoresearch');
      assert.equal(started.active, true);
      assert.equal(started.current_phase, 'starting');
      const persisted = await readModeState('autoresearch', wd);
      assert.equal(persisted?.mode, 'autoresearch');
      assert.equal(persisted?.task_description, 'demo mission');

      const canonical = await readVisibleSkillActiveState(wd);
      assert.deepEqual(
        listActiveSkills(canonical ?? {}).map(({ skill, phase }) => ({ skill, phase })),
        [{ skill: 'autoresearch', phase: 'starting' }],
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState syncs canonical autoresearch completion', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autoresearch-canonical-'));
    try {
      await startMode('autoresearch', 'demo mission', 1, wd);
      await updateModeState('autoresearch', {
        active: false,
        current_phase: 'complete',
        completed_at: '2026-04-11T00:00:00.000Z',
      }, wd);

      const canonical = await readVisibleSkillActiveState(wd);
      assert.ok(canonical);
      assert.equal(canonical?.active, false);
      assert.deepEqual(listActiveSkills(canonical ?? {}), []);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
