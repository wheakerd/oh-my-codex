import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard, rolloverStateAuthorityToAlternateRoot } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const TEST_AUTHORITY_ISSUER = {
  kind: 'first-party-launcher' as const,
  package_version: 'test',
  package_digest: '0'.repeat(64),
};
function todaySessionDir(baseHome: string): string {
  const now = new Date();
  return join(
    baseHome,
    '.codex',
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number = 3000, stepMs: number = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

async function authenticatedWatcherEnv(cwd: string, sessionId: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(cwd, '.omx'), { recursive: true, mode: 0o700 });
  await chmod(join(cwd, '.omx'), 0o700);
  await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `hook-derived-watcher-${sessionId}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await writeFile(join(cwd, '.omx', 'state', 'session.json'), `${JSON.stringify({
    session_id: sessionId,
    started_at: new Date().toISOString(),
    cwd,
  })}\n`);
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: sessionId,
  });
  await mintStateAuthorityTransportCapability(authority);
  return buildStateAuthorityTransportEnv(authority, { ...process.env, OMX_SESSION_ID: sessionId });
}

describe('hook-derived-watcher', () => {
  it('uses offset-bounded rollout reads instead of re-reading whole tracked files', async () => {
    const source = await readFile(new URL('../hook-derived-watcher.js', import.meta.url), 'utf-8');

    assert.match(source, /async function readFileDelta/);
    assert.match(source, /while \(totalBytesRead < length\)/);
    assert.match(source, /nextOffset: offset \+ totalBytesRead/);
    assert.match(source, /new StringDecoder\('utf8'\)/);
    assert.match(source, /decoder\.write\(bytes\)/);
    assert.match(source, /const fileStat = await stat\(path\)\.catch\(\(\) => null\);\s*if \(!fileStat\)\s*continue;/);
    assert.match(source, /if \(currentSize < meta\.offset\) \{\s*meta\.offset = 0;\s*meta\.partial = '';/);
    assert.doesNotMatch(source, /const content = await readFile\(path, 'utf-8'\)[\s\S]*const delta = content\.slice\(meta\.offset\)/);
    assert.doesNotMatch(source, /stat\(path\)\.catch\(\(\) => \(\{ size: 0 \}\)\)/);
  });

  it('stores watcher state and logs under the committed authority root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-boxed-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const boxedRoot = join(base, 'boxed-runtime');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(cwd, { recursive: true });
      await authenticatedWatcherEnv(cwd, 'hook-derived-boxed-session');
      await mkdir(boxedRoot, { recursive: true, mode: 0o700 });
      const initial = await resolveStateAuthorityForGuard({
        startup_cwd: cwd,
        observed_cwd: cwd,
        session_id: 'hook-derived-boxed-session',
      });
      const active = await rolloverStateAuthorityToAlternateRoot({ context: initial, transport_capability: (await mintStateAuthorityTransportCapability(initial)).capability, proposed_state_root: join(boxedRoot, '.omx', 'state'), creation_root: boxedRoot,
      launch_id: 'hook-derived-boxed-alternate',
      consumer_kind: 'boxed',
      issuer: TEST_AUTHORITY_ISSUER, });
      await mintStateAuthorityTransportCapability(active);
      const authorityEnv = buildStateAuthorityTransportEnv(active, {
        OMX_SESSION_ID: 'hook-derived-boxed-session',
      });
      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...authorityEnv,
            HOME: homeDir,
            OMX_ROOT: boxedRoot,
            OMXBOX_ACTIVE: '1',
            OMX_SOURCE_CWD: cwd,
            OMX_HOOK_DERIVED_SIGNALS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(
        existsSync(join(boxedRoot, '.omx', 'state', 'hook-derived-watcher-state.json')),
        true,
      );
      assert.equal(
        existsSync(join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json')),
        false,
      );
      const logDir = join(boxedRoot, '.omx', 'logs');
      const logNames = await readdir(logDir);
      assert.equal(logNames.some((name) => name.startsWith('hook-derived-watcher-')), true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('dispatches needs-input for assistant_message content arrays', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-array-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });
      const authorityEnv = await authenticatedWatcherEnv(cwd, 'hook-derived-array-session');

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-array.jsonl');
      await writeFile(
        rolloutPath,
        [
          JSON.stringify({
            type: 'session_meta',
            payload: {
              id: 'thread-hook-array',
              cwd,
            },
          }),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
              type: 'assistant_message',
              turn_id: 'turn-hook-array',
              content: [
                {
                  type: 'output_text',
                  text: 'Would you like me to continue with the cleanup?',
                },
                {
                  type: 'output_text',
                  text: 'I need your approval before I keep going.',
                },
              ],
            },
          }),
          '',
        ].join('\n'),
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, '--once', '--cwd', cwd, '--poll-ms', '250'],
        {
          cwd,
          env: {
            ...authorityEnv,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
          encoding: 'utf8',
        },
      );

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(hookLogPath), true, 'expected needs-input hook log to be written');

      const events = (await readFile(hookLogPath, 'utf-8'))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'needs-input');
      assert.equal(events[0].source, 'derived');
      assert.equal(events[0].parser_reason, 'assistant_message_heuristic_question');
      assert.match(String((events[0].context as Record<string, unknown>)?.preview ?? ''), /Would you like me to continue/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('preserves multibyte assistant text split across polling reads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-utf8-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');

    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });
      const authorityEnv = await authenticatedWatcherEnv(cwd, 'hook-derived-utf8-session');

      await writeFile(
        join(cwd, '.omx', 'hooks', 'capture-needs-input.mjs'),
        `import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function onHookEvent(event) {
  await mkdir(dirname(${JSON.stringify(hookLogPath)}), { recursive: true });
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`,
      );

      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-utf8.jsonl');
      await writeFile(
        rolloutPath,
        `${JSON.stringify({
          type: 'session_meta',
          payload: {
            id: 'thread-hook-utf8',
            cwd,
          },
        })}\n`,
      );

      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const child = spawn(
        process.execPath,
        [watcherScript, '--cwd', cwd, '--poll-ms', '75'],
        {
          cwd,
          stdio: 'ignore',
          env: {
            ...authorityEnv,
            HOME: homeDir,
            OMX_HOOK_DERIVED_SIGNALS: '1',
            OMX_HOOK_PLUGINS: '1',
          },
        },
      );

      const watcherStatePath = join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json');
      await waitFor(async () => {
        try {
          const state = JSON.parse(await readFile(watcherStatePath, 'utf-8'));
          return state.tracked_files === 1;
        } catch {
          return false;
        }
      });

      const questionText = 'Can you preserve split emoji 🧪 please?';
      const eventLine = `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: {
          type: 'assistant_message',
          turn_id: 'turn-hook-utf8',
          content: [{ type: 'output_text', text: questionText }],
        },
      })}\n`;
      const bytes = Buffer.from(eventLine, 'utf8');
      const emojiOffset = bytes.indexOf(Buffer.from('🧪', 'utf8'));
      assert.ok(emojiOffset > 0, 'expected test payload to contain emoji bytes');

      await appendFile(rolloutPath, bytes.subarray(0, emojiOffset + 1));
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'incomplete UTF-8 and JSON line should not dispatch');

      const hiddenRolloutPath = `${rolloutPath}.missing`;
      await rename(rolloutPath, hiddenRolloutPath);
      await sleep(250);
      assert.equal(existsSync(hookLogPath), false, 'transient missing file should preserve buffered bytes');
      await rename(hiddenRolloutPath, rolloutPath);

      await appendFile(rolloutPath, bytes.subarray(emojiOffset + 1));
      await waitFor(async () => {
        if (!existsSync(hookLogPath)) return false;
        const raw = await readFile(hookLogPath, 'utf-8');
        return raw.includes('turn-hook-utf8') && raw.includes(questionText);
      }, 4000, 75);

      child.kill('SIGTERM');
      await once(child, 'exit');

      const raw = await readFile(hookLogPath, 'utf-8');
      assert.match(raw, /turn-hook-utf8/);
      assert.match(raw, /Can you preserve split emoji 🧪 please\?/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('terminates before dispatching after a committed alternate-root rollover', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-rollover-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const alternateRoot = join(base, 'alternate', 'state');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');
    const sessionId = 'hook-derived-rollover-session';
    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });
      const authorityEnv = await authenticatedWatcherEnv(cwd, sessionId);
      await writeFile(join(cwd, '.omx', 'hooks', 'capture-rollover.mjs'), `import { appendFile } from 'node:fs/promises';
export async function onHookEvent(event) {
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`);
      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-rollover.jsonl');
      await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-hook-rollover', cwd } })}\n`);
      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const child = spawn(process.execPath, [watcherScript, '--cwd', cwd, '--poll-ms', '75'], {
        cwd,
        stdio: 'ignore',
        env: { ...authorityEnv, HOME: homeDir, OMX_HOOK_DERIVED_SIGNALS: '1', OMX_HOOK_PLUGINS: '1' },
      });
      const childExit = once(child, 'exit') as Promise<[number | null]>;
      const watcherStatePath = join(cwd, '.omx', 'state', 'hook-derived-watcher-state.json');
      await waitFor(async () => existsSync(watcherStatePath));

      const initial = await resolveStateAuthorityForGuard({ startup_cwd: cwd, observed_cwd: cwd, session_id: sessionId });
      await rolloverStateAuthorityToAlternateRoot({ context: initial, transport_capability: (await mintStateAuthorityTransportCapability(initial)).capability, proposed_state_root: alternateRoot, creation_root: join(base, 'alternate'),
      launch_id: 'hook-derived-rollover-alternate',
      consumer_kind: 'boxed',
      issuer: TEST_AUTHORITY_ISSUER, });
      await appendFile(rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'assistant_message', turn_id: 'turn-after-rollover', content: 'Can you continue?' },
      })}\n`);
      const [exitCode] = await childExit;
      assert.notEqual(exitCode, 0, 'watcher must fail closed after rollover');
      assert.equal(existsSync(hookLogPath), false, 'watcher dispatched after its authority tuple changed');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
  it('terminates without recreating a replaced committed state root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'omx-hook-derived-root-replaced-'));
    const homeDir = join(base, 'home');
    const cwd = join(base, 'cwd');
    const hookLogPath = join(cwd, '.omx', 'hook-events.jsonl');
    const sessionId = 'hook-derived-root-replaced-session';
    const stateDir = join(cwd, '.omx', 'state');
    try {
      await mkdir(todaySessionDir(homeDir), { recursive: true });
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });
      const authorityEnv = await authenticatedWatcherEnv(cwd, sessionId);
      await writeFile(join(cwd, '.omx', 'hooks', 'capture-replaced.mjs'), `import { appendFile } from 'node:fs/promises';
export async function onHookEvent(event) {
  await appendFile(${JSON.stringify(hookLogPath)}, JSON.stringify(event) + '\\n');
}
`);
      const rolloutPath = join(todaySessionDir(homeDir), 'rollout-hook-derived-root-replaced.jsonl');
      await writeFile(rolloutPath, `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-hook-replaced', cwd } })}\n`);
      const watcherScript = new URL('../hook-derived-watcher.js', import.meta.url).pathname;
      const child = spawn(process.execPath, [watcherScript, '--cwd', cwd, '--poll-ms', '75'], {
        cwd,
        stdio: 'ignore',
        env: { ...authorityEnv, HOME: homeDir, OMX_HOOK_DERIVED_SIGNALS: '1', OMX_HOOK_PLUGINS: '1' },
      });
      const childExit = once(child, 'exit') as Promise<[number | null]>;
      const watcherStatePath = join(stateDir, 'hook-derived-watcher-state.json');
      await waitFor(async () => existsSync(watcherStatePath));

      await rm(stateDir, { recursive: true, force: true });
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      await appendFile(rolloutPath, `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'event_msg',
        payload: { type: 'assistant_message', turn_id: 'turn-after-root-replacement', content: 'Continue?' },
      })}\n`);

      const [exitCode] = await childExit;
      assert.notEqual(exitCode, 0, 'watcher must fail closed after state-root replacement');
      assert.equal(existsSync(watcherStatePath), false, 'watcher recreated state in a replacement root');
      assert.equal(existsSync(hookLogPath), false, 'watcher dispatched after state-root replacement');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
