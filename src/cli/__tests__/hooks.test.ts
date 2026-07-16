import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hooksCommand } from '../hooks.js';
import { initializeStateAuthority, mintStateAuthorityTransportCapability, resolveStateAuthorityForGuard } from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';

const AUTHORITY_TRANSPORT_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_STARTUP_CWD',
  'OMX_STATE_AUTHORITY_PATH',
  'OMX_STATE_AUTHORITY_ID',
  'OMX_STATE_AUTHORITY_GENERATION_ID',
  'OMX_STATE_AUTHORITY_WORKSPACE_DIGEST',
  'OMX_STATE_AUTHORITY_CAPABILITY',
] as const;

async function authenticatedHooksEnv(cwd: string): Promise<NodeJS.ProcessEnv> {
  await mkdir(join(cwd, '.omx'), { recursive: true, mode: 0o700 });
  await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: 'hooks-command-plugin-env',
    session_binding: { canonical_session_id: 'hooks-command-plugin-env' },
  });
  const authority = await resolveStateAuthorityForGuard({
    startup_cwd: cwd,
    observed_cwd: cwd,
    session_id: 'hooks-command-plugin-env',
  });
  await mintStateAuthorityTransportCapability(authority);
  return buildStateAuthorityTransportEnv(authority, process.env);
}

async function captureHooksCommand(args: string[], env: { OMX_HOOK_PLUGINS?: string }): Promise<string[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'hooks-command-'));
  const originalCwd = process.cwd();
  const originalEnv = process.env.OMX_HOOK_PLUGINS;
  const originalLog = console.log;
  const logs: string[] = [];

  console.log = (...items: unknown[]) => {
    logs.push(items.map(String).join(' '));
  };

  if (env.OMX_HOOK_PLUGINS === undefined) {
    delete process.env.OMX_HOOK_PLUGINS;
  } else {
    process.env.OMX_HOOK_PLUGINS = env.OMX_HOOK_PLUGINS;
  }

  process.chdir(cwd);

  try {
    await hooksCommand(args);
    return logs;
  } finally {
    process.chdir(originalCwd);
    if (originalEnv === undefined) {
      delete process.env.OMX_HOOK_PLUGINS;
    } else {
      process.env.OMX_HOOK_PLUGINS = originalEnv;
    }
    console.log = originalLog;
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('hooksCommand', () => {
  it('reports plugins enabled by default in help output', async () => {
    const logs = await captureHooksCommand(['--help'], {});
    assert.match(logs.join('\n'), /Plugins are enabled by default\. Disable with OMX_HOOK_PLUGINS=0\./);
  });

  it('reports init output with the same enabled-by-default wording', async () => {
    const logs = await captureHooksCommand(['init'], {});
    assert.match(logs.join('\n'), /Plugins are enabled by default\. Disable with OMX_HOOK_PLUGINS=0\./);
  });

  it('reports status as disabled only when OMX_HOOK_PLUGINS=0', async () => {
    const enabledLogs = await captureHooksCommand(['status'], {});
    assert.match(enabledLogs.join('\n'), /Plugins enabled: yes/);

    const disabledLogs = await captureHooksCommand(['status'], { OMX_HOOK_PLUGINS: '0' });
    assert.match(disabledLogs.join('\n'), /Plugins enabled: no \(disabled with OMX_HOOK_PLUGINS=0\)/);
  });

  it('does not pass authority capability or root transport to hooks test plugins', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'hooks-command-plugin-env-'));
    const capturePath = join(cwd, 'plugin-env.json');
    const originalCwd = process.cwd();
    const previous = new Map(AUTHORITY_TRANSPORT_ENV_KEYS.map((key) => [key, process.env[key]]));
    const originalLog = console.log;
    try {
      const authorityEnv = await authenticatedHooksEnv(cwd);
      await mkdir(join(cwd, '.omx', 'hooks'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'hooks', 'capture-env.mjs'), `import { writeFile } from 'node:fs/promises';
export async function onHookEvent() {
  await writeFile(${JSON.stringify(capturePath)}, JSON.stringify(process.env));
}
`);
      for (const key of AUTHORITY_TRANSPORT_ENV_KEYS) process.env[key] = authorityEnv[key];
      process.chdir(cwd);
      console.log = () => {};

      await hooksCommand(['test']);

      const pluginEnv = JSON.parse(await readFile(capturePath, 'utf8')) as NodeJS.ProcessEnv;
      for (const key of AUTHORITY_TRANSPORT_ENV_KEYS) {
        assert.equal(pluginEnv[key], undefined, `plugin received ${key}`);
      }
    } finally {
      console.log = originalLog;
      process.chdir(originalCwd);
      for (const key of AUTHORITY_TRANSPORT_ENV_KEYS) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
