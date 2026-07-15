import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  attestLeaderThread,
  ensureLeaderAndRecordIntent,
  readSubagentTrackingState,
} from '../tracker.js';

// 32 lowercase-hex chars: the canonical correlation-token shape the CLI generates via
// randomUUID().replace(/-/g, '').
const TOKEN = 'abcdef0123456789abcdef0123456789';
const TOKEN2 = '00112233445566778899aabbccddeeff';

async function withCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-3181-bootstrap-'));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('#3181 leader bootstrap tracker carrier', () => {
  it('attests a leader and then records the adapted intent via self-heal', async () => {
    await withCwd(async (cwd) => {
      const attest = attestLeaderThread(cwd, {
        sessionId: 'sess-a',
        leaderThreadId: 'leader-thread-a',
        source: 'native-pretooluse',
      });
      assert.deepEqual(attest, { ok: true, alreadyAttested: false });

      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-a',
        parentThreadId: 'leader-thread-a',
        correlationToken: TOKEN,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.reused, false);
      assert.equal(result.intent.role, 'architect');
      assert.equal(result.intent.session_id, 'sess-a');
      assert.equal(result.intent.parent_thread_id, 'leader-thread-a');
      assert.equal(result.intent.correlation_token, TOKEN);

      const state = await readSubagentTrackingState(cwd);
      const session = state.sessions['sess-a'];
      assert.equal(session?.leader_thread_id, 'leader-thread-a');
      assert.ok(session?.leader_attested_at);
      assert.equal(session?.leader_attest_source, 'native-pretooluse');
      assert.equal(session?.threads['leader-thread-a']?.kind, 'leader');
      assert.equal(state.pending_role_intents.length, 1);
    });
  });

  it('fails closed with native_anchor_unavailable when no attestation exists', async () => {
    await withCwd(async (cwd) => {
      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-fresh',
        parentThreadId: 'codex-thread-fresh-turn',
        correlationToken: TOKEN,
      });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_unavailable' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 0);
      assert.equal(state.sessions['sess-fresh'], undefined);
    });
  });

  it('fails closed with native_anchor_mismatch when parent-thread != attested leader', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const result = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect',
        sessionId: 'sess-a',
        parentThreadId: 'attacker-thread',
        correlationToken: TOKEN,
      });
      assert.deepEqual(result, { ok: false, reason: 'native_anchor_mismatch' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 0);
    });
  });

  it('never overwrites a different existing leader (fail-closed attestation)', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const second = attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'foreign-leader', source: 'native-pretooluse' });
      assert.deepEqual(second, { ok: false, reason: 'native_anchor_mismatch' });
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.sessions['sess-a']?.leader_thread_id, 'leader-thread-a');
    });
  });

  it('is idempotent: duplicate same-identity intent reuses the original receipt', async () => {
    await withCwd(async (cwd) => {
      attestLeaderThread(cwd, { sessionId: 'sess-a', leaderThreadId: 'leader-thread-a', source: 'native-pretooluse' });
      const first = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN,
      });
      const second = ensureLeaderAndRecordIntent(cwd, {
        role: 'architect', sessionId: 'sess-a', parentThreadId: 'leader-thread-a', correlationToken: TOKEN2,
      });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) return;
      assert.equal(second.reused, true);
      assert.equal(second.intent.correlation_token, first.intent.correlation_token);
      const state = await readSubagentTrackingState(cwd);
      assert.equal(state.pending_role_intents.length, 1);
    });
  });
});
