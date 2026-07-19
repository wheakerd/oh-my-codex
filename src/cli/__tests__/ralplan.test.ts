import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ralplanCommand, type RalplanCommandDependencies } from '../ralplan.js';

async function invoke(
  args: string[],
  deps: Omit<RalplanCommandDependencies, 'stdout' | 'stderr'> = {},
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    await ralplanCommand(args, {
      ...deps,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });
    return { stdout, stderr, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

describe('ralplan documented leader-proof boundary', () => {
  it('preflights by neutralizing routing-only Ralplan state and emits the exact JSON denial', async () => {
    const clears: Array<{ operation: string; input: Record<string, unknown> }> = [];
    const result = await invoke(['preflight', '--json'], {
      cwd: () => '/workspace',
      clearRalplanState: async (operation, input) => {
        clears.push({ operation, input: input ?? {} });
        return { payload: { cleared: true }, isError: false };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
      ok: false,
      reason: 'unsupported_documented_leader_proof',
    });
    assert.deepEqual(clears, [{
      operation: 'state_clear',
      input: { workingDirectory: '/workspace', mode: 'ralplan' },
    }]);
  });

  it('denies every syntactically valid installed-role write before authority resolution', async () => {
    for (const args of [
      ['role-intent', 'write', '--role', 'architect', '--parent-thread', 'leader', '--json'],
      ['role-intent', 'write', '--json', '--parent-thread=explicit-parent', '--role=ARCHITECT'],
      ['role-intent', 'write', '--session', 'claimed-session', '--ttl-ms=1000', '--parent-thread', 'leader', '--role', 'architect', '--json'],
    ]) {
      const result = await invoke(args, {
        cwd: () => '/not-used',
      });
      assert.equal(result.exitCode, 1, args.join(' '));
      assert.deepEqual(result.stderr, [], args.join(' '));
      assert.deepEqual(JSON.parse(result.stdout.join('\n')), {
        ok: false,
        reason: 'unsupported_documented_leader_proof',
      }, args.join(' '));
    }
  });

  it('retains unknown-role validation as a non-authority denial', async () => {
    const result = await invoke([
      'role-intent', 'write', '--parent-thread', 'leader', '--role', 'not-an-installed-role', '--json',
    ]);

    assert.equal(result.exitCode, 1);
    assert.deepEqual(JSON.parse(result.stdout.join('\n')), { ok: false, reason: 'unknown_role' });
  });
});
