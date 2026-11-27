/**
 * `omx supervision codex-review-loop`: scan open PRs and post `@codex review` on heads that
 * have no Codex review yet. Dry run by default; `--post` comments with the caller's own gh auth.
 * The decision is a pure function over fetched data; gh calls live in `ghAdapter`.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { getBaseStateDir } from '../mcp/state-paths.js';

const execFileAsync = promisify(execFile);

export const CODEX_REVIEW_LOOP_USAGE =
  'omx supervision codex-review-loop [--repo owner/name] [--post] [--watch [seconds]] [--json]';
export const CODEX_REVIEW_COMMENT = '@codex review';
export const DEFAULT_WATCH_SECONDS = 600;
export const MAX_POSTS_PER_PASS = 10;
export const BLOCK_MS = 24 * 60 * 60 * 1000;

export interface PrReview { login: string; commitId: string }
export interface PrComment { login: string; body: string; createdAt: string }
export interface PrSnapshot {
  number: number;
  draft: boolean;
  headSha: string;
  headCommittedAt: string;
  reviews: PrReview[];
  comments: PrComment[];
}

export type DecisionKind = 'skip-reviewed' | 'skip-pending' | 'post' | 'blocked' | 'capped';
export interface PrDecision { number: number; headSha: string; draft: boolean; decision: DecisionKind; reason: string }
export interface LoopPlan { decisions: PrDecision[]; blockedUntil: string | null; computedBlockUntil: string | null }

const isCodex = (login: string): boolean => /codex/i.test(login);
const ms = (iso: string): number => Date.parse(iso);

const isTrigger = (c: PrComment): boolean => !isCodex(c.login) && c.body.includes('@codex');
const isLimitReply = (c: PrComment): boolean => isCodex(c.login) && /usage limits/i.test(c.body);

/** Usage-limit replies on one PR paired with the nearest preceding `@codex` trigger they answer. */
function limitReplies(comments: readonly PrComment[]): { trigger: PrComment; reply: PrComment }[] {
  const sorted = [...comments].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const out: { trigger: PrComment; reply: PrComment }[] = [];
  let last: PrComment | null = null;
  for (const c of sorted) {
    if (isTrigger(c)) last = c;
    else if (isLimitReply(c) && last) out.push({ trigger: last, reply: c });
  }
  return out;
}

/** Newest usage-limit reply to one of `login`'s own triggers (after their newest trigger), +24h. Quota is per triggering account. */
export function computeBlockUntil(prs: readonly PrSnapshot[], login: string): string | null {
  let lastTrigger = -Infinity;
  for (const pr of prs) {
    for (const c of pr.comments) if (isTrigger(c) && c.login === login) lastTrigger = Math.max(lastTrigger, ms(c.createdAt));
  }
  let newest = -Infinity;
  for (const pr of prs) {
    for (const { trigger, reply } of limitReplies(pr.comments)) {
      if (trigger.login === login && ms(reply.createdAt) > lastTrigger) newest = Math.max(newest, ms(reply.createdAt));
    }
  }
  return Number.isFinite(newest) ? new Date(newest + BLOCK_MS).toISOString() : null;
}

export function decideReviewLoop(
  prs: readonly PrSnapshot[],
  opts: { now: number; login: string; stateBlockedUntil?: string | null; cap?: number },
): LoopPlan {
  const cap = opts.cap ?? MAX_POSTS_PER_PASS;
  const computed = computeBlockUntil(prs, opts.login);
  const until = Math.max(computed ? ms(computed) : -Infinity, opts.stateBlockedUntil ? ms(opts.stateBlockedUntil) : -Infinity);
  const blocked = until > opts.now;
  let posts = 0;
  const decisions = prs.map((pr): PrDecision => {
    const base = { number: pr.number, headSha: pr.headSha, draft: pr.draft };
    if (pr.reviews.some((r) => isCodex(r.login) && r.commitId === pr.headSha)) {
      return { ...base, decision: 'skip-reviewed', reason: 'Codex review exists on this head' };
    }
    const committed = ms(pr.headCommittedAt);
    const stale = new Set(limitReplies(pr.comments).map((x) => x.trigger));
    const pending = pr.comments.some((t) => isTrigger(t) && ms(t.createdAt) > committed && !stale.has(t));
    if (pending) return { ...base, decision: 'skip-pending', reason: 'trigger posted after head commit, no usage-limit reply' };
    if (blocked) return { ...base, decision: 'blocked', reason: `blocked until ${new Date(until).toISOString()}` };
    if (posts >= cap) return { ...base, decision: 'capped', reason: `post cap ${cap} reached this pass` };
    posts += 1;
    return { ...base, decision: 'post', reason: 'no Codex review or live trigger on this head' };
  });
  return { decisions, blockedUntil: blocked ? new Date(until).toISOString() : null, computedBlockUntil: computed };
}

// ---------------------------------------------------------------------------
// gh adapter
// ---------------------------------------------------------------------------

export interface ReviewLoopAdapter {
  currentLogin(): Promise<string>;
  fetchPrs(repo: string): Promise<PrSnapshot[]>;
  postComment(repo: string, number: number, body: string): Promise<void>;
}

async function gh(args: string[], input?: string): Promise<string> {
  const child = execFileAsync('gh', args, { maxBuffer: 64 * 1024 * 1024 });
  if (input !== undefined) child.child.stdin?.end(input);
  return (await child).stdout;
}

/** `--paginate --jq '.[]'` prints one compact JSON object per line (old gh concatenates raw arrays). */
async function ghList<T>(path: string): Promise<T[]> {
  const out = await gh(['api', '--paginate', path, '--jq', '.[]']);
  return out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export const ghAdapter: ReviewLoopAdapter = {
  async currentLogin() {
    const login = (await gh(['api', 'user', '--jq', '.login'])).trim();
    if (!login) throw new Error('could not resolve the gh login (gh api user)');
    return login;
  },
  async fetchPrs(repo) {
    const open = await ghList<{ number: number; draft?: boolean }>(`repos/${repo}/pulls?state=open&per_page=100`);
    const out: PrSnapshot[] = [];
    for (const { number } of open) {
      const pr = JSON.parse(await gh(['api', `repos/${repo}/pulls/${number}`])) as { draft?: boolean; head: { sha: string } };
      const sha = pr.head.sha;
      const [reviews, comments, commit] = await Promise.all([
        ghList<{ user?: { login: string } | null; commit_id: string }>(`repos/${repo}/pulls/${number}/reviews?per_page=100`),
        ghList<{ user?: { login: string } | null; body?: string; created_at: string }>(`repos/${repo}/issues/${number}/comments?per_page=100`),
        gh(['api', `repos/${repo}/commits/${sha}`]).then((s) => JSON.parse(s) as { commit: { committer: { date: string } } }),
      ]);
      out.push({
        number,
        draft: Boolean(pr.draft),
        headSha: sha,
        headCommittedAt: commit.commit.committer.date,
        reviews: reviews.map((r) => ({ login: r.user?.login ?? '', commitId: r.commit_id })),
        comments: comments.map((c) => ({ login: c.user?.login ?? '', body: c.body ?? '', createdAt: c.created_at })),
      });
    }
    return out;
  },
  async postComment(repo, number, body) {
    await gh(['api', `repos/${repo}/issues/${number}/comments`, '-F', 'body=@-'], body);
  },
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CodexReviewLoopOptions { repo?: string; post: boolean; watch: number | null; json: boolean; help: boolean }

export function parseCodexReviewLoopArgs(args: readonly string[]): CodexReviewLoopOptions {
  const o: CodexReviewLoopOptions = { post: false, watch: null, json: false, help: false };
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i] as string;
    if (t === '--post') o.post = true;
    else if (t === '--json') o.json = true;
    else if (t === '--help' || t === '-h') o.help = true;
    else if (t === '--repo' || t.startsWith('--repo=')) {
      const v = t === '--repo' ? args[++i] : t.slice('--repo='.length);
      if (!v || !/^[\w.-]+\/[\w.-]+$/.test(v)) throw new Error(`--repo expects owner/name, got: ${v ?? '(missing)'}`);
      o.repo = v;
    } else if (t === '--watch' || t.startsWith('--watch=')) {
      let raw: string | undefined = t.startsWith('--watch=') ? t.slice('--watch='.length) : undefined;
      if (raw === undefined && /^\d+$/.test(args[i + 1] ?? '')) raw = args[++i];
      const n = raw === undefined ? DEFAULT_WATCH_SECONDS : Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--watch expects positive seconds, got: ${raw}`);
      o.watch = n;
    } else throw new Error(`Unknown option for codex-review-loop: ${t}\nUsage: ${CODEX_REVIEW_LOOP_USAGE}`);
  }
  return o;
}

export function originRepo(cwd: string): string {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf-8' }).trim();
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new Error(`origin is not a GitHub repo: ${url}`);
  return m[1] as string;
}

function statePath(cwd: string): string {
  return join(getBaseStateDir(cwd), 'supervision', 'codex-review-loop.json');
}

type BlockState = Record<string, { blocked_until?: unknown }>;

async function readState(cwd: string): Promise<BlockState> {
  try {
    const v = JSON.parse(await readFile(statePath(cwd), 'utf-8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as BlockState) : {};
  } catch { return {}; }
}

function blockedUntilOf(state: BlockState, login: string): string | null {
  const v = state[login]?.blocked_until;
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;
}

export interface ReviewLoopDeps { adapter: ReviewLoopAdapter; cwd: string; now: () => number; log: (s: string) => void }

export async function runCodexReviewLoopPass(opts: CodexReviewLoopOptions, repo: string, deps: ReviewLoopDeps): Promise<LoopPlan> {
  const login = await deps.adapter.currentLogin();
  const prs = await deps.adapter.fetchPrs(repo);
  const state = await readState(deps.cwd);
  const stored = blockedUntilOf(state, login);
  const plan = decideReviewLoop(prs, { now: deps.now(), login, stateBlockedUntil: stored });
  const until = plan.computedBlockUntil;
  if (until && Date.parse(until) > deps.now() && until !== stored) {
    await mkdir(dirname(statePath(deps.cwd)), { recursive: true });
    await writeFile(statePath(deps.cwd), `${JSON.stringify({ ...state, [login]: { blocked_until: until } })}\n`);
  }
  if (opts.post) {
    for (const d of plan.decisions) if (d.decision === 'post') await deps.adapter.postComment(repo, d.number, CODEX_REVIEW_COMMENT);
  }
  if (opts.json) deps.log(JSON.stringify({ repo, login, post: opts.post, ...plan }, null, 2));
  else {
    deps.log(`codex-review-loop ${repo} as ${login} (${opts.post ? 'POST' : 'dry run'}), ${plan.decisions.length} open PRs`);
    if (plan.blockedUntil) deps.log(`blocked until ${plan.blockedUntil}`);
    for (const d of plan.decisions) {
      deps.log(`#${d.number}${d.draft ? ' (draft)' : ''} ${d.headSha.slice(0, 9)} ${d.decision}${opts.post && d.decision === 'post' ? ' (posted)' : ''}: ${d.reason}`);
    }
  }
  return plan;
}

export async function codexReviewLoopCommand(args: readonly string[], overrides: Partial<ReviewLoopDeps> = {}): Promise<void> {
  const opts = parseCodexReviewLoopArgs(args);
  if (opts.help) {
    console.log(`Usage: ${CODEX_REVIEW_LOOP_USAGE}\n\nPosts "${CODEX_REVIEW_COMMENT}" on open PRs whose head has no Codex review. Dry run unless --post.`);
    return;
  }
  const cwd = overrides.cwd ?? process.cwd();
  const deps: ReviewLoopDeps = { adapter: ghAdapter, cwd, now: Date.now, log: console.log, ...overrides };
  const repo = opts.repo ?? originRepo(cwd);
  if (opts.watch === null) {
    await runCodexReviewLoopPass(opts, repo, deps);
    return;
  }
  let stop = false;
  let wake: (() => void) | undefined;
  process.once('SIGINT', () => { stop = true; wake?.(); });
  while (!stop) {
    try { await runCodexReviewLoopPass(opts, repo, deps); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); }
    if (stop) break;
    await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, (opts.watch as number) * 1000); });
  }
}
