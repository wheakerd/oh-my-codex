import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ralplanCommand } from '../ralplan.js';

async function invokeRoleIntent(cwd: string, args: string[]): Promise<{
  stdout: string[];
  stderr: string[];
  exitCode: number | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, {
      cwd: () => cwd,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

describe('ralplan role-intent write', () => {
  it('records a validated role and returns stable JSON rejection reasons', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-role-intent-'));
    try {
      const unknownRole = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'not-an-installed-role', '--parent-thread', 'leader-thread', '--session', 'sess-role-intent', '--json',
      ]);
      assert.equal(unknownRole.exitCode, 1);
      assert.deepEqual(unknownRole.stderr, []);
      assert.deepEqual(JSON.parse(unknownRole.stdout.join('\n')), { ok: false, reason: 'unknown_role' });

      const recorded = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'ARCHITECT', '--parent-thread', 'leader-thread', '--session', 'sess-role-intent', '--ttl-ms', '5000', '--json',
      ]);
      assert.equal(recorded.exitCode, undefined);
      assert.deepEqual(recorded.stderr, []);
      const receipt = JSON.parse(recorded.stdout.join('\n')) as {
        ok: boolean;
        intent: { role: string; session_id: string; parent_thread_id: string; expires_at: string };
      };
      assert.equal(receipt.ok, true);
      assert.deepEqual(Object.keys(receipt.intent), ['role', 'session_id', 'parent_thread_id', 'expires_at']);
      assert.equal(receipt.intent.role, 'architect');
      assert.equal(receipt.intent.session_id, 'sess-role-intent');
      assert.equal(receipt.intent.parent_thread_id, 'leader-thread');
      assert.ok(Number.isFinite(Date.parse(receipt.intent.expires_at)));

      const conflict = await invokeRoleIntent(cwd, [
        'role-intent', 'write', '--role', 'critic', '--parent-thread', 'leader-thread', '--session', 'sess-role-intent', '--json',
      ]);
      assert.equal(conflict.exitCode, 1);
      assert.deepEqual(conflict.stderr, []);
      assert.deepEqual(JSON.parse(conflict.stdout.join('\n')), { ok: false, reason: 'single_flight_conflict' });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
