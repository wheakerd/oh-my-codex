import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { HUD_RESIZE_RECONCILE_DELAY_SECONDS, HUD_TMUX_HEIGHT_LINES } from './constants.js';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export interface TmuxPaneSnapshot {
  paneId: string;
  currentCommand: string;
  startCommand: string;
  paneInstanceId?: string;
  sessionInstanceId?: string;
  sessionName?: string;
  currentPath?: string;
  paneLeft?: number;
  paneTop?: number;
  paneWidth?: number;
  paneHeight?: number;
  paneBottom?: number;
  windowWidth?: number;
  windowHeight?: number;
}

export const OMX_TMUX_HUD_LEADER_PANE_ENV = 'OMX_TMUX_HUD_LEADER_PANE';
const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';
export const TMUX_PANE_FIELD_SEPARATOR = '\x1f';
export const TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE = '\\037';

export interface HudPaneOwner {
  sessionId?: string;
  sessionIds?: string[];
  leaderPaneId?: string;
}
export type HudRuntimeRootSource = 'team-env' | 'omx-root-env' | 'omx-state-root-env' | 'cwd-default';

export interface HudRuntimeEnvInput {
  sessionId?: string;
  leaderPaneId?: string;
  omxRoot?: string;
  omxStateRoot?: string;
  omxTeamStateRoot?: string;
  rootSource?: HudRuntimeRootSource;
}

export interface HudRuntimeEnvOutput {
  env: Record<string, string>;
  owner: HudPaneOwner;
}

type TmuxExecSync = (args: string[]) => string;

/** Upper bound for tmux hook indices (signed 32-bit max). */
const TMUX_HOOK_INDEX_MAX = 2147483647;

export interface RegisterHudResizeHookOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function defaultExecTmuxSync(args: string[]): string {
  try {
    return execFileSync(resolveTmuxBinaryForPlatform() || 'tmux', args, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  } catch (error) {
    const maybeSpawnError = error as { status?: unknown; stdout?: unknown };
    if (maybeSpawnError.status === 0 && typeof maybeSpawnError.stdout === 'string') {
      return maybeSpawnError.stdout;
    }
    throw error;
  }
}

function parseNonNegativeInteger(value: string | undefined): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

export function parseTmuxPaneSnapshot(output: string): TmuxPaneSnapshot[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const fieldSeparator = line.includes(TMUX_PANE_FIELD_SEPARATOR)
        ? TMUX_PANE_FIELD_SEPARATOR
        : line.includes(TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE)
          ? TMUX_PANE_FIELD_SEPARATOR_OCTAL_ESCAPE
          : '\t';
      const parts = line.split(fieldSeparator);
      const [paneId = '', currentCommand = ''] = parts;
      const paneLeft = parseNonNegativeInteger(parts[2]);
      const paneTop = parseNonNegativeInteger(parts[3]);
      const paneWidth = parsePositiveInteger(parts[4]);
      const paneHeight = parsePositiveInteger(parts[5]);
      const paneBottom = parseNonNegativeInteger(parts[6]);
      const windowWidth = parsePositiveInteger(parts[7]);
      const windowHeight = parsePositiveInteger(parts[8]);
      const hasGeometry = (
        paneLeft !== null
        && paneTop !== null
        && paneWidth !== null
        && paneHeight !== null
        && paneBottom !== null
        && windowWidth !== null
        && windowHeight !== null
      );
      const payloadParts = hasGeometry ? parts.slice(9) : parts.slice(2);
      const hasInstanceColumns = hasGeometry && payloadParts.length >= 4;
      const paneInstanceId = hasInstanceColumns ? (payloadParts[0] ?? '').trim() : '';
      const sessionInstanceId = hasInstanceColumns ? (payloadParts[1] ?? '').trim() : '';
      const hasSessionNameColumn = hasInstanceColumns && payloadParts.length >= 5;
      const sessionName = hasSessionNameColumn ? (payloadParts[2] ?? '').trim() : '';
      const commandPayloadParts = hasInstanceColumns
        ? payloadParts.slice(hasSessionNameColumn ? 3 : 2)
        : payloadParts;
      const hasCurrentPathColumn = commandPayloadParts.length >= 2;
      const currentPath = hasCurrentPathColumn ? (commandPayloadParts.at(-1) ?? '') : '';
      const startCommandParts = hasCurrentPathColumn ? commandPayloadParts.slice(0, -1) : commandPayloadParts;
      const trimmedCurrentPath = currentPath.trim();
      return {
        paneId: paneId.trim(),
        currentCommand: currentCommand.trim(),
        startCommand: startCommandParts.join('\t').trim(),
        ...(paneInstanceId ? { paneInstanceId } : {}),
        ...(sessionInstanceId ? { sessionInstanceId } : {}),
        ...(sessionName ? { sessionName } : {}),
        ...(trimmedCurrentPath ? { currentPath: trimmedCurrentPath } : {}),
        ...(hasGeometry
          ? {
              paneLeft,
              paneTop,
              paneWidth,
              paneHeight,
              paneBottom,
              windowWidth,
              windowHeight,
            }
          : {}),
      };
    })
    .filter((pane) => pane.paneId.startsWith('%'));
}

export function isHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`.toLowerCase();
  return (
    /\bhud\b/.test(command)
    && /--watch\b/.test(command)
    && (/\bomx(?:\.js)?\b/.test(command) || /\bnode\b/.test(command))
  );
}


function parseShellEnvAssignment(command: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(
    new RegExp(
      `(?:^|\\s)(?:'${escapedKey}=([^']*)'|${escapedKey}=(?:'((?:'\\\\''|[^'])*)'|([^\\s]+)))`,
    ),
  );
  const fallbackMatch = match
    ? null
    : command.match(new RegExp(`(?:^|[\\s'])${escapedKey}=([^'\\s]+)`));
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? fallbackMatch?.[1];
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/'\\''/g, "'").trim();
  return value === '' ? undefined : value;
}

export function readHudPaneOwner(pane: TmuxPaneSnapshot): HudPaneOwner {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return {
    sessionId: parseShellEnvAssignment(command, 'OMX_SESSION_ID'),
    leaderPaneId: parseShellEnvAssignment(command, OMX_TMUX_HUD_LEADER_PANE_ENV),
  };
}


function hasHudPaneOwnerMetadata(pane: TmuxPaneSnapshot): boolean {
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  const owner = readHudPaneOwner(pane);
  return parseShellEnvAssignment(command, OMX_TMUX_HUD_OWNER_ENV) === '1'
    || Boolean(owner.sessionId || owner.leaderPaneId);
}

function hasOmxCliToken(command: string): boolean {
  return /(?:^|[\s'"])(?:[^\s'"]*\/)?omx(?:\.js)?(?=$|[\s'"])/.test(command);
}

function isLegacyFocusedHudWatchPane(pane: TmuxPaneSnapshot): boolean {
  // Migration-only heuristic for prompt-submit auto-HUD reconciliation: older
  // focused auto-HUD panes lacked owner metadata, so keep this deliberately
  // narrower than general HUD ownership/reaping.
  if (!isHudWatchPane(pane) || hasHudPaneOwnerMetadata(pane)) return false;
  const command = `${pane.startCommand} ${pane.currentCommand}`;
  return hasOmxCliToken(command)
    && !/(?:^|[\s'"])--tmux(?:[\s'"]|$)/.test(command)
    && /(?:^|[\s'"])--preset=focused(?:[\s'"]|$)/.test(command);
}

export function findLegacyFocusedHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
): string[] {
  return panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => isLegacyFocusedHudWatchPane(pane))
    .map((pane) => pane.paneId);
}

export function hudPaneMatchesOwner(pane: TmuxPaneSnapshot, owner: HudPaneOwner = {}): boolean {
  if (!isHudWatchPane(pane)) return false;
  const wantedSessionIds = [
    typeof owner.sessionId === 'string' ? owner.sessionId.trim() : '',
    ...(Array.isArray(owner.sessionIds) ? owner.sessionIds : []),
  ]
    .map((sessionId) => sessionId.trim())
    .filter((sessionId, index, sessionIds) => sessionId !== '' && sessionIds.indexOf(sessionId) === index);
  const wantedLeaderPaneId = typeof owner.leaderPaneId === 'string' ? owner.leaderPaneId.trim() : '';
  const wantsSession = wantedSessionIds.length > 0;
  const wantsLeaderPane = wantedLeaderPaneId !== '';
  if (!wantsSession && !wantsLeaderPane) return true;

  const paneOwner = readHudPaneOwner(pane);
  const sessionMatches = wantsSession && wantedSessionIds.includes(paneOwner.sessionId ?? '');
  const leaderPaneMatches = wantsLeaderPane && paneOwner.leaderPaneId === wantedLeaderPaneId;

  if (wantsSession && wantsLeaderPane) {
    return sessionMatches && leaderPaneMatches;
  }
  if (wantsSession) return sessionMatches;
  return leaderPaneMatches;
}

export function hudPaneMatchesExactCandidate(
  pane: TmuxPaneSnapshot,
  owner: HudPaneOwner,
  identity: { tmuxSessionInstanceId: string; tmuxPaneInstanceId: string },
): boolean {
  return hudPaneMatchesOwner(pane, owner)
    && pane.sessionInstanceId === identity.tmuxSessionInstanceId
    && pane.paneInstanceId === identity.tmuxPaneInstanceId;
}

export function findHudWatchPaneIds(
  panes: TmuxPaneSnapshot[],
  currentPaneId?: string,
  owner: HudPaneOwner = {},
): string[] {
  return panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner))
    .map((pane) => pane.paneId);
}

function isDeletedTmuxPanePath(path: string | undefined): boolean {
  const currentPath = path?.trim();
  return Boolean(currentPath && /(?:^|\s)\(deleted\)\s*$/.test(currentPath) && !existsSync(currentPath));
}

function hasDeletedTmuxPaneMarker(path: string | undefined): boolean {
  const currentPath = path?.trim();
  return Boolean(currentPath && /(?:^|\s)\(deleted\)\s*$/.test(currentPath));
}

function isDoctorSmokeSessionId(sessionId: string | undefined): boolean {
  return /^(?:doctor-smoke|omx-doctor-[a-z0-9-]+-smoke)$/i.test(sessionId ?? '');
}

function shouldReapDeletedCwdHudPane(pane: TmuxPaneSnapshot, isLivePane: (paneId: string) => boolean): boolean {
  // A deleted tmux launch cwd is not enough to prove a HUD is dead: watch mode can
  // keep serving from a resolved live cwd. Reap only explicit doctor smoke panes or
  // owner-tagged panes whose leader is gone.
  if (!hasHudPaneOwnerMetadata(pane) || !hasDeletedTmuxPaneMarker(pane.currentPath)) return false;
  const owner = readHudPaneOwner(pane);
  if (isDoctorSmokeSessionId(owner.sessionId)) return true;
  if (!isDeletedTmuxPanePath(pane.currentPath)) return false;
  return !owner.leaderPaneId || !isLivePane(owner.leaderPaneId);
}

export function reapDeadHudPanes(
  panes: TmuxPaneSnapshot[],
  opts: {
    isLivePane?: (paneId: string) => boolean;
    killExactPane?: (candidate: ExactHudPaneKillCandidate) => boolean;
  } = {},
): { reaped: string[]; preserved: string[] } {
  const livePaneIds = new Set(panes.map((pane) => pane.paneId));
  const isLivePane = opts.isLivePane ?? ((paneId: string) => livePaneIds.has(paneId));
  const reaped: string[] = [];
  const preserved: string[] = [];

  const candidateFor = (pane: TmuxPaneSnapshot): ExactHudPaneKillCandidate | null => {
    const owner = readHudPaneOwner(pane);
    if (!pane.paneInstanceId || !pane.sessionInstanceId || !pane.sessionName || !owner.sessionId || !owner.leaderPaneId) return null;
    return {
      paneId: pane.paneId,
      currentCommand: pane.currentCommand,
      startCommand: pane.startCommand,
      owner,
      paneInstanceId: pane.paneInstanceId,
      sessionInstanceId: pane.sessionInstanceId,
      sessionName: pane.sessionName,
    };
  };

  for (const pane of panes) {
    if (!isHudWatchPane(pane)) continue;
    const leaderPaneId = readHudPaneOwner(pane).leaderPaneId;
    const shouldReap = shouldReapDeletedCwdHudPane(pane, isLivePane)
      || Boolean(leaderPaneId && !isLivePane(leaderPaneId));
    const candidate = shouldReap ? candidateFor(pane) : null;
    if (candidate && opts.killExactPane?.(candidate)) reaped.push(pane.paneId);
    else preserved.push(pane.paneId);
  }

  return { reaped, preserved };
}

export function parsePaneIdFromTmuxOutput(rawOutput: string): string | null {
  const paneId = rawOutput.split('\n')[0]?.trim() || '';
  return paneId.startsWith('%') ? paneId : null;
}

export function shellEscapeSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTmuxHookToken(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized || 'unknown';
}

function isTmuxSessionId(value: string): boolean {
  return /^\$\d+$/.test(value);
}

function isTmuxWindowId(value: string): boolean {
  return /^@\d+$/.test(value);
}

function isTmuxPaneId(value: string): boolean {
  return /^%\d+$/.test(value);
}

export function buildHudResizeHookName(sessionId: string, windowId: string, leaderPaneId: string): string {
  return [
    'omx_hud_resize',
    normalizeTmuxHookToken(sessionId),
    normalizeTmuxHookToken(windowId),
    normalizeTmuxHookToken(leaderPaneId),
  ].join('_');
}


export function buildHudResizeHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `client-resized[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export function buildHudLayoutHookSlot(hookName: string): string {
  let hash = 0;
  for (let i = 0; i < hookName.length; i++) {
    hash = (hash * 31 + hookName.charCodeAt(i)) | 0;
  }
  return `window-layout-changed[${Math.abs(hash) % TMUX_HOOK_INDEX_MAX}]`;
}

export interface HudResizeHookContext {
  sessionId: string;
  windowId: string;
  leaderPaneId: string;
  hookName: string;
  hookSlot: string;
  layoutHookSlot: string;
}

export function parseHudResizeHookContext(output: string, leaderPaneId: string): HudResizeHookContext | null {
  const [sessionId = '', windowId = ''] = output
    .split('\n')[0]
    ?.split('\t')
    .map((part) => part.trim()) ?? [];
  const normalizedLeaderPaneId = leaderPaneId.trim();
  if (!isTmuxSessionId(sessionId) || !isTmuxWindowId(windowId) || !isTmuxPaneId(normalizedLeaderPaneId)) return null;
  const hookName = buildHudResizeHookName(sessionId, windowId, normalizedLeaderPaneId);
  return {
    sessionId,
    windowId,
    leaderPaneId: normalizedLeaderPaneId,
    hookName,
    hookSlot: buildHudResizeHookSlot(hookName),
    layoutHookSlot: buildHudLayoutHookSlot(hookName),
  };
}

export function readHudResizeHookContext(
  leaderPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): HudResizeHookContext | null {
  if (!leaderPaneId || !isTmuxPaneId(leaderPaneId)) return null;
  try {
    return parseHudResizeHookContext(
      execTmuxSync([
        'display-message',
        '-p',
        '-t',
        leaderPaneId,
        '#{session_id}\t#{window_id}',
      ]),
      leaderPaneId,
    );
  } catch {
    return null;
  }
}

function buildNestedTmuxCommand(tmuxBin: string, args: string[], tmuxEnv?: string): string {
  const command = [tmuxBin, ...args].map((part) => shellEscapeSingle(part)).join(' ');
  return `${buildEnvPrefix({ TMUX: tmuxEnv })}${command}`;
}

function buildHudResizeHookCommand(
  tmuxBin: string,
  hudPaneId: string,
  height: string,
  condition: string,
  tmuxEnv?: string,
): string {
  const resize = buildNestedTmuxCommand(
    tmuxBin,
    ['if-shell', '-t', hudPaneId, '-F', condition, `resize-pane -t ${hudPaneId} -y ${height}`, ''],
    tmuxEnv,
  );
  // Every resize revalidates tmux's current immutable identity. The delayed
  // second resize must not inherit authorization from the original callback.
  const resizeBestEffort = `${resize} >/dev/null 2>&1 || true`;
  return `${resizeBestEffort}; sleep ${HUD_RESIZE_RECONCILE_DELAY_SECONDS}; ${resizeBestEffort}`;
}


function buildHudLayoutReconcileHookCommand(
  tmuxBin: string,
  omxBin: string,
  leaderPaneId: string,
  options: RegisterHudResizeHookOptions = {},
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd?.trim() || process.cwd();
  const leaderAlive = buildNestedTmuxCommand(tmuxBin, ['display-message', '-p', '-t', leaderPaneId, '#{pane_id}'], env.TMUX);
  const reconcileEnv = buildEnvPrefix({
    TMUX: env.TMUX,
    TMUX_PANE: leaderPaneId,
    OMX_TMUX_HUD_OWNER: '1',
    OMX_SESSION_ID: env.OMX_SESSION_ID,
    OMX_ROOT: env.OMX_ROOT,
    OMX_STATE_ROOT: env.OMX_STATE_ROOT,
    OMX_TEAM_STATE_ROOT: env.OMX_TEAM_STATE_ROOT,
  });
  const reconcile = [
    'cd',
    shellEscapeSingle(cwd),
    '&&',
    `${reconcileEnv}${shellEscapeSingle(process.execPath)}`,
    shellEscapeSingle(omxBin),
    'hud',
    '--reconcile-tmux',
  ].join(' ');
  return `${leaderAlive} >/dev/null 2>&1 && (${reconcile} >/dev/null 2>&1; status=$?; exit $status) || true`;
}


function buildEnvPrefix(env: Record<string, string | undefined>): string {
  const assignments = Object.entries(env)
    .map(([key, value]) => [key, typeof value === 'string' ? value : ''] as const)
    .filter(([, value]) => value.trim() !== '')
    .map(([key, value]) => `${key}=${shellEscapeSingle(value)}`);
  return assignments.length > 0 ? `env ${assignments.join(' ')} ` : '';
}
export function buildHudRuntimeEnv(input: HudRuntimeEnvInput = {}): HudRuntimeEnvOutput {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const leaderPaneId = typeof input.leaderPaneId === 'string' ? input.leaderPaneId.trim() : '';
  const env: Record<string, string> = {};
  if (sessionId) env.OMX_SESSION_ID = sessionId;
  env[OMX_TMUX_HUD_OWNER_ENV] = '1';
  if (leaderPaneId) env[OMX_TMUX_HUD_LEADER_PANE_ENV] = leaderPaneId;
  const rootSource = input.rootSource ?? (input.omxTeamStateRoot
    ? 'team-env'
    : input.omxRoot
      ? 'omx-root-env'
      : input.omxStateRoot
        ? 'omx-state-root-env'
        : 'cwd-default');
  if (rootSource === 'team-env') {
    const value = input.omxTeamStateRoot?.trim();
    if (value) env.OMX_TEAM_STATE_ROOT = value;
  } else if (rootSource === 'omx-root-env') {
    const value = input.omxRoot?.trim();
    if (value) env.OMX_ROOT = value;
  } else if (rootSource === 'omx-state-root-env') {
    const value = input.omxStateRoot?.trim();
    if (value) env.OMX_STATE_ROOT = value;
  }
  return {
    env,
    owner: {
      ...(sessionId ? { sessionId } : {}),
      ...(leaderPaneId ? { leaderPaneId } : {}),
    },
  };
}

export function buildHudWatchCommand(
  omxBin: string,
  preset?: string,
  sessionId?: string,
  omxRoot?: string,
  leaderPaneId?: string,
  rootEnv?: Pick<HudRuntimeEnvInput, 'omxStateRoot' | 'omxTeamStateRoot' | 'rootSource'>,
): string {
  const safePreset = preset === 'minimal' || preset === 'focused' || preset === 'full'
    ? ` --preset=${preset}`
    : '';
  const envPrefix = buildEnvPrefix(buildHudRuntimeEnv({
    sessionId,
    leaderPaneId,
    omxRoot,
    ...(rootEnv ?? { rootSource: 'omx-root-env' }),
  }).env);
  return `exec ${envPrefix}${shellEscapeSingle(process.execPath)} ${shellEscapeSingle(omxBin)} hud --watch${safePreset}`;
}

export function listCurrentWindowPanes(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  currentPaneId?: string,
): TmuxPaneSnapshot[] {
  try {
    return parseTmuxPaneSnapshot(
      execTmuxSync([
        'list-panes',
        ...(currentPaneId ? ['-t', currentPaneId] : []),
        '-F',
        [
          '#{pane_id}',
          '#{pane_current_command}',
          '#{pane_left}',
          '#{pane_top}',
          '#{pane_width}',
          '#{pane_height}',
          '#{pane_bottom}',
          '#{window_width}',
          '#{window_height}',
          '#{@omx_pane_instance_id}',
          '#{@omx_instance_id}',
          '#{session_name}',
          '#{pane_start_command}',
          '#{pane_current_path}',
        ].join(TMUX_PANE_FIELD_SEPARATOR),
      ]),
    );
  } catch {
    return [];
  }
}

export function readActiveTmuxPaneId(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  try {
    return parsePaneIdFromTmuxOutput(execTmuxSync(['display-message', '-p', '#{pane_id}']));
  } catch {
    return null;
  }
}

export function listCurrentWindowHudPaneIds(
  currentPaneId?: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  owner: HudPaneOwner = {},
): string[] {
  return findHudWatchPaneIds(listCurrentWindowPanes(execTmuxSync, currentPaneId), currentPaneId, owner);
}

export function readCurrentWindowSize(
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
  currentPaneId?: string,
): { width: number | null; height: number | null } {
  try {
    const raw = execTmuxSync([
      'display-message',
      '-p',
      ...(currentPaneId ? ['-t', currentPaneId] : []),
      '#{window_width}\t#{window_height}',
    ]);
    const [widthRaw = '', heightRaw = ''] = raw.split('\t');
    const width = Number.parseInt(widthRaw.trim(), 10);
    const height = Number.parseInt(heightRaw.trim(), 10);
    return {
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

export function createHudWatchPane(
  cwd: string,
  hudCmd: string,
  options: {
    heightLines?: number;
    fullWidth?: boolean;
    targetPaneId?: string;
    instanceId?: string;
  } = {},
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): string | null {
  const heightLines = Number.isFinite(options.heightLines) && (options.heightLines ?? 0) > 0
    ? Math.floor(options.heightLines ?? HUD_TMUX_HEIGHT_LINES)
    : HUD_TMUX_HEIGHT_LINES;
  const args = [
    'split-window',
    '-v',
    ...(options.fullWidth ? ['-f'] : []),
    '-l',
    String(heightLines),
    '-d',
    ...(options.targetPaneId ? ['-t', options.targetPaneId] : []),
    '-c',
    cwd,
    '-P',
    '-F',
    '#{pane_id}',
    hudCmd,
  ];
  let paneId: string | null = null;
  try {
    paneId = parsePaneIdFromTmuxOutput(execTmuxSync(args));
    if (!paneId) return null;
    const instanceId = options.instanceId?.trim();
    if (instanceId) {
      execTmuxSync(['set-option', '-p', '-t', paneId, '@omx_pane_instance_id', instanceId]);
      const taggedInstanceId = execTmuxSync(['show-option', '-qv', '-p', '-t', paneId, '@omx_pane_instance_id']).trim();
      if (taggedInstanceId !== instanceId) throw new Error('HUD pane instance tag was not persisted');
    }
    return paneId;
  } catch {
    // The split may have succeeded but its ownership tag could not be verified.
    // Do not kill by pane id here: tmux pane ids can be reused before cleanup.
    // Leaving the uncertain pane intact is the fail-closed rollback behavior.
    return null;
  }
}

export interface ExactHudPaneKillCandidate {
  paneId: string;
  currentCommand: string;
  startCommand: string;
  owner: HudPaneOwner;
  paneInstanceId: string;
  sessionInstanceId: string;
  sessionName: string;
}

function tmuxFormatLiteral(value: string): string {
  return value.replace(/([\\,}])/g, '\\$1');
}

/** Atomically kills a pane only while its complete managed-HUD identity still matches. */
export function killExactHudPane(
  candidate: ExactHudPaneKillCandidate,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const paneId = candidate.paneId.trim();
  const paneInstanceId = candidate.paneInstanceId.trim();
  const sessionInstanceId = candidate.sessionInstanceId.trim();
  const sessionName = candidate.sessionName.trim();
  const ownerSessionId = candidate.owner.sessionId?.trim() ?? '';
  const ownerLeaderPaneId = candidate.owner.leaderPaneId?.trim() ?? '';
  if (!isTmuxPaneId(paneId) || !paneInstanceId || !sessionInstanceId || !sessionName || !ownerSessionId || !isTmuxPaneId(ownerLeaderPaneId)) return false;
  if (!isHudWatchPane({ paneId, currentCommand: candidate.currentCommand, startCommand: candidate.startCommand })
    || readHudPaneOwner({ paneId, currentCommand: candidate.currentCommand, startCommand: candidate.startCommand }).sessionId !== ownerSessionId
    || readHudPaneOwner({ paneId, currentCommand: candidate.currentCommand, startCommand: candidate.startCommand }).leaderPaneId !== ownerLeaderPaneId) return false;
  const condition = `#{&&:#{==:#{pane_id},${tmuxFormatLiteral(paneId)}},#{==:#{pane_current_command},${tmuxFormatLiteral(candidate.currentCommand)}},#{==:#{pane_start_command},${tmuxFormatLiteral(candidate.startCommand)}},#{==:#{@omx_pane_instance_id},${tmuxFormatLiteral(paneInstanceId)}},#{==:#{@omx_instance_id},${tmuxFormatLiteral(sessionInstanceId)}},#{==:#{session_name},${tmuxFormatLiteral(sessionName)}}}`;
  const appliedReceipt = '__omx_hud_pane_kill_applied__';
  const rejectedReceipt = '__omx_hud_pane_kill_rejected__';
  try {
    const output = execTmuxSync([
      'if-shell', '-t', paneId, '-F', condition,
      `kill-pane -t ${paneId} \\; display-message -p ${appliedReceipt}`,
      `display-message -p ${rejectedReceipt}`,
    ]).trim();
    return output === appliedReceipt;
  } catch {
    return false;
  }
}
export function killTmuxPane(
  paneId: string,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!paneId.startsWith('%')) return false;
  try {
    execTmuxSync(['kill-pane', '-t', paneId]);
    return true;
  } catch {
    return false;
  }
}

export function resizeTmuxPane(
  paneId: string,
  heightLines: number,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  if (!paneId.startsWith('%')) return false;
  const height = Number.isFinite(heightLines) && heightLines > 0
    ? Math.floor(heightLines)
    : HUD_TMUX_HEIGHT_LINES;
  try {
    execTmuxSync(['resize-pane', '-t', paneId, '-y', String(height)]);
    return true;
  } catch {
    return false;
  }
}

function hudHookGenerationOption(leaderPaneId: string, leaderBirth: string): string {
  const key = `${leaderPaneId}_${leaderBirth}`.replace(/[^a-zA-Z0-9_]/g, '_');
  return `@omx_hud_hook_generation_${key}`;
}

export function registerHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  heightLines: number,
  optionsOrExecTmuxSync: RegisterHudResizeHookOptions | TmuxExecSync = {},
  maybeExecTmuxSync?: TmuxExecSync,
): boolean {
  const options = typeof optionsOrExecTmuxSync === 'function' ? {} : optionsOrExecTmuxSync;
  const execTmuxSync = typeof optionsOrExecTmuxSync === 'function'
    ? optionsOrExecTmuxSync
    : (maybeExecTmuxSync ?? defaultExecTmuxSync);
  if (!isTmuxPaneId(hudPaneId)) return false;
  const context = readHudResizeHookContext(leaderPaneId, execTmuxSync);
  if (!context || !leaderPaneId?.startsWith('%')) return false;
  const omxBin = resolveOmxCliEntryPath({ cwd: options.cwd, env: options.env });
  if (!omxBin) return false;
  let activeOption: string | null = null;
  try {
    const [hudBirth, sessionBirth, sessionName, windowId, currentCommand, startCommand] = execTmuxSync([
      'display-message', '-p', '-t', hudPaneId,
      '#{@omx_pane_instance_id}\t#{@omx_instance_id}\t#{session_name}\t#{window_id}\t#{pane_current_command}\t#{pane_start_command}',
    ]).trim().split('\t').map((value) => value.trim());
    const leaderBirth = execTmuxSync(['display-message', '-p', '-t', leaderPaneId, '#{@omx_pane_instance_id}']).trim();
    if (!hudBirth || !sessionBirth || !sessionName || !windowId || !currentCommand || !startCommand || !leaderBirth) return false;
    const generation = randomUUID();
    activeOption = `@omx_hud_hook_active_${generation.replace(/-/g, '_')}`;
    const generationOption = hudHookGenerationOption(leaderPaneId, leaderBirth);
    const condition = `#{&&:#{==:#{pane_id},${tmuxFormatLiteral(hudPaneId)}},#{==:#{pane_current_command},${tmuxFormatLiteral(currentCommand)}},#{==:#{pane_start_command},${tmuxFormatLiteral(startCommand)}},#{==:#{@omx_pane_instance_id},${tmuxFormatLiteral(hudBirth)}},#{==:#{@omx_instance_id},${tmuxFormatLiteral(sessionBirth)}},#{==:#{session_name},${tmuxFormatLiteral(sessionName)}},#{==:#{window_id},${tmuxFormatLiteral(windowId)}},#{==:#{${activeOption}},1}}`;
    const tmuxBin = resolveTmuxBinaryForPlatform() || 'tmux';
    const height = String(Math.max(1, Math.floor(heightLines)));
    const resize = buildHudResizeHookCommand(tmuxBin, hudPaneId, height, condition, options.env?.TMUX);
    const reconcile = buildHudLayoutReconcileHookCommand(tmuxBin, omxBin, leaderPaneId, options);
    const wrap = (command: string) => `if-shell -t ${hudPaneId} -F ${shellEscapeSingle(condition)} ${shellEscapeSingle(`run-shell -b ${command}`)} '' # omx-hud-owned:${generation}`;
    execTmuxSync(['set-option', '-t', context.sessionId, activeOption, '1']);
    execTmuxSync(['set-option', '-t', context.sessionId, generationOption, generation]);
    // tmux serializes -a registration and assigns a fresh numeric slot. Existing
    // foreign/older hooks are never observed as mutation authority or replaced.
    execTmuxSync(['set-hook', '-a', '-t', context.sessionId, 'client-resized', wrap(resize)]);
    execTmuxSync(['set-hook', '-a', '-t', context.sessionId, 'window-layout-changed', wrap(reconcile)]);
    return true;
  } catch {
    if (activeOption) {
      try {
        execTmuxSync(['set-option', '-t', context.sessionId, activeOption, '0']);
      } catch {
        // A failed inert write remains recovery uncertainty.
      }
    }
    return false;
  }
}

/** Makes only this leader birth's persisted HUD hook generation inert. */
export function unregisterHudResizeHook(
  leaderPaneId: string | undefined,
  execTmuxSync: TmuxExecSync = defaultExecTmuxSync,
): boolean {
  const context = readHudResizeHookContext(leaderPaneId, execTmuxSync);
  if (!context || !leaderPaneId) return false;
  try {
    const leaderBirth = execTmuxSync(['display-message', '-p', '-t', leaderPaneId, '#{@omx_pane_instance_id}']).trim();
    if (!leaderBirth) return false;
    const generation = execTmuxSync(['show-option', '-qv', '-t', context.sessionId, hudHookGenerationOption(leaderPaneId, leaderBirth)]).trim();
    if (!/^[0-9a-f-]{36}$/.test(generation)) return false;
    execTmuxSync(['set-option', '-t', context.sessionId, `@omx_hud_hook_active_${generation.replace(/-/g, '_')}`, '0']);
    return true;
  } catch {
    return false;
  }
}