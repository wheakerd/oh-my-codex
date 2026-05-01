import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { TEAM_NAME_SAFE_PATTERN } from '../contracts.js';
import { buildInternalTeamName, resolveTeamIdentityScope, resolveTeamNameForCurrentContext, TeamLookupAmbiguityError } from '../team-identity.js';
import { initTeamState } from '../state.js';

const longDisplay = 'this-is-a-very-long-team-display-name-that-would-overflow';

describe('team identity', () => {
  it('builds stable valid internal names for same display and distinct sessions', () => {
    const a = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const b = buildInternalTeamName(longDisplay, { sessionId: 'session-b', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const a2 = buildInternalTeamName(longDisplay, { sessionId: 'session-a', paneId: '', tmuxTarget: '', runId: '', source: 'env-session' });
    const runA = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-a', source: 'run-id' });
    const runB = buildInternalTeamName('demo', { sessionId: '', paneId: '', tmuxTarget: '', runId: 'run-b', source: 'run-id' });

    assert.notEqual(a, b);
    assert.notEqual(runA, runB);
    assert.equal(a, a2);
    assert.equal(a.length <= 30, true);
    assert.match(a, TEAM_NAME_SAFE_PATTERN);
  });

  it('does not use cwd session.json as the identity source when env is absent', () => {
    const scope = resolveTeamIdentityScope({ TMUX: '/tmp/tmux,1,0', TMUX_PANE: '%42' });
    assert.equal(scope.source, 'tmux-pane');
    assert.equal(scope.paneId, '%42');
  });

  it('resolves display names to the current session candidate and fails closed on ambiguity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-team-identity-'));
    try {
      await initTeamState('demo-aaaaaaaa', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-a' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });
      await initTeamState('demo-bbbbbbbb', 'task', 'executor', 1, cwd, undefined, { OMX_SESSION_ID: 'session-b' }, {
        display_name: 'demo', requested_name: 'demo', identity_source: 'env-session',
      });

      assert.equal(resolveTeamNameForCurrentContext('demo', cwd, { OMX_SESSION_ID: 'session-a' }), 'demo-aaaaaaaa');
      assert.equal(resolveTeamNameForCurrentContext('demo-bbbbbbbb', cwd, {}), 'demo-bbbbbbbb');
      assert.throws(() => resolveTeamNameForCurrentContext('demo', cwd, {}), TeamLookupAmbiguityError);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
