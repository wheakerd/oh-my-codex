import { createHash, randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { TEAM_NAME_SAFE_PATTERN } from './contracts.js';

export interface TeamIdentityScope {
  sessionId: string;
  paneId: string;
  tmuxTarget: string;
  runId: string;
  source: 'env-session' | 'tmux-pane' | 'run-id';
}

export interface TeamLookupCandidate {
  teamName: string;
  displayName: string;
  requestedName: string;
  leaderSessionId: string;
  leaderPaneId: string;
  tmuxSession: string;
}

export class TeamLookupAmbiguityError extends Error {
  readonly candidates: TeamLookupCandidate[];

  constructor(input: string, candidates: TeamLookupCandidate[]) {
    super(`ambiguous_team_name:${input}:${candidates.map((c) => c.teamName).join(',')}`);
    this.name = 'TeamLookupAmbiguityError';
    this.candidates = candidates;
  }
}

function sanitizeBase(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || 'team';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function resolveTeamIdentityScope(env: NodeJS.ProcessEnv = process.env): TeamIdentityScope {
  const sessionId = (env.OMX_SESSION_ID || env.CODEX_SESSION_ID || env.SESSION_ID || '').trim();
  if (sessionId) {
    return { sessionId, paneId: (env.TMUX_PANE || '').trim(), tmuxTarget: (env.TMUX || '').trim(), runId: '', source: 'env-session' };
  }

  const paneId = (env.TMUX_PANE || '').trim();
  const tmuxTarget = (env.TMUX || '').trim();
  if (paneId || tmuxTarget) {
    return { sessionId: '', paneId, tmuxTarget, runId: '', source: 'tmux-pane' };
  }

  return { sessionId: '', paneId: '', tmuxTarget: '', runId: randomUUID(), source: 'run-id' };
}

export function buildInternalTeamName(displayName: string, scope: TeamIdentityScope): string {
  const base = sanitizeBase(displayName);
  const identity = scope.sessionId || (scope.tmuxTarget || scope.paneId ? `${scope.tmuxTarget}:${scope.paneId}` : '') || scope.runId;
  const suffix = shortHash(identity || randomUUID());
  const prefix = base.slice(0, Math.max(1, 30 - suffix.length - 1)).replace(/-$/, '') || 'team';
  const teamName = `${prefix}-${suffix}`;
  if (!TEAM_NAME_SAFE_PATTERN.test(teamName)) {
    throw new Error(`invalid_internal_team_name:${teamName}`);
  }
  return teamName;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function candidateFromDir(root: string, teamName: string): TeamLookupCandidate | null {
  const manifest = readJson(join(root, teamName, 'manifest.v2.json'));
  const config = readJson(join(root, teamName, 'config.json'));
  const source = manifest || config;
  if (!source) return null;
  const leader = source.leader && typeof source.leader === 'object' && !Array.isArray(source.leader)
    ? source.leader as Record<string, unknown>
    : {};
  const displayName = str(source.display_name) || str(source.requested_name) || str(config?.display_name) || str(config?.requested_name) || teamName;
  return {
    teamName,
    displayName,
    requestedName: str(source.requested_name) || str(config?.requested_name) || displayName,
    leaderSessionId: str(leader.session_id),
    leaderPaneId: str(source.leader_pane_id) || str(config?.leader_pane_id),
    tmuxSession: str(source.tmux_session) || str(config?.tmux_session),
  };
}

export function listTeamLookupCandidates(cwd: string): TeamLookupCandidate[] {
  const root = join(resolve(cwd), '.omx', 'state', 'team');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => candidateFromDir(root, entry.name))
    .filter((entry): entry is TeamLookupCandidate => Boolean(entry));
}

export function resolveTeamNameForCurrentContext(inputName: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (/[^a-zA-Z0-9-]/.test(inputName.trim())) return inputName.trim();
  const input = sanitizeBase(inputName);
  const root = join(resolve(cwd), '.omx', 'state', 'team');
  if (existsSync(join(root, input))) return input;

  const candidates = listTeamLookupCandidates(cwd).filter((candidate) => {
    return sanitizeBase(candidate.displayName) === input || sanitizeBase(candidate.requestedName) === input;
  });
  if (candidates.length === 0) return input;

  const scope = resolveTeamIdentityScope(env);
  const current = candidates.filter((candidate) => {
    return (scope.sessionId && candidate.leaderSessionId === scope.sessionId)
      || (scope.paneId && candidate.leaderPaneId === scope.paneId);
  });
  if (current.length === 1) return current[0].teamName;
  if (candidates.length === 1 && !scope.sessionId && !scope.paneId) return candidates[0].teamName;
  throw new TeamLookupAmbiguityError(input, current.length > 1 ? current : candidates);
}
