import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  executeStateOperation as executeStateOperationRaw,
  type StateOperationName,
  type StateOperationResponse,
} from '../operations.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability } from '../authority.js';
import { buildStateAuthorityTransportEnv } from '../transport-env.js';

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

const ralphPhaseAuthorityTransportByWorkspace = new Map<string, Promise<NodeJS.ProcessEnv>>();

async function ensureTestRalphPhaseAuthority(workingDirectory: string): Promise<NodeJS.ProcessEnv> {
  const existing = ralphPhaseAuthorityTransportByWorkspace.get(workingDirectory);
  if (existing) return await existing;
  const sessionId = 'ralph-phase-session';
  const initializing = (async () => {
    const stateDir = join(workingDirectory, '.omx', 'state');
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(join(workingDirectory, '.omx'), 0o700);
    await chmod(stateDir, 0o700);
    const authority = await initializeStateAuthority({
      startup_cwd: workingDirectory,
      observed_cwd: workingDirectory,
      launch_id: `ralph-phase-test-${sessionId}`,
      session_binding: { canonical_session_id: sessionId },
    });
    await mintStateAuthorityTransportCapability(authority);
    return buildStateAuthorityTransportEnv(authority, { OMX_SESSION_ID: sessionId });
  })();
  ralphPhaseAuthorityTransportByWorkspace.set(workingDirectory, initializing);
  try {
    return await initializing;
  } catch (error) {
    ralphPhaseAuthorityTransportByWorkspace.delete(workingDirectory);
    throw error;
  }
}

async function executeStateOperation(
  name: StateOperationName,
  rawArgs: Record<string, unknown>,
): Promise<StateOperationResponse> {
  if (name === 'state_write' || name === 'state_clear') {
    const workingDirectory = typeof rawArgs.workingDirectory === 'string'
      ? rawArgs.workingDirectory
      : process.cwd();
    const transport = await ensureTestRalphPhaseAuthority(workingDirectory);
    const previous = new Map(STATE_AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]));
    Object.assign(process.env, transport);
    try {
      return await executeStateOperationRaw(name, rawArgs);
    } finally {
      for (const key of STATE_AUTHORITY_ENV_KEYS) {
        const value = previous.get(key);
        if (typeof value === 'string') process.env[key] = value;
        else delete process.env[key];
      }
    }
  }
  return executeStateOperationRaw(name, rawArgs);
}

describe('state operations Ralph phase contract', () => {
  it('normalizes legacy Ralph phase aliases on state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'execution',
        started_at: '2026-02-22T00:00:00.000Z',
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'sessions', 'ralph-phase-session', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'executing');
      assert.equal(state.ralph_phase_normalized_from, 'execution');
      assert.equal(state.run_outcome, 'continue');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts blocked_on_user as an explicit terminal Ralph outcome', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'blocked_on_user',
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'sessions', 'ralph-phase-session', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'blocked_on_user');
      assert.equal(state.run_outcome, 'blocked_on_user');
      assert.equal(typeof state.completed_at, 'string');
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects unknown Ralph phases on state_write', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'bananas',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /Invalid Ralph phase|must be one of/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects terminal Ralph phase when active=true', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /terminal Ralph phases require active=false/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects complete Ralph state without completion-audit evidence', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /requires passing completion_audit/i);
      assert.match(body.error || '', /missing_completion_audit/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects complete Ralph state without completion-audit evidence when active is omitted', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        current_phase: 'complete',
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /requires passing completion_audit/i);
      assert.match(body.error || '', /missing_completion_audit/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts complete Ralph state with in-state completion-audit evidence and clears stale audit gate markers', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
        completion_audit_gate: 'blocked',
        completion_audit_missing_reason: 'missing_completion_checklist',
        completion_audit_blocked_at: '2026-05-10T12:00:00.000Z',
        completion_audit: {
          passed: true,
          prompt_to_artifact_checklist: ['requirement mapped to committed source changes'],
          verification_evidence: ['npm run build exited 0'],
        },
      });
      assert.equal(response.isError, undefined);

      const file = join(wd, '.omx', 'state', 'sessions', 'ralph-phase-session', 'ralph-state.json');
      const state = JSON.parse(await readFile(file, 'utf-8'));
      assert.equal(state.current_phase, 'complete');
      assert.equal(state.active, false);
      assert.equal(typeof state.completed_at, 'string');
      assert.equal(state.completion_audit_gate, undefined);
      assert.equal(state.completion_audit_missing_reason, undefined);
      assert.equal(state.completion_audit_blocked_at, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('accepts complete Ralph state with repo-relative completion-audit artifact', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-complete-audit-path-'));
    try {
      await writeFile(
        join(wd, 'audit.json'),
        JSON.stringify({
          passed: true,
          prompt_to_artifact_checklist: ['prompt requirement has an artifact'],
          verification_evidence: ['node --test dist/state/__tests__/operations-ralph-phase.test.js exited 0'],
        }),
        'utf-8',
      );

      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: false,
        current_phase: 'complete',
        completion_audit_path: 'audit.json',
      });
      assert.equal(response.isError, undefined);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects fractional iteration values for Ralph state', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-state-ralph-phase-'));
    try {
      const response = await executeStateOperation('state_write', {
        workingDirectory: wd,
        mode: 'ralph',
        active: true,
        current_phase: 'executing',
        iteration: 0.25,
        max_iterations: 10.5,
      });
      assert.equal(response.isError, true);
      const body = response.payload as { error?: string };
      assert.match(body.error || '', /finite integer/i);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
