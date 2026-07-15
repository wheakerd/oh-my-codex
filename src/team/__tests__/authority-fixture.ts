import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
} from '../../state/authority.js';
import { buildStateAuthorityTransportEnv } from '../../state/transport-env.js';
import {
  TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS,
  TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS,
} from '../state-root.js';

const TEST_ENV_KEYS = [
  ...TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS,
  ...TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS,
  'OMX_SESSION_ID',
] as const;

let activeFixtureWorkspace: string | null = null;
let savedEnvironment: Map<string, string | undefined> | null = null;

function clearTeamTestAuthorityEnvironment(): void {
  for (const key of TEST_ENV_KEYS) delete process.env[key];
}

function restoreTeamTestAuthorityEnvironment(): void {
  if (!savedEnvironment) return;
  for (const [key, value] of savedEnvironment) {
    if (typeof value === 'string') process.env[key] = value;
    else delete process.env[key];
  }
  savedEnvironment = null;
}

function saveTeamTestAuthorityEnvironment(): void {
  if (savedEnvironment) return;
  savedEnvironment = new Map(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}


function testSessionId(cwd: string): string {
  return `team-test-${createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24)}`;
}

async function secureFixtureDirectoryTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await secureFixtureDirectoryTree(join(directory, entry.name));
    }
  }
}
function secureFixtureDirectoryTreeSync(directory: string): void {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) secureFixtureDirectoryTreeSync(join(directory, entry.name));
  }
}

export function hardenTestAuthorityTreeSync(cwd: string): void {
  const omxDirectory = join(resolve(cwd), '.omx');
  if (existsSync(omxDirectory)) secureFixtureDirectoryTreeSync(omxDirectory);
}

export function clearTeamTestAuthority(): void {
  activeFixtureWorkspace = null;
  clearTeamTestAuthorityEnvironment();
  restoreTeamTestAuthorityEnvironment();
}


/** Hardens the active fixture state tree before a Team mutation. */
export async function hardenTeamTestAuthority(cwd: string): Promise<void> {
  const workspace = resolve(cwd);
  if (activeFixtureWorkspace !== workspace) return;

  const omxDirectory = join(workspace, '.omx');
  if (!existsSync(omxDirectory)) {
    clearTeamTestAuthority();
    return;
  }

  await secureFixtureDirectoryTree(omxDirectory);
}

/**
 * Installs an authority transport for a temporary Team workspace. Team mutations
 * intentionally fail closed without this persisted capability, so tests that
 * create isolated workspaces must model a launched session rather than use an
 * ambient root alias.
 */
export async function installTeamTestAuthority(
  cwd: string,
  sessionId = testSessionId(cwd),
) {
  saveTeamTestAuthorityEnvironment();
  clearTeamTestAuthorityEnvironment();

  await mkdir(join(cwd, '.omx', 'state'), { recursive: true, mode: 0o700 });
  await secureFixtureDirectoryTree(join(cwd, '.omx'));

  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `${sessionId}-launch`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  Object.assign(process.env, buildStateAuthorityTransportEnv(authority, {
    OMX_SESSION_ID: sessionId,
  }));
  await secureFixtureDirectoryTree(join(cwd, '.omx'));
  activeFixtureWorkspace = resolve(cwd);
  return authority;
}
