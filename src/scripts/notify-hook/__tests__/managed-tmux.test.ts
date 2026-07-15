import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveHudControlPlaneDomain, writeHudTmuxBirthLineage } from '../../../mcp/state-paths.js';
import { writeSessionStart } from '../../../hooks/session.js';
import { isManagedOmxSession, tmuxEvidenceBindsCandidate } from '../managed-tmux.js';

describe('managed tmux opaque birth lineage', () => {
  it('authorizes Team-established opaque UUID lineage through production resolution only with stable dual tags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-managed-tmux-lineage-'));
    const binDir = join(cwd, 'bin');
    const previousPath = process.env.PATH;
    const previousTmuxPane = process.env.TMUX_PANE;
    const previousTmux = process.env.TMUX;
    const sessionId = 'team-logical-session';
    const sessionBirthId = '7d667f3f-4c4b-4e80-8ea5-050ba1dbfe1f';
    const paneBirthId = '388b3d25-c797-4223-bb30-3eb3511e4101';
    try {
      await writeSessionStart(cwd, sessionId);
      const domain = await resolveHudControlPlaneDomain({ cwd, requestedSessionId: sessionId });
      await writeHudTmuxBirthLineage(domain, {
        sessionId,
        tmuxSessionName: 'team-session',
        tmuxSessionInstanceId: sessionBirthId,
        tmuxPaneInstanceId: paneBirthId,
      });
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'tmux'), `#!/bin/sh
case "$1" in
display-message) printf 'team-session\t$1\t@1\t%%1\n' ;;
show-option)
  case "$*" in
    *"-p -t %1 @omx_pane_instance_id"*) printf '${paneBirthId}\n' ;;
    *"-t team-session @omx_instance_id"*) printf '${sessionBirthId}\n' ;;
    *) exit 1 ;;
  esac
  ;;
*) exit 1 ;;
esac
`);
      await chmod(join(binDir, 'tmux'), 0o755);
      process.env.PATH = `${binDir}:${previousPath ?? ''}`;
      process.env.TMUX = 'fake,1,0';
      process.env.TMUX_PANE = '%1';

      assert.equal(await isManagedOmxSession(cwd, { session_id: sessionId }, { allowTeamWorker: false }), true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousTmuxPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = previousTmuxPane;
      if (previousTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = previousTmux;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('admits every identical resolver-proven alias while restricting mixed tags to explicit pairs', () => {
    const evidence = (paneInstanceId: string, sessionInstanceId: string) => ({
      paneTarget: '%1', sessionName: 'session', paneInstanceId, sessionInstanceId,
      instanceId: paneInstanceId, source: 'pane' as const, paneTagStatus: 'present' as const, sessionTagStatus: 'present' as const,
      sessionId: '$1', windowId: '@1', contextStable: true,
    });
    const resolverLineage = ['canonical', 'native', 'previous'] as const;
    assert.equal(tmuxEvidenceBindsCandidate(evidence('canonical', 'canonical'), resolverLineage), true);
    assert.equal(tmuxEvidenceBindsCandidate(evidence('native', 'native'), resolverLineage), true);
    assert.equal(tmuxEvidenceBindsCandidate(evidence('previous', 'previous'), resolverLineage), true);
    assert.equal(tmuxEvidenceBindsCandidate(evidence('unknown', 'unknown'), resolverLineage), false);
    assert.equal(tmuxEvidenceBindsCandidate(evidence('native', 'previous'), resolverLineage), false);
    assert.equal(tmuxEvidenceBindsCandidate(evidence('canonical', 'native'), ['canonical', 'native']), true);
  });
});
