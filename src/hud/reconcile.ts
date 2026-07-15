import { mkdir } from 'node:fs/promises';

import { acquireHudLifecycleLock, releaseHudLifecycleLock, type HudLifecycleLockDeps } from './lifecycle-lock.js';
import { resolveHudControlPlaneDomain, type ResolvedHudControlPlaneDomain } from '../mcp/state-paths.js';
import { probeActualTmuxInstanceEvidence, tmuxEvidenceBindsCandidate, type ActualTmuxInstanceEvidence } from '../scripts/notify-hook/managed-tmux.js';

import { readAllState, readHudConfig } from './state.js';
import { getHudRenderMaxLines } from './render.js';
import { HUD_TMUX_HEIGHT_LINES, isTmuxWindowTooCrampedForHudSplit } from './constants.js';
import {
  buildHudWatchCommand,
  createHudWatchPane,
  isHudWatchPane,
  killExactHudPane,
  listCurrentWindowPanes,
  readCurrentWindowSize,
  readHudPaneOwner,
  hudPaneMatchesOwner,
  hudPaneMatchesExactCandidate,
  registerHudResizeHook,
  unregisterHudResizeHook,
  resizeTmuxPane,
  type ExactHudPaneKillCandidate,
  type HudPaneOwner,
  type TmuxPaneSnapshot,
} from './tmux.js';
import { resolveOmxCliEntryPath } from '../utils/paths.js';

export const OMX_TMUX_HUD_OWNER_ENV = 'OMX_TMUX_HUD_OWNER';

function isExplicitOmxOwnedTmuxEnv(env: NodeJS.ProcessEnv): boolean {
  return env[OMX_TMUX_HUD_OWNER_ENV] === '1';
}


export interface ReconcileHudForPromptSubmitResult {
  status:
    | 'skipped_not_tmux'
    | 'skipped_no_entry'
    | 'skipped_not_omx_owned_tmux'
    | 'skipped_no_session_id'
    | 'skipped_window_too_cramped'
    | 'unchanged'
    | 'resized'
    | 'recreated'
    | 'replaced_duplicates'
    | 'skipped_concurrent'
    | 'failed';
  paneId: string | null;
  desiredHeight: number | null;
  duplicateCount: number;
}

export interface ReconcileHudForPromptSubmitDeps {
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  sessionIds?: string[];
  listCurrentWindowPanes?: (currentPaneId?: string) => TmuxPaneSnapshot[];
  createHudWatchPane?: (
    cwd: string,
    hudCmd: string,
    options?: { heightLines?: number; fullWidth?: boolean; targetPaneId?: string; instanceId?: string },
  ) => string | null;
  killManagedHudPane?: (candidate: ExactHudPaneKillCandidate) => boolean;
  resizeTmuxPane?: (paneId: string, heightLines: number) => boolean;
  readHudConfig?: typeof readHudConfig;
  readAllState?: typeof readAllState;
  resolveOmxCliEntryPath?: typeof resolveOmxCliEntryPath;
  registerHudResizeHook?: (
    hudPaneId: string,
    leaderPaneId: string | undefined,
    heightLines: number,
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => boolean;
  unregisterHudResizeHook?: (leaderPaneId: string | undefined) => boolean;
  readCurrentWindowSize?: (currentPaneId?: string) => { width: number | null; height: number | null };
  nowMs?: () => number;
  isProcessLive?: (pid: number) => boolean | null;
  resolveDomain?: (options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    requestedSessionId?: string;
  }) => Promise<ResolvedHudControlPlaneDomain>;
  lifecycleLockDeps?: HudLifecycleLockDeps;
  probeTmuxInstance?: (paneId?: string) => Promise<ActualTmuxInstanceEvidence>;

}

function ensureHudResizeHook(
  hudPaneId: string,
  leaderPaneId: string | undefined,
  desiredHeight: number,
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps,
): void {
  try {
    (deps.registerHudResizeHook ?? registerHudResizeHook)(hudPaneId, leaderPaneId, desiredHeight, {
      cwd,
      env: deps.env ?? process.env,
    });
  } catch {
    // Non-critical — hook registration failure does not break HUD lifecycle.
  }
}

function hasCompleteGeometry(pane: TmuxPaneSnapshot): boolean {
  return (
    typeof pane.paneLeft === 'number'
    && typeof pane.paneWidth === 'number'
    && typeof pane.paneBottom === 'number'
    && typeof pane.windowWidth === 'number'
    && typeof pane.windowHeight === 'number'
  );
}

function needsHudTopologyRecreate(pane: TmuxPaneSnapshot, leaderPane?: TmuxPaneSnapshot): boolean {
  if (!hasCompleteGeometry(pane)) return false;
  const expectedLeft = typeof leaderPane?.paneLeft === 'number' ? leaderPane.paneLeft : 0;
  const expectedWidth = typeof leaderPane?.paneWidth === 'number' ? leaderPane.paneWidth : pane.windowWidth;
  const spansExpectedWidth = pane.paneLeft === expectedLeft && pane.paneWidth === expectedWidth;
  const touchesWindowBottom = pane.paneBottom === (pane.windowHeight ?? 0) - 1;
  return !spansExpectedWidth || !touchesWindowBottom;
}

function shouldCreateFullWidthHud(leaderPane?: TmuxPaneSnapshot): boolean {
  return Boolean(
    leaderPane
    && typeof leaderPane.paneLeft === 'number'
    && typeof leaderPane.paneWidth === 'number'
    && typeof leaderPane.windowWidth === 'number'
    && leaderPane.paneLeft === 0
    && leaderPane.paneWidth === leaderPane.windowWidth,
  );
}

function needsHudHeightResize(pane: TmuxPaneSnapshot, desiredHeight: number): boolean {
  return typeof pane.paneHeight !== 'number' || pane.paneHeight !== desiredHeight;
}

function tmuxSnapshotBindsCandidate(
  pane: TmuxPaneSnapshot,
  candidateSessionIds: readonly string[],
): boolean {
  const paneInstanceId = pane.paneInstanceId?.trim() ?? '';
  const sessionInstanceId = pane.sessionInstanceId?.trim() ?? '';
  const candidateIds = [...new Set(candidateSessionIds.map((candidate) => candidate.trim()).filter(Boolean))];
  const evidence: ActualTmuxInstanceEvidence = {
    paneTarget: pane.paneId,
    sessionName: '',
    paneInstanceId,
    sessionInstanceId,
    instanceId: paneInstanceId || sessionInstanceId,
    source: paneInstanceId ? 'pane' : sessionInstanceId ? 'session' : 'none',
    paneTagStatus: paneInstanceId ? 'present' : 'absent',
    sessionTagStatus: sessionInstanceId ? 'present' : 'absent',
    sessionId: '',
    windowId: '',
    contextStable: true,
  };
  return tmuxEvidenceBindsCandidate(evidence, candidateIds)
    || (candidateIds.length === 2
      && paneInstanceId === sessionInstanceId
      && candidateIds.includes(paneInstanceId));
}

function tmuxEvidenceMatchesClaimantBirth(
  evidence: ActualTmuxInstanceEvidence,
  domain: ResolvedHudControlPlaneDomain,
): boolean {
  const sessionBirthId = domain.claimant.tmuxSessionInstanceId?.trim() ?? '';
  const paneBirthId = domain.claimant.tmuxPaneInstanceId?.trim() ?? '';
  return Boolean(
    sessionBirthId
    && paneBirthId
    && evidence.contextStable
    && evidence.paneTagStatus === 'present'
    && evidence.sessionTagStatus === 'present'
    && evidence.sessionInstanceId === sessionBirthId
    && evidence.paneInstanceId === paneBirthId,
  );
}

function tmuxSnapshotMatchesClaimantBirth(
  pane: TmuxPaneSnapshot,
  domain: ResolvedHudControlPlaneDomain,
): boolean {
  const sessionBirthId = domain.claimant.tmuxSessionInstanceId?.trim() ?? '';
  const paneBirthId = domain.claimant.tmuxPaneInstanceId?.trim() ?? '';
  return Boolean(
    sessionBirthId
    && paneBirthId
    && pane.sessionInstanceId?.trim() === sessionBirthId
    && pane.paneInstanceId?.trim() === paneBirthId,
  );
}

function hasVerifiedHudPaneInstanceIdentity(
  pane: TmuxPaneSnapshot,
  equivalentSessionIds: ReadonlySet<string>,
): boolean {
  return tmuxSnapshotBindsCandidate(pane, [...equivalentSessionIds]);
}

function planOwnedHudPaneDedupe(
  panes: TmuxPaneSnapshot[],
  currentPaneId: string | undefined,
  owner: HudPaneOwner,
  preferredPaneId: string,
  equivalentSessionIds: ReadonlySet<string>,
  domain: ResolvedHudControlPlaneDomain,
): { paneId: string; duplicatePaneIds: string[]; unsafeCandidate: boolean } {
  const ownedPanes = panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner));
  if (ownedPanes.some((pane) => !hasVerifiedHudPaneInstanceIdentity(pane, equivalentSessionIds) && !tmuxSnapshotMatchesClaimantBirth(pane, domain))) {
    return { paneId: preferredPaneId, duplicatePaneIds: [], unsafeCandidate: true };
  }
  const ownedPaneIds = ownedPanes.map((pane) => pane.paneId);
  const keeperPaneId = ownedPaneIds.includes(preferredPaneId)
    ? preferredPaneId
    : (ownedPaneIds[0] ?? preferredPaneId);

  return {
    paneId: keeperPaneId,
    duplicatePaneIds: ownedPaneIds.filter((paneId) => paneId !== keeperPaneId),
    unsafeCandidate: false,
  };
}

const HUD_RECONCILE_LOCK_STALE_MS = 10_000;

function isVerifiedManagedHudOwner(
  domain: ResolvedHudControlPlaneDomain,
  currentPaneId: string | undefined,
  evidence: ActualTmuxInstanceEvidence,
): boolean {
  const equivalentSessionIds = [...new Set([
    domain.session?.canonicalId,
    ...(domain.session?.equivalentIds ?? []),
  ].map((sessionId) => sessionId?.trim() ?? '').filter(Boolean))];
  const acceptsSameAliasPair = equivalentSessionIds.length === 2
    && evidence.contextStable
    && evidence.paneTagStatus === 'present'
    && evidence.sessionTagStatus === 'present'
    && evidence.paneInstanceId === evidence.sessionInstanceId
    && equivalentSessionIds.includes(evidence.paneInstanceId);
  return Boolean(
    domain.managed
    && currentPaneId
    && evidence.paneTarget === currentPaneId
    && (tmuxEvidenceBindsCandidate(evidence, equivalentSessionIds) || acceptsSameAliasPair || tmuxEvidenceMatchesClaimantBirth(evidence, domain))
    && domain.claimant.leaderPaneId === currentPaneId
    && domain.claimant.tmuxSessionName
    && domain.claimant.tmuxSessionName === evidence.sessionName,
  );
}

function lifecycleLockDepsForReconcile(deps: ReconcileHudForPromptSubmitDeps): HudLifecycleLockDeps {
  if (!deps.isProcessLive) return deps.lifecycleLockDeps ?? {};
  return {
    ...deps.lifecycleLockDeps,
    probeProcess: deps.lifecycleLockDeps?.probeProcess ?? (async (owner) => {
      const live = deps.isProcessLive?.(owner.pid);
      return live === true ? 'live' : live === false ? 'dead' : 'uncertain';
    }),
  };
}


export async function reconcileHudForPromptSubmit(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<ReconcileHudForPromptSubmitResult> {
  const env = deps.env ?? process.env;
  if (!env.TMUX) {
    return {
      status: 'skipped_not_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  if (!isExplicitOmxOwnedTmuxEnv(env)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const currentPaneId = env.TMUX_PANE?.trim();
  const requestedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  if (!requestedSessionId) {
    return {
      status: 'skipped_no_session_id',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const domainEnv: NodeJS.ProcessEnv = {
    ...env,
    TMUX_PANE: undefined,
    TMUX_SESSION: undefined,
  };
  const domain = await (deps.resolveDomain ?? resolveHudControlPlaneDomain)({
    cwd,
    env: domainEnv,
    requestedSessionId,
  }).catch(() => null);
  const evidence = domain && currentPaneId
    ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
    : null;
  if (!domain || !evidence || !isVerifiedManagedHudOwner(domain, currentPaneId, evidence)) {
    return {
      status: 'skipped_not_omx_owned_tmux',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const resolveOmxCliEntryPathFn = deps.resolveOmxCliEntryPath ?? resolveOmxCliEntryPath;
  const omxBin = resolveOmxCliEntryPathFn();
  if (!omxBin) {
    return {
      status: 'skipped_no_entry',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const lockDirReady = await mkdir(domain.baseStateDir, { recursive: true }).then(() => true).catch(() => false);
  const acquired = lockDirReady
    ? await acquireHudLifecycleLock(
      { path: domain.reconcileLockPath, domainKey: domain.domainKey, staleMs: HUD_RECONCILE_LOCK_STALE_MS },
      {
        ...lifecycleLockDepsForReconcile(deps),
        nowMs: deps.lifecycleLockDeps?.nowMs ?? deps.nowMs ?? (() => Date.now()),
      },
    )
    : { status: 'failed' as const };
  if (acquired.status !== 'acquired' || !acquired.lock) {
    return {
      status: 'skipped_concurrent',
      paneId: null,
      desiredHeight: null,
      duplicateCount: 0,
    };
  }

  const listPanes = deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId));
  const createPane = deps.createHudWatchPane ?? ((hudCwd, hudCmd, options) => createHudWatchPane(hudCwd, hudCmd, options));
  const killPane = deps.killManagedHudPane ?? killExactHudPane;
  const resizePane = deps.resizeTmuxPane ?? ((paneId, lines) => resizeTmuxPane(paneId, lines));
  const lock = acquired.lock;
  const resolvedSessionId = domain.session?.canonicalId;
  const equivalentSessionIds = domain.session?.equivalentIds ?? [];
  try {

  const lockedEvidence = currentPaneId
    ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
    : null;
  if (!lockedEvidence || !isVerifiedManagedHudOwner(domain, currentPaneId, lockedEvidence)) {
    return { status: 'unchanged', paneId: null, desiredHeight: null, duplicateCount: 0 };
  }

  let panes = listPanes(currentPaneId);

  // Orphan cleanup is destructive and requires fresh exact evidence immediately
  // before each pane kill.

  // A Codex self-update can restart/resume the leader in the same tmux pane with
  // a new OMX session id while the old HUD watcher stays alive. Reap only HUDs
  // tied to this exact leader pane after fresh identity revalidation; neighboring
  // panes' HUDs remain isolated by leaderPaneId.

  const equivalentSessionIdSet = new Set(
    [resolvedSessionId, ...equivalentSessionIds].map((sessionId) => sessionId?.trim() ?? '').filter(Boolean),
  );
  const owner = {
    sessionId: resolvedSessionId,
    sessionIds: equivalentSessionIds,
    leaderPaneId: currentPaneId,
  };
  const exactHudKillCandidate = async (paneId: string, stale = false): Promise<ExactHudPaneKillCandidate | null> => {
    const latestEvidence = currentPaneId
      ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
      : null;
    if (!latestEvidence || !isVerifiedManagedHudOwner(domain, currentPaneId, latestEvidence)) return null;
    const latestPanes = listPanes(currentPaneId);
    const candidate = latestPanes.find((pane) => pane.paneId === paneId);
    if (!candidate || !isHudWatchPane(candidate)) return null;
    const candidateOwner = readHudPaneOwner(candidate);
    const ownerMatches = stale
      ? Boolean(
        candidateOwner.sessionId
        && candidateOwner.leaderPaneId
        && (equivalentSessionIdSet.has(candidateOwner.sessionId) || candidateOwner.leaderPaneId === currentPaneId)
        && hasVerifiedHudPaneInstanceIdentity(candidate, equivalentSessionIdSet),
      )
      : Boolean(
        latestPanes.some((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane))
        && hudPaneMatchesOwner(candidate, owner)
        && (hasVerifiedHudPaneInstanceIdentity(candidate, equivalentSessionIdSet) || tmuxSnapshotMatchesClaimantBirth(candidate, domain)),
      );
    if (!ownerMatches) return null;
    const paneInstanceId = candidate.paneInstanceId?.trim() ?? '';
    const sessionInstanceId = candidate.sessionInstanceId?.trim() ?? '';
    if (!paneInstanceId || !sessionInstanceId) return null;
    return {
      paneId,
      currentCommand: candidate.currentCommand,
      startCommand: candidate.startCommand,
      owner: candidateOwner,
      paneInstanceId,
      sessionInstanceId,
      sessionName: latestEvidence.sessionName,
    };
  };
  const killOwnedHudPane = async (paneId: string, stale = false): Promise<boolean> => {
    const candidate = await exactHudKillCandidate(paneId, stale);
    return candidate ? killPane(candidate) : false;
  };
  const liveNonHudPaneIds = new Set(panes.filter((pane) => !isHudWatchPane(pane)).map((pane) => pane.paneId));
  const staleHudPaneIds = panes
    .filter((pane) => pane.paneId !== currentPaneId && isHudWatchPane(pane))
    .filter((pane) => {
      const candidateOwner = readHudPaneOwner(pane);
      if (!candidateOwner.leaderPaneId || !candidateOwner.sessionId) return false;
      const sameSession = equivalentSessionIdSet.has(candidateOwner.sessionId);
      const deadSameSessionLeader = sameSession
        && candidateOwner.leaderPaneId !== currentPaneId
        && !liveNonHudPaneIds.has(candidateOwner.leaderPaneId);
      const staleCurrentLeader = candidateOwner.leaderPaneId === currentPaneId
        && !sameSession
        && new RegExp(`(?:^|\\s)${OMX_TMUX_HUD_OWNER_ENV}=(?:'1'|1)(?=$|\\s)`).test(`${pane.startCommand} ${pane.currentCommand}`);
      return deadSameSessionLeader || staleCurrentLeader;
    })
    .map((pane) => pane.paneId);
  for (const paneId of staleHudPaneIds) {
    await killOwnedHudPane(paneId, true);
  }
  if (staleHudPaneIds.length > 0) {
    const stalePaneIdSet = new Set(staleHudPaneIds);
    panes = panes.filter((pane) => !stalePaneIdSet.has(pane.paneId));
  }
  const ownedHudPanes = panes
    .filter((pane) => pane.paneId !== currentPaneId)
    .filter((pane) => hudPaneMatchesOwner(pane, owner));
  if (ownedHudPanes.some((pane) => !hasVerifiedHudPaneInstanceIdentity(pane, equivalentSessionIdSet) && !tmuxSnapshotMatchesClaimantBirth(pane, domain))) {
    return { status: 'unchanged', paneId: null, desiredHeight: null, duplicateCount: 0 };
  }
  const hudPaneIds = ownedHudPanes.map((pane) => pane.paneId);
  const duplicateCount = Math.max(0, hudPaneIds.length - 1);
  const readHudConfigFn = deps.readHudConfig ?? readHudConfig;
  const hudConfig = await readHudConfigFn(cwd).catch(() => null);
  const readAllStateFn = deps.readAllState ?? readAllState;
  const hudState = hudConfig ? await readAllStateFn(cwd, hudConfig).catch(() => null) : null;
  const desiredHeight = hudState ? getHudRenderMaxLines(hudState) : HUD_TMUX_HEIGHT_LINES;
  const preset = hudConfig?.preset;
  const hudCmd = buildHudWatchCommand(omxBin, preset, resolvedSessionId, env.OMX_ROOT, currentPaneId, {
    omxStateRoot: env.OMX_STATE_ROOT,
    omxTeamStateRoot: env.OMX_TEAM_STATE_ROOT,
    rootSource: env.OMX_TEAM_STATE_ROOT ? 'team-env' : env.OMX_ROOT ? 'omx-root-env' : env.OMX_STATE_ROOT ? 'omx-state-root-env' : 'cwd-default',
  });
  const leaderPane = currentPaneId
    ? panes.find((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane))
    : undefined;

  const singleHudPane = hudPaneIds.length === 1
    ? panes.find((pane) => pane.paneId === hudPaneIds[0])
    : undefined;
  if (singleHudPane && !needsHudTopologyRecreate(singleHudPane, leaderPane)) {
    const shouldResize = needsHudHeightResize(singleHudPane, desiredHeight);
    const resized = shouldResize ? resizePane(singleHudPane.paneId, desiredHeight) : true;
    if (resized) ensureHudResizeHook(singleHudPane.paneId, currentPaneId, desiredHeight, cwd, deps);
    return {
      status: resized ? (shouldResize ? 'resized' : 'unchanged') : 'failed',
      paneId: singleHudPane.paneId,
      desiredHeight,
      duplicateCount,
    };
  }

  if (hudPaneIds.length > 1) {
    const hudPanes = hudPaneIds
      .map((paneId) => panes.find((pane) => pane.paneId === paneId))
      .filter((pane): pane is TmuxPaneSnapshot => Boolean(pane));
    const keeperPane = hudPanes.find((pane) => !needsHudTopologyRecreate(pane, leaderPane));

    if (keeperPane) {
      for (const paneId of hudPaneIds.filter((paneId) => paneId !== keeperPane.paneId)) {
        await killOwnedHudPane(paneId);
      }
      const resized = resizePane(keeperPane.paneId, desiredHeight);
      if (resized) ensureHudResizeHook(keeperPane.paneId, currentPaneId, desiredHeight, cwd, deps);
      return {
        status: resized ? 'replaced_duplicates' : 'failed',
        paneId: keeperPane.paneId,
        desiredHeight,
        duplicateCount,
      };
    }
  }
  const createFullWidth = hudPaneIds
    .map((paneId) => panes.find((pane) => pane.paneId === paneId))
    .some((pane) => Boolean(pane && needsHudTopologyRecreate(pane, leaderPane)))
    && (!leaderPane || shouldCreateFullWidthHud(leaderPane));



  // When there is no existing HUD pane to keep/recreate, this reconcile would
  // create a fresh HUD split. Mirror the launch-time guard: if the current tmux
  // window is too short, skip the split so the first prompt submit cannot
  // recreate the cramped, unreadable 2-line HUD the launch path already
  // declined to add. Default behavior is preserved for normal/unknown heights.
  // (closes #2754)
  if (hudPaneIds.length === 0 && (deps.readCurrentWindowSize || !deps.listCurrentWindowPanes)) {
    const readWindowSize = deps.readCurrentWindowSize ?? ((paneId) => readCurrentWindowSize(undefined, paneId));
    const windowHeight = readWindowSize(currentPaneId).height;
    if (isTmuxWindowTooCrampedForHudSplit(windowHeight)) {
      return {
        status: 'skipped_window_too_cramped',
        paneId: null,
        desiredHeight,
        duplicateCount,
      };
    }
  }

  const unregisterHook = deps.unregisterHudResizeHook ?? unregisterHudResizeHook;
  if (!unregisterHook(currentPaneId) && hudPaneIds.length > 0) {
    return { status: 'unchanged', paneId: null, desiredHeight, duplicateCount };
  }

  const removedHudPaneIds = new Set<string>();
  for (const paneId of hudPaneIds) {
    if (await killOwnedHudPane(paneId)) removedHudPaneIds.add(paneId);
  }

  const createOptions: { heightLines: number; fullWidth?: boolean; targetPaneId?: string; instanceId?: string } = {
    heightLines: desiredHeight,
    targetPaneId: currentPaneId,
    instanceId: domain.claimant.tmuxPaneInstanceId?.trim() || undefined,
  };
  if (createFullWidth) createOptions.fullWidth = true;
  const paneId = createPane(cwd, hudCmd, createOptions);
  if (!paneId) {
    return {
      status: 'failed',
      paneId: null,
      desiredHeight,
      duplicateCount,
    };
  }

  // A launch-path restore and prompt-submit reconciliation can both observe
  // "no HUD" before either split-window has materialized. Re-scan after create
  // and collapse same-owner panes so the second creator cleans up the race
  // instead of leaving a duplicate HUD in the user window.
  const postCreate = planOwnedHudPaneDedupe(
    listPanes(currentPaneId).filter((pane) => !removedHudPaneIds.has(pane.paneId)),
    currentPaneId,
    owner,
    paneId,
    equivalentSessionIdSet,
    domain,
  );
  if (postCreate.unsafeCandidate) {
    return { status: 'recreated', paneId, desiredHeight, duplicateCount: 0 };
  }
  for (const duplicatePaneId of postCreate.duplicatePaneIds) {
    await killOwnedHudPane(duplicatePaneId);
  }
  const resized = resizePane(postCreate.paneId, desiredHeight);
  if (!resized) {
    return {
      status: 'failed',
      paneId: postCreate.paneId,
      desiredHeight,
      duplicateCount: postCreate.duplicatePaneIds.length,
    };
  }
  ensureHudResizeHook(postCreate.paneId, currentPaneId, desiredHeight, cwd, deps);

  return {
    status: postCreate.duplicatePaneIds.length > 0 || hudPaneIds.length > 1 ? 'replaced_duplicates' : 'recreated',
    paneId: postCreate.paneId,
    desiredHeight,
    duplicateCount: postCreate.duplicatePaneIds.length,
  };
  } finally {
    await releaseHudLifecycleLock(lock);
  }
}

export interface TeardownManagedHudResult {
  status: 'removed' | 'unchanged' | 'skipped_not_omx_owned_tmux' | 'skipped_concurrent';
  removedPaneIds: string[];
}

export async function teardownManagedHudPane(
  cwd: string,
  deps: ReconcileHudForPromptSubmitDeps = {},
): Promise<TeardownManagedHudResult> {
  const env = deps.env ?? process.env;
  const currentPaneId = env.TMUX_PANE?.trim();
  const requestedSessionId = deps.sessionId?.trim() || env.OMX_SESSION_ID?.trim() || undefined;
  if (!env.TMUX || !isExplicitOmxOwnedTmuxEnv(env) || !currentPaneId || !requestedSessionId) {
    return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
  }

  const domain = await (deps.resolveDomain ?? resolveHudControlPlaneDomain)({
    cwd,
    env: { ...env, TMUX_PANE: undefined, TMUX_SESSION: undefined },
    requestedSessionId,
  }).catch(() => null);
  const evidence = domain
    ? await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null)
    : null;
  if (!domain || !evidence || !isVerifiedManagedHudOwner(domain, currentPaneId, evidence)) {
    return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
  }

  const lockDirReady = await mkdir(domain.baseStateDir, { recursive: true }).then(() => true).catch(() => false);
  const acquired = lockDirReady
    ? await acquireHudLifecycleLock(
      { path: domain.reconcileLockPath, domainKey: domain.domainKey, staleMs: HUD_RECONCILE_LOCK_STALE_MS },
      lifecycleLockDepsForReconcile(deps),
    )
    : { status: 'failed' as const };
  if (acquired.status !== 'acquired' || !acquired.lock) {
    return { status: 'skipped_concurrent', removedPaneIds: [] };
  }

  try {
    const lockedEvidence = await (deps.probeTmuxInstance ?? probeActualTmuxInstanceEvidence)(currentPaneId).catch(() => null);
    if (!lockedEvidence || !isVerifiedManagedHudOwner(domain, currentPaneId, lockedEvidence)) {
      return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
    }

    const panes = (deps.listCurrentWindowPanes ?? ((paneId) => listCurrentWindowPanes(undefined, paneId)))(currentPaneId);
    const leader = panes.find((pane) => pane.paneId === currentPaneId && !isHudWatchPane(pane));
    const equivalentSessionIds = new Set(
      [domain.session?.canonicalId, ...(domain.session?.equivalentIds ?? [])]
        .map((value) => value?.trim() ?? '')
        .filter(Boolean),
    );
    if (!leader || (!tmuxSnapshotBindsCandidate(leader, [...equivalentSessionIds]) && !tmuxSnapshotMatchesClaimantBirth(leader, domain))) {
      return { status: 'skipped_not_omx_owned_tmux', removedPaneIds: [] };
    }

    const identity = {
      tmuxSessionInstanceId: leader.sessionInstanceId?.trim() ?? '',
      tmuxPaneInstanceId: leader.paneInstanceId?.trim() ?? '',
    };
    const exactHudPaneIds = panes
      .filter((pane) => pane.paneId !== currentPaneId && isHudWatchPane(pane))
      .filter((pane) => tmuxSnapshotBindsCandidate(pane, [...equivalentSessionIds]) || tmuxSnapshotMatchesClaimantBirth(pane, domain))
      .filter((pane) => [...equivalentSessionIds].some((sessionId) => hudPaneMatchesExactCandidate(
        pane,
        { sessionId, leaderPaneId: currentPaneId },
        identity,
      )))
      .map((pane) => pane.paneId);
    const hooksUnregistered = (deps.unregisterHudResizeHook ?? unregisterHudResizeHook)(currentPaneId);
    if (!hooksUnregistered) {
      return { status: 'unchanged', removedPaneIds: [] };
    }
    if (exactHudPaneIds.length === 0) {
      return { status: 'unchanged', removedPaneIds: [] };
    }
    const removedPaneIds: string[] = [];
    const killPane = deps.killManagedHudPane ?? killExactHudPane;
    for (const pane of panes.filter((candidate) => exactHudPaneIds.includes(candidate.paneId))) {
      const paneInstanceId = pane.paneInstanceId?.trim() ?? '';
      const sessionInstanceId = pane.sessionInstanceId?.trim() ?? '';
      const owner = readHudPaneOwner(pane);
      if (paneInstanceId && sessionInstanceId && killPane({
        paneId: pane.paneId,
        currentCommand: pane.currentCommand,
        startCommand: pane.startCommand,
        owner,
        paneInstanceId,
        sessionInstanceId,
        sessionName: lockedEvidence.sessionName,
      })) removedPaneIds.push(pane.paneId);
    }
    return { status: removedPaneIds.length > 0 ? 'removed' : 'unchanged', removedPaneIds };
  } finally {
    await releaseHudLifecycleLock(acquired.lock);
  }
}
