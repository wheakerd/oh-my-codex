import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSessionStart } from '../../hooks/session.js';

function runOmx(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const omxBin = join(repoRoot, 'dist', 'cli', 'omx.js');
  return spawnSync(process.execPath, [omxBin, ...argv], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_AUTO_UPDATE: '0',
      OMX_NOTIFY_FALLBACK: '0',
      OMX_HOOK_DERIVED_SIGNALS: '0',
      OMX_ROOT: undefined,
      OMX_STATE_ROOT: undefined,
      OMX_TEAM_STATE_ROOT: undefined,
      ...env,
    },
  });
}

describe('nested help routing', () => {
  for (const [argv, expectedUsage] of [
    [['adapt', '--help'], /Usage:\s*omx adapt <target> <probe\|status\|init\|envelope\|doctor>/i],
    [['ask', '--help'], /Usage:\s*omx ask <claude\|gemini> <question or task>/i],
    [['question', '--help'], /omx question - OMX-owned blocking user question entrypoint/i],
    [['autoresearch', '--help'], /hard-deprecated legacy command surface[\s\S]*\$autoresearch/i],
    [['explore', '--help'], /hard-deprecated legacy command surface[\s\S]*omx sparkshell/i],
    [['hud', '--help'], /Usage:\s*\n\s*omx hud\s+Show current HUD state/i],
    [['hooks', '--help'], /Usage:\s*\n\s*omx hooks init/i],
    [['state', '--help'], /Usage:\s*omx state <read\|write\|clear\|list-active\|get-status>/i],
    [['notepad', '--help'], /Usage:\s*omx notepad <tool-name>[\s\S]*Available tools:[\s\S]*notepad_read/i],
    [['project-memory', '--help'], /Usage:\s*omx project-memory <tool-name>[\s\S]*Available tools:[\s\S]*project_memory_read/i],
    [['trace', '--help'], /Usage:\s*omx trace <tool-name>[\s\S]*Available tools:[\s\S]*trace_timeline/i],
    [['code-intel', '--help'], /Usage:\s*omx code-intel <tool-name>[\s\S]*Available tools:[\s\S]*lsp_diagnostics/i],
    [['mcp-serve', '--help'], /Usage:\s*omx mcp-serve <target>/i],
    [['tmux-hook', '--help'], /Usage:\s*\n\s*omx tmux-hook init/i],
    [['ralph', '--help'], /omx ralph - Launch Codex with ralph persistence mode active/i],
  ] satisfies Array<[string[], RegExp]>) {
    it(`routes ${argv.join(' ')} to command-local help`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), 'omx-nested-help-'));
      try {
        const result = runOmx(cwd, argv);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, expectedUsage);
        assert.doesNotMatch(result.stdout, /oh-my-codex \(omx\) - Multi-agent orchestration for Codex CLI/i);
        if (argv[0] === 'hud') assert.equal(existsSync(join(cwd, '.omx')), false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  it('routes `omx state read` through the top-level CLI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-state-route-'));
    try {
      const result = runOmx(cwd, ['state', 'read', '--input', '{"mode":"ralph"}', '--json']);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout.trim(), /^\{"exists":false,"mode":"ralph"\}$/);
      assert.doesNotMatch(result.stdout, /Unknown command: state/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects command-local conflicting root aliases for packaged state write and clear', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-state-packed-root-alias-'));
    const sessionId = 'sess-packed-root-alias';
    try {
      await writeSessionStart(cwd, sessionId);
      const writeArgs = ['state', 'write', '--input', JSON.stringify({
        mode: 'autoresearch', active: true, current_phase: 'running', session_id: sessionId,
      }), '--json'];
      const clearArgs = ['state', 'clear', '--input', JSON.stringify({
        mode: 'autoresearch', session_id: sessionId,
      }), '--json'];
      const established = runOmx(cwd, writeArgs);
      assert.equal(established.status, 0, established.stderr || established.stdout);

      for (const envName of ['OMX_TEAM_STATE_ROOT', 'OMX_ROOT', 'OMX_STATE_ROOT'] as const) {
        const ambientRoot = await mkdtemp(join(tmpdir(), `omx-state-packed-${envName.toLowerCase()}-`));
        try {
          await mkdir(join(ambientRoot, '.omx', 'state'), { recursive: true });
          const env = {
            [envName]: envName === 'OMX_TEAM_STATE_ROOT' ? join(ambientRoot, '.omx', 'state') : ambientRoot,
          };
          const rejectedWrite = runOmx(cwd, writeArgs, env);
          assert.equal(rejectedWrite.status, 1, rejectedWrite.stderr || rejectedWrite.stdout);
          assert.match(rejectedWrite.stderr, /conflicts with .*authenticated.*authority/);
          const rejectedClear = runOmx(cwd, clearArgs, env);
          assert.equal(rejectedClear.status, 1, rejectedClear.stderr || rejectedClear.stdout);
          assert.match(rejectedClear.stderr, /conflicts with .*authenticated.*authority/);
        } finally {
          await rm(ambientRoot, { recursive: true, force: true });
        }
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
