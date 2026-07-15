import { existsSync } from 'fs';
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { resolveCanonicalTeamStateRoot } from '../../team/state-root.js';
import { TEAM_NAME_SAFE_PATTERN } from '../../team/contracts.js';
import { isTerminalPhase, safeString } from './utils.js';

export interface NotifyCanonicalActiveTeam {
  teamName: string;
  phase: string;
  ownerSessionId: string;
  path: string;
  source: 'canonical_fallback';
}

export async function listNotifyCanonicalActiveTeams(
  cwd: string,
  currentSessionId: string,
  stateRoot?: string,
): Promise<NotifyCanonicalActiveTeam[]> {
  const sessionId = safeString(currentSessionId).trim();
  if (!sessionId) return [];

  const canonicalRoot = safeString(stateRoot).trim() || resolveCanonicalTeamStateRoot(cwd);
  const teamsRoot = join(canonicalRoot, 'team');
  if (!existsSync(teamsRoot)) return [];

  const entries = await readdir(teamsRoot, { withFileTypes: true }).catch(() => []);
  const teams: NotifyCanonicalActiveTeam[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const teamName = entry.name.trim();
    if (!teamName || !TEAM_NAME_SAFE_PATTERN.test(teamName)) continue;

    const teamDir = join(teamsRoot, teamName);
    const [manifest, phaseState] = await Promise.all([
      readFile(join(teamDir, 'manifest.v2.json'), 'utf-8').then((raw) => JSON.parse(raw)).catch(() => null),
      readFile(join(teamDir, 'phase.json'), 'utf-8').then((raw) => JSON.parse(raw)).catch(() => null),
    ]);
    if (!manifest || !phaseState) continue;

    const ownerSessionId = safeString(manifest.leader?.session_id).trim();
    if (!ownerSessionId || ownerSessionId !== sessionId) continue;

    const phase = safeString(phaseState.current_phase).trim();
    if (!phase || isTerminalPhase(phase)) continue;

    teams.push({
      teamName,
      phase,
      ownerSessionId,
      path: join(teamsRoot, teamName, 'phase.json'),
      source: 'canonical_fallback',
    });
  }
  return teams;
}
