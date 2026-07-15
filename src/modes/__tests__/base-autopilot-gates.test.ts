import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import { cancelMode as rawCancelMode, updateModeState as rawUpdateModeState } from '../base.js';

const AUTHORITY_ENV_KEYS = [
  'OMX_ROOT', 'OMX_STATE_ROOT', 'OMX_TEAM_STATE_ROOT', 'OMX_STARTUP_CWD', 'OMX_SESSION_ID',
  'OMX_STATE_AUTHORITY_PATH', 'OMX_STATE_AUTHORITY_ID', 'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST', 'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;
let savedAuthorityEnvironment: Map<string, string | undefined>;

function testSessionId(cwd: string): string {
  return `mode-autopilot-${createHash('sha256').update(cwd).digest('hex').slice(0, 24)}`;
}

function autopilotStatePath(cwd: string): string {
  return join(cwd, '.omx', 'state', 'sessions', testSessionId(cwd), 'autopilot-state.json');
}

async function installTestAuthority(cwd: string): Promise<void> {
  const sessionId = testSessionId(cwd);
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

async function updateModeState(...args: Parameters<typeof rawUpdateModeState>): ReturnType<typeof rawUpdateModeState> {
  await installTestAuthority(args[2] ?? process.cwd());
  return rawUpdateModeState(...args);
}

async function cancelMode(...args: Parameters<typeof rawCancelMode>): ReturnType<typeof rawCancelMode> {
  await installTestAuthority(args[1] ?? process.cwd());
  return rawCancelMode(...args);
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

async function writeAutopilotState(wd: string, state: Record<string, unknown>): Promise<void> {
  await mkdir(join(wd, '.omx', 'state'), { recursive: true });
  await installTestAuthority(wd);
  await mkdir(join(wd, '.omx', 'state', 'sessions', testSessionId(wd)), { recursive: true, mode: 0o700 });
  await writeFile(autopilotStatePath(wd), JSON.stringify({
    active: true,
    mode: 'autopilot',
    iteration: 1,
    max_iterations: 10,
    started_at: '2026-06-09T00:00:00.000Z',
    ...state,
  }, null, 2));
}

describe('modes/base Autopilot gate integration', () => {
  it('updateModeState rejects direct deep-interview to ultragoal skips', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-deep-skip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'deep-interview' });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'ultragoal' }, wd),
        /Cannot skip Autopilot ralplan gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects direct deep-interview to ultragoal skips even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-deep-skip-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'deep-interview' });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'ultragoal',
          pipeline_stage_index: 2,
        }, wd),
        /Cannot skip Autopilot ralplan gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to code-review skips', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-skip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'code-review' }, wd),
        /Cannot skip Autopilot ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects direct ralplan to rework skips', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-rework-skip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'rework' }, wd),
        /Cannot skip Autopilot ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState allows code-review REQUEST_CHANGES to enter rework', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-review-rework-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'code-review', review_cycle: 1 });
      await updateModeState('autopilot', {
        current_phase: 'rework',
        review_cycle: 2,
        state: {
          handoff_artifacts: {
            code_review: {
              stage: 'code-review',
              recommendation: 'REQUEST_CHANGES',
              architectural_status: 'CLEAR',
              clean: false,
              artifact_path: '.omx/reviews/code-review-cycle-1.json',
              findings: ['Fix src/implementation.ts'],
            },
          },
          review_verdict: {
            stage: 'code-review',
            recommendation: 'REQUEST_CHANGES',
            architectural_status: 'CLEAR',
            clean: false,
            artifact_path: '.omx/reviews/code-review-cycle-1.json',
            findings: ['Fix src/implementation.ts'],
          },
          return_to_ralplan_reason: null,
        },
      }, wd);

      const raw = JSON.parse(await readFile(autopilotStatePath(wd), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.active, true);
      assert.equal(raw.current_phase, 'rework');
      assert.equal(raw.review_cycle, 2);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to code-review skips even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-skip-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'code-review',
          pipeline_stage_results: {},
        }, wd),
        /Cannot skip Autopilot ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan completion before ultragoal', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-complete-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ralplan' });
      await assert.rejects(
        () => updateModeState('autopilot', { active: false, current_phase: 'complete' }, wd),
        /Cannot complete Autopilot before ultragoal gate/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to ultragoal without tracker-backed native consensus', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-no-native-'));
    try {
      await writeAutopilotState(wd, {
        current_phase: 'ralplan',
        state: {
          handoff_artifacts: {
            ralplan: {
              ralplan_consensus_gate: {
                complete: true,
                evidence_kind: 'codex_exec',
              },
            },
          },
        },
      });
      await assert.rejects(
        () => updateModeState('autopilot', { current_phase: 'ultragoal' }, wd),
        /Cannot transition ralplan -> ultragoal/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState rejects ralplan to ultragoal without native consensus even with user-supplied pipeline fields', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-ralplan-no-native-pipeline-fields-'));
    try {
      await writeAutopilotState(wd, {
        current_phase: 'ralplan',
        state: {
          handoff_artifacts: {
            ralplan: {
              ralplan_consensus_gate: {
                complete: true,
                evidence_kind: 'codex_exec',
              },
            },
          },
        },
      });
      await assert.rejects(
        () => updateModeState('autopilot', {
          current_phase: 'ultragoal',
          pipeline_stage_index: 2,
          pipeline_stage_results: {},
        }, wd),
        /Cannot transition ralplan -> ultragoal/i,
      );
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('updateModeState does not persist user-supplied trustedPipelineProgress as state data', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-trusted-field-strip-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ultraqa' });
      await updateModeState('autopilot', {
        current_phase: 'ultraqa',
        trustedPipelineProgress: true,
      }, wd);

      const raw = JSON.parse(await readFile(autopilotStatePath(wd), 'utf-8')) as Record<string, unknown>;
      assert.equal(Object.prototype.hasOwnProperty.call(raw, 'trustedPipelineProgress'), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('cancelMode allows Autopilot cancellation from a gated implementation phase', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-cancel-'));
    try {
      await writeAutopilotState(wd, { current_phase: 'ultragoal' });
      await cancelMode('autopilot', wd);

      const raw = JSON.parse(await readFile(autopilotStatePath(wd), 'utf-8')) as Record<string, unknown>;
      assert.equal(raw.active, false);
      assert.equal(raw.current_phase, 'cancelled');
      assert.equal(raw.run_outcome, 'cancelled');
      assert.ok(typeof raw.completed_at === 'string' && raw.completed_at.length > 0);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
