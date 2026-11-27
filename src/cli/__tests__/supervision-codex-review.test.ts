import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideReviewLoop,
  codexReviewLoopCommand,
  parseCodexReviewLoopArgs,
  type PrSnapshot,
  type ReviewLoopAdapter,
} from '../supervision-codex-review.js';

const NOW = Date.parse('2026-11-28T00:00:00Z');
const pr = (over: Partial<PrSnapshot> = {}): PrSnapshot => ({
  number: 1, draft: false, headSha: 'bbbb', headCommittedAt: '2026-11-27T10:00:00Z', reviews: [], comments: [], ...over,
});
const ME = 'iqdoctor';
const trigger = (createdAt: string, login = ME) => ({ login, body: '@codex review', createdAt });
const limit = (createdAt: string) => ({ login: 'chatgpt-codex-connector[bot]', body: 'You have reached your Codex usage limits', createdAt });
const kinds = (prs: PrSnapshot[], o: Partial<Parameters<typeof decideReviewLoop>[1]> = {}) =>
  decideReviewLoop(prs, { now: NOW, login: ME, ...o }).decisions.map((d) => d.decision);

describe('decideReviewLoop', () => {
  it('skips a PR reviewed on the head', () => {
    assert.deepEqual(kinds([pr({ reviews: [{ login: 'chatgpt-codex-connector[bot]', commitId: 'bbbb' }] })]), ['skip-reviewed']);
  });
  it('posts when the review is only on an older head', () => {
    assert.deepEqual(kinds([pr({ reviews: [{ login: 'chatgpt-codex-connector[bot]', commitId: 'aaaa' }] })]), ['post']);
  });
  it('skips pending trigger posted after the head commit', () => {
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z')] })]), ['skip-pending']);
  });
  it('ignores a trigger older than the head commit', () => {
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T09:00:00Z')] })]), ['post']);
  });
  it('usage-limit reply makes the trigger stale and sets the block', () => {
    const plan = decideReviewLoop([pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z')] }), pr({ number: 2 })], { now: NOW, login: ME });
    assert.equal(plan.decisions[0]?.decision, 'blocked');
    assert.equal(plan.decisions[1]?.decision, 'blocked');
    assert.equal(plan.computedBlockUntil, '2026-11-28T11:01:00.000Z');
    assert.equal(plan.blockedUntil, '2026-11-28T11:01:00.000Z');
  });
  it('block expires after 24h', () => {
    const plan = decideReviewLoop([pr({ comments: [trigger('2026-11-25T11:00:00Z'), limit('2026-11-25T11:01:00Z')] })], { now: NOW, login: ME });
    assert.equal(plan.blockedUntil, null);
    assert.equal(plan.decisions[0]?.decision, 'post');
  });
  it('honours a stored block and ignores an expired stored block', () => {
    assert.deepEqual(kinds([pr()], { stateBlockedUntil: '2026-11-28T14:30:00Z' }), ['blocked']);
    assert.deepEqual(kinds([pr()], { stateBlockedUntil: '2026-11-27T14:30:00Z' }), ['post']);
  });
  it('usage-limit reply older than our latest trigger does not block', () => {
    assert.deepEqual(kinds([pr({ comments: [limit('2026-11-27T11:01:00Z'), trigger('2026-11-27T12:00:00Z')] })]), ['skip-pending']);
  });
  it("another account's usage limit does not block the caller", () => {
    const prs = [pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else'), limit('2026-11-27T11:01:00Z')] }), pr({ number: 2 })];
    const plan = decideReviewLoop(prs, { now: NOW, login: ME });
    assert.equal(plan.computedBlockUntil, null);
    assert.equal(plan.blockedUntil, null);
    assert.equal(plan.decisions[1]?.decision, 'post');
  });
  it("the caller's own usage limit blocks the caller, not another account", () => {
    const prs = [pr({ comments: [trigger('2026-11-27T11:00:00Z'), limit('2026-11-27T11:01:00Z')] }), pr({ number: 2 })];
    assert.equal(decideReviewLoop(prs, { now: NOW, login: ME }).decisions[1]?.decision, 'blocked');
    assert.equal(decideReviewLoop(prs, { now: NOW, login: 'someone-else' }).decisions[1]?.decision, 'post');
  });
  it("another account's limited trigger is not pending, an unanswered one is", () => {
    const limited = pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else'), limit('2026-11-27T11:01:00Z')] });
    assert.deepEqual(kinds([limited]), ['post']);
    assert.deepEqual(kinds([pr({ comments: [trigger('2026-11-27T11:00:00Z', 'someone-else')] })]), ['skip-pending']);
  });
  it('caps posts per pass', () => {
    const prs = Array.from({ length: 12 }, (_, i) => pr({ number: i + 1 }));
    const k = kinds(prs);
    assert.equal(k.filter((x) => x === 'post').length, 10);
    assert.equal(k.filter((x) => x === 'capped').length, 2);
  });
  it('includes drafts', () => {
    assert.deepEqual(kinds([pr({ draft: true })]), ['post']);
  });
});

describe('codex-review-loop CLI', () => {
  const adapter = (posted: number[]): ReviewLoopAdapter => ({
    currentLogin: async () => ME,
    fetchPrs: async () => [pr({ number: 7 })],
    postComment: async (_r, n) => { posted.push(n); },
  });

  it('dry run never posts', async () => {
    const posted: number[] = [];
    const cwd = await mkdtemp(join(tmpdir(), 'crl-'));
    const out: string[] = [];
    try {
      await codexReviewLoopCommand(['--repo', 'o/r'], { adapter: adapter(posted), cwd, now: () => NOW, log: (s) => out.push(s) });
    } finally { await rm(cwd, { recursive: true, force: true }); }
    assert.deepEqual(posted, []);
    assert.match(out.join('\n'), /#7 bbbb post/);
  });

  it('--post comments and persists the block state', async () => {
    const posted: number[] = [];
    const cwd = await mkdtemp(join(tmpdir(), 'crl-'));
    try {
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], { adapter: adapter(posted), cwd, now: () => NOW, log: () => {} });
      assert.deepEqual(posted, [7]);
      const blocked: ReviewLoopAdapter = {
        currentLogin: async () => ME,
        fetchPrs: async () => [pr({ comments: [trigger('2026-11-27T23:00:00Z'), limit('2026-11-27T23:30:00Z')] })],
        postComment: async () => { throw new Error('must not post'); },
      };
      await codexReviewLoopCommand(['--repo', 'o/r', '--post'], { adapter: blocked, cwd, now: () => NOW, log: () => {} });
      const state = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'supervision', 'codex-review-loop.json'), 'utf-8'));
      assert.equal(state[ME].blocked_until, '2026-11-28T23:30:00.000Z');
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it('parses --watch with and without seconds', () => {
    assert.equal(parseCodexReviewLoopArgs(['--watch']).watch, 600);
    assert.equal(parseCodexReviewLoopArgs(['--watch', '30', '--json']).watch, 30);
    assert.throws(() => parseCodexReviewLoopArgs(['--bogus']));
  });
});
