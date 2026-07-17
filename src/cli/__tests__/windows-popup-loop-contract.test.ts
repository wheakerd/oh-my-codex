import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const cliIndex = readFileSync(join(repoRoot, 'src', 'cli', 'index.ts'), 'utf-8');
const starPrompt = readFileSync(join(repoRoot, 'src', 'cli', 'star-prompt.ts'), 'utf-8');
const updateSource = readFileSync(join(repoRoot, 'src', 'cli', 'update.ts'), 'utf-8');
const notifierSource = readFileSync(join(repoRoot, 'src', 'notifications', 'notifier.ts'), 'utf-8');
const replyListenerSource = readFileSync(join(repoRoot, 'src', 'notifications', 'reply-listener.ts'), 'utf-8');
const fallbackWatcherSource = readFileSync(join(repoRoot, 'src', 'scripts', 'notify-fallback-watcher.ts'), 'utf-8');

describe('Windows popup loop contracts', () => {
  it('keeps Windows helper spawns hidden', () => {
    assert.match(cliIndex, /buildWindowsMsysBackgroundHelperBootstrapScript/);
    assert.match(
      cliIndex,
      /withStateAuthorityTransaction\(authority,\s*async \(pinnedAuthority\) => \{\s+const pidPath = join\(\s+pinnedAuthority\.canonical_state_root,\s+"notify-fallback\.pid",\s+\);\s+const reapResult = await reapStaleNotifyFallbackWatcher\(pidPath, pinnedAuthority\);\s+if \(reapResult === "recent_active"\) return;/,
    );
    assert.match(cliIndex, /detached:\s*shouldDetachBackgroundHelper\(options\.env,\s*process\.platform\),\s*[\s\S]*?stdio:\s*"ignore",\s*[\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /spawnSync\([\s\S]*?buildWindowsMsysBackgroundHelperBootstrapScript\([\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /detached:\s*true,\s*stdio:\s*'ignore',\s*windowsHide:\s*true/);
    assert.match(cliIndex, /execFileSync\(tmuxCommand,[\s\S]*?\{ stdio: 'ignore', windowsHide: true \}/);
    assert.match(cliIndex, /spawnSync\(\s*process\.execPath,\s*\[watcherScript,\s*"--once",\s*"--cwd",\s*cwd,\s*"--notify-script",\s*notifyScript\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(cliIndex, /spawnSync\(process\.execPath,\s*\[watcherScript,\s*"--once",\s*"--cwd",\s*cwd\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(starPrompt, /spawnSyncFn\('gh',\s*\['api',[\s\S]*?windowsHide:\s*true/);
    assert.match(updateSource, /spawnNpmSync\(\s*\[\s*'install',\s*'-g',[\s\S]*?windowsHide:\s*true/);
    assert.match(notifierSource, /execFileAsync\(cmd,\s*args,\s*\{\s*windowsHide:\s*true\s*\}\)/);
    assert.match(replyListenerSource, /spawn\('node',\s*\['-e',\s*daemonScript\],\s*\{[\s\S]*?windowsHide:\s*true/);
    assert.match(fallbackWatcherSource, /sendPaneInput\(\{/);
    assert.doesNotMatch(fallbackWatcherSource, /spawnSync\('tmux'/);
  });
});
