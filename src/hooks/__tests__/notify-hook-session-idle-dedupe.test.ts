import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import {
  TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS,
  TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS,
} from '../../team/state-root.js';
import { writeSessionStart } from '../session.js';
import { hardenTestAuthorityTreeSync } from '../../team/__tests__/authority-fixture.js';

const fixtureAuthorityEnv = new Map<string, NodeJS.ProcessEnv>();

async function initializeNotifyFixtureAuthority(cwd: string, sessionId: string): Promise<void> {
  const env = { ...process.env };
  for (const key of [...TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS, ...TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS]) {
    delete env[key];
  }
  await mkdir(join(cwd, '.omx'), { recursive: true, mode: 0o700 });
  await chmod(join(cwd, '.omx'), 0o700);
  hardenTestAuthorityTreeSync(cwd);
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `notify-idle-dedupe-${sessionId}-${Date.now()}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await chmod(authority.canonical_state_root, 0o700);
  await writeSessionStart(cwd, sessionId);
  const refreshedAuthority = await resolveStateAuthorityForGuard({ startup_cwd: cwd, observed_cwd: cwd, session_id: sessionId });
  await mintStateAuthorityTransportCapability(refreshedAuthority);
  hardenTestAuthorityTreeSync(cwd);
  fixtureAuthorityEnv.set(cwd, buildStateAuthorityTransportEnv(refreshedAuthority, { ...env, OMX_SESSION_ID: sessionId }));
}

const SESSION_ID = 'sess-idle-dedupe';

function buildSessionIdlePlugin(targetPath: string): string {
  return `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const TARGET_PATH = ${JSON.stringify(targetPath)};

export async function onHookEvent(event) {
  if (event.event !== 'session-idle') return;
  mkdirSync(dirname(TARGET_PATH), { recursive: true });
  let count = 0;
  try {
    const existing = JSON.parse(readFileSync(TARGET_PATH, 'utf-8'));
    count = Number(existing?.count) || 0;
  } catch {
    count = 0;
  }
  writeFileSync(TARGET_PATH, JSON.stringify({
    count: count + 1,
    last_reason: event.context?.reason || '',
    last_status: event.context?.status || '',
    last_session_name: event.context?.session_name || '',
  }, null, 2));
}
`;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

function runNotifyHook(
  repoRoot: string,
  cwd: string,
  lastAssistantMessage: string,
  turnId: string,
  envOverrides: Record<string, string> = {},
  payloadSessionId: string = SESSION_ID,
) {
  const payload = {
    cwd,
    type: 'agent-turn-complete',
    thread_id: 'thread-session-idle',
    turn_id: turnId,
    session_id: payloadSessionId,
    input_messages: [],
    last_assistant_message: lastAssistantMessage,
  };

  hardenTestAuthorityTreeSync(cwd);
  return spawnSync(process.execPath, ['dist/scripts/notify-hook.js', JSON.stringify(payload)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...fixtureAuthorityEnv.get(cwd),
      OMX_TEAM_WORKER: '',
      TMUX: '',
      TMUX_PANE: '',
      ...envOverrides,
    },
  });
}

describe('notify-hook session-idle dedupe', () => {
  it('suppresses repeated unchanged post_turn_idle_notification hook events once the first hook dispatch succeeds', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      await initializeNotifyFixtureAuthority(wd, SESSION_ID);
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');
      const hookStatePath = join(stateDir, 'sessions', SESSION_ID, 'session-idle-hook-state.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-1');
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-2');
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number; last_reason: string; last_status: string }>(pluginStatePath);
      assert.equal(pluginState.count, 1);
      assert.equal(pluginState.last_reason, 'post_turn_idle_notification');
      assert.equal(pluginState.last_status, 'blocked');
      assert.equal(existsSync(hookStatePath), true);
    } finally {
      fixtureAuthorityEnv.delete(wd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('re-emits session-idle hook events when the idle fingerprint meaningfully changes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-change-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      await initializeNotifyFixtureAuthority(wd, SESSION_ID);
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting on review.', 'turn-idle-3');
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting on user input.', 'turn-idle-4');
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number }>(pluginStatePath);
      assert.equal(pluginState.count, 2);
    } finally {
      fixtureAuthorityEnv.delete(wd);
      await rm(wd, { recursive: true, force: true });
    }
  });


  it('writes session-idle hook state into the fork session scope when OMX_SESSION_ID targets a fork', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-fork-scope-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');
      const forkSessionId = 'sess-fork';

      await mkdir(join(stateDir, 'sessions', forkSessionId), { recursive: true });
      await initializeNotifyFixtureAuthority(wd, forkSessionId);
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const result = runNotifyHook(repoRoot, wd, 'Waiting on forked review.', 'turn-idle-fork', {
        OMX_SESSION_ID: forkSessionId,
      }, forkSessionId);
      assert.equal(result.status, 0, result.stderr || result.stdout);

      assert.equal(existsSync(join(stateDir, 'sessions', forkSessionId, 'session-idle-hook-state.json')), true);
      assert.equal(existsSync(join(stateDir, 'sessions', SESSION_ID, 'session-idle-hook-state.json')), false);
      const pluginState = await readJson<{ count: number }>(pluginStatePath);
      assert.equal(pluginState.count, 1);
    } finally {
      fixtureAuthorityEnv.delete(wd);
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('keeps post_turn_idle_notification hook dedupe active even when lifecycle cooldown is disabled', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-notify-idle-dedupe-zero-cooldown-'));
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

    try {
      await initializeNotifyFixtureAuthority(wd, SESSION_ID);
      const stateDir = join(wd, '.omx', 'state');
      const hooksDir = join(wd, '.omx', 'hooks');
      const pluginStatePath = join(wd, '.omx', 'plugin-state', 'session-idle.json');

      await mkdir(stateDir, { recursive: true });
      await mkdir(hooksDir, { recursive: true });
      await writeFile(join(hooksDir, 'session-idle-counter.mjs'), buildSessionIdlePlugin(pluginStatePath), 'utf-8');

      const first = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-5', {
        OMX_IDLE_COOLDOWN_SECONDS: '0',
      });
      assert.equal(first.status, 0, first.stderr || first.stdout);

      const second = runNotifyHook(repoRoot, wd, 'Waiting for your next instruction.', 'turn-idle-6', {
        OMX_IDLE_COOLDOWN_SECONDS: '0',
      });
      assert.equal(second.status, 0, second.stderr || second.stdout);

      const pluginState = await readJson<{ count: number; last_reason: string }>(pluginStatePath);
      assert.equal(pluginState.count, 1);
      assert.equal(pluginState.last_reason, 'post_turn_idle_notification');
    } finally {
      fixtureAuthorityEnv.delete(wd);
      await rm(wd, { recursive: true, force: true });
    }
  });
});
