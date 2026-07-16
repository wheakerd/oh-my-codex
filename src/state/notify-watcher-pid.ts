import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const NOTIFY_WATCHER_PID_SCHEMA_VERSION = 1 as const;

export interface NotifyWatcherRootIdentity {
  device: string | number;
  inode: string | number;
  canonical_path: string;
}

export interface NotifyWatcherProcessStartIdentity {
  schema_version: 1;
  platform: "linux";
  boot_id: string;
  start_ticks: string;
}

export interface NotifyWatcherPidRecord {
  schema_version: 1;
  owner_token: string;
  authority_id: string;
  generation_id: string;
  workspace_digest: string;
  root_identity: NotifyWatcherRootIdentity;
  cwd: string;
  pid: number;
  process_start_identity: NotifyWatcherProcessStartIdentity;
  started_at: string;
}

export interface NotifyWatcherPidAuthority {
  canonical_state_root: string;
  generation: {
    authority_id: string;
    generation_id: string;
    root_identity: NotifyWatcherRootIdentity;
  };
  workspace_identity: { digest: string };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRootIdentity(value: unknown): value is NotifyWatcherRootIdentity {
  return typeof value === "object" && value !== null
    && (typeof (value as NotifyWatcherRootIdentity).device === "string" || typeof (value as NotifyWatcherRootIdentity).device === "number")
    && (typeof (value as NotifyWatcherRootIdentity).inode === "string" || typeof (value as NotifyWatcherRootIdentity).inode === "number")
    && isNonEmptyString((value as NotifyWatcherRootIdentity).canonical_path);
}

export function sameNotifyWatcherRootIdentity(
  left: NotifyWatcherRootIdentity,
  right: NotifyWatcherRootIdentity,
): boolean {
  return String(left.device) === String(right.device)
    && String(left.inode) === String(right.inode)
    && resolve(left.canonical_path) === resolve(right.canonical_path);
}

export function parseNotifyWatcherPidRecord(content: string): NotifyWatcherPidRecord | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Partial<NotifyWatcherPidRecord>;
    const identity = record.process_start_identity;
    if (
      record.schema_version !== NOTIFY_WATCHER_PID_SCHEMA_VERSION
      || !isNonEmptyString(record.owner_token)
      || !isNonEmptyString(record.authority_id)
      || !isNonEmptyString(record.generation_id)
      || !isNonEmptyString(record.workspace_digest)
      || !isRootIdentity(record.root_identity)
      || !isNonEmptyString(record.cwd)
      || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
      || !isNonEmptyString(record.started_at)
      || typeof identity !== "object" || identity === null
      || identity.schema_version !== 1
      || identity.platform !== "linux"
      || !isNonEmptyString(identity.boot_id)
      || !isNonEmptyString(identity.start_ticks)
    ) return null;
    return record as NotifyWatcherPidRecord;
  } catch {
    return null;
  }
}

export function createNotifyWatcherPidRecord(
  authority: NotifyWatcherPidAuthority,
  input: Omit<NotifyWatcherPidRecord, "schema_version" | "authority_id" | "generation_id" | "workspace_digest" | "root_identity">,
): NotifyWatcherPidRecord {
  return {
    schema_version: NOTIFY_WATCHER_PID_SCHEMA_VERSION,
    owner_token: input.owner_token,
    authority_id: authority.generation.authority_id,
    generation_id: authority.generation.generation_id,
    workspace_digest: authority.workspace_identity.digest,
    root_identity: authority.generation.root_identity,
    cwd: resolve(input.cwd),
    pid: input.pid,
    process_start_identity: input.process_start_identity,
    started_at: input.started_at,
  };
}

export function captureNotifyWatcherProcessStartIdentity(
  pid: number,
): NotifyWatcherProcessStartIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform !== "linux") return null;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
    const processStat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const closingParen = processStat.lastIndexOf(")");
    if (!bootId || closingParen < 0) return null;
    // Field 22 is starttime; the suffix starts at field 3.
    const startTicks = processStat.slice(closingParen + 1).trim().split(/\s+/)[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    return { schema_version: 1, platform: "linux", boot_id: bootId, start_ticks: startTicks };
  } catch {
    return null;
  }
}

export function processMatchesNotifyWatcherPidRecord(record: NotifyWatcherPidRecord): boolean {
  const current = captureNotifyWatcherProcessStartIdentity(record.pid);
  return current !== null
    && current.platform === record.process_start_identity.platform
    && current.boot_id === record.process_start_identity.boot_id
    && current.start_ticks === record.process_start_identity.start_ticks;
}

export function recordMatchesNotifyWatcherAuthority(
  record: NotifyWatcherPidRecord,
  authority: NotifyWatcherPidAuthority,
  cwd: string,
): boolean {
  return record.authority_id === authority.generation.authority_id
    && record.generation_id === authority.generation.generation_id
    && record.workspace_digest === authority.workspace_identity.digest
    && sameNotifyWatcherRootIdentity(record.root_identity, authority.generation.root_identity)
    && resolve(record.cwd) === resolve(cwd);
}

/** Reads a stable, regular PID record from the already authenticated state root. */
export async function readNotifyWatcherPidRecordNoFollow(
  path: string,
  authority: NotifyWatcherPidAuthority,
): Promise<NotifyWatcherPidRecord | null> {
  const expectedRoot = resolve(authority.canonical_state_root);
  if (resolve(path).slice(0, expectedRoot.length + 1) !== `${expectedRoot}/`) {
    throw new Error("notify watcher PID record escapes authenticated state root");
  }
  const rootBefore = await stat(expectedRoot);
  if (!rootBefore.isDirectory() || !sameNotifyWatcherRootIdentity({
    device: rootBefore.dev,
    inode: rootBefore.ino,
    canonical_path: expectedRoot,
  }, authority.generation.root_identity)) {
    throw new Error("notify watcher authority root was replaced before PID read");
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number" || noFollow === 0) {
    throw new Error("safe no-follow PID record reads are unavailable on this platform");
  }
  let initial: Awaited<ReturnType<typeof lstat>>;
  try {
    initial = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (initial.isSymbolicLink() || !initial.isFile()) throw new Error("notify watcher PID record is not a regular file");
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const beforeRead = await stat(path);
    if (!beforeRead.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || beforeRead.dev !== opened.dev || beforeRead.ino !== opened.ino) {
      throw new Error("notify watcher PID record changed while opening");
    }
    const raw = await handle.readFile("utf-8");
    const afterRead = await stat(path);
    const rootAfter = await stat(expectedRoot);
    if (!afterRead.isFile() || afterRead.dev !== opened.dev || afterRead.ino !== opened.ino
      || !rootAfter.isDirectory() || !sameNotifyWatcherRootIdentity({
        device: rootAfter.dev,
        inode: rootAfter.ino,
        canonical_path: expectedRoot,
      }, authority.generation.root_identity)) {
      throw new Error("notify watcher PID record or authority root changed while being read");
    }
    return parseNotifyWatcherPidRecord(raw);
  } finally {
    await handle.close();
  }
}
