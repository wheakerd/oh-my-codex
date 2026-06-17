import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { omxRoot } from '../utils/paths.js';

export interface ProjectRuntimeCodexHome {
  path: string;
  sessionCountHint: number;
}

export async function discoverProjectRuntimeCodexHomes(cwd: string): Promise<ProjectRuntimeCodexHome[]> {
  const root = join(omxRoot(cwd), 'runtime', 'codex-home');
  if (!existsSync(root)) return [];

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const homes: ProjectRuntimeCodexHome[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('omx-')) continue;
    const home = join(root, entry.name);
    const sessions = join(home, 'sessions');
    if (!existsSync(sessions)) continue;
    const sessionCountHint = await countImmediateSessionEntries(sessions);
    homes.push({ path: home, sessionCountHint });
  }

  return homes.sort((a, b) => b.path.localeCompare(a.path));
}

async function countImmediateSessionEntries(sessionsDir: string): Promise<number> {
  const years = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  return years.filter((entry) => entry.isDirectory()).length;
}
