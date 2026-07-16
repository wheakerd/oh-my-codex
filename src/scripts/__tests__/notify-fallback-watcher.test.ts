import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  initializeStateAuthority,
  mintStateAuthorityTransportCapability,
} from "../../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../../state/transport-env.js";
import {
  captureNotifyWatcherProcessStartIdentity,
  createNotifyWatcherPidRecord,
  parseNotifyWatcherPidRecord,
  processMatchesNotifyWatcherPidRecord,
  readNotifyWatcherPidRecordNoFollow,
} from "../../state/notify-watcher-pid.js";

async function authenticatedWatcherEnv(cwd: string, sessionId: string): Promise<NodeJS.ProcessEnv> {
  const authority = await initializeStateAuthority({
    startup_cwd: cwd,
    observed_cwd: cwd,
    launch_id: `notify-fallback-test-${sessionId}`,
    session_binding: { canonical_session_id: sessionId },
  });
  await mintStateAuthorityTransportCapability(authority);
  return {
    ...process.env,
    ...buildStateAuthorityTransportEnv(authority, process.env),
    OMX_SESSION_ID: sessionId,
  };
}

function watcherScriptPath(): string {
  return new URL("../notify-fallback-watcher.js", import.meta.url).pathname;
}

function runWatcherOnce(cwd: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [watcherScriptPath(), "--once", "--authority-only", "--cwd", cwd, "--notify-script", process.execPath],
    { cwd, env },
  );
}


describe("notify-fallback-watcher authority boundary", () => {
  it("does not create caller-selected state roots without authenticated transport", async () => {
    const base = await mkdtemp(join(tmpdir(), "omx-fallback-authority-"));
    const cwd = join(base, "workspace");
    const hostileRoot = join(base, "hostile-root");
    try {
      await mkdir(cwd, { recursive: true });
      const watcherScript = new URL("../notify-fallback-watcher.js", import.meta.url).pathname;
      const result = spawnSync(
        process.execPath,
        [watcherScript, "--once", "--cwd", cwd, "--notify-script", process.execPath],
        {
          cwd,
          env: {
            ...process.env,
            OMX_ROOT: hostileRoot,
            OMX_STATE_ROOT: hostileRoot,
          },
        },
      );
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(hostileRoot), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("runs against the authenticated generation without caller-selected roots", async () => {
    const base = await mkdtemp(join(tmpdir(), "omx-fallback-pinned-normal-"));
    const cwd = join(base, "workspace");
    try {
      await mkdir(cwd, { recursive: true });
      const result = runWatcherOnce(cwd, await authenticatedWatcherEnv(cwd, "fallback-normal"));
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(existsSync(join(cwd, ".omx", "state", "notify-fallback-state.json")), true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails closed when the authenticated state-root object is replaced before startup", async () => {
    const base = await mkdtemp(join(tmpdir(), "omx-fallback-pinned-replacement-"));
    const cwd = join(base, "workspace");
    const stateRoot = join(cwd, ".omx", "state");
    const displacedRoot = join(cwd, ".omx", "state-displaced");
    try {
      await mkdir(cwd, { recursive: true });
      const env = await authenticatedWatcherEnv(cwd, "fallback-replacement");
      await rename(stateRoot, displacedRoot);
      await mkdir(stateRoot, { recursive: true });
      const result = runWatcherOnce(cwd, env);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(join(stateRoot, "notify-fallback-state.json")), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("notify watcher PID ownership record", () => {
  it("does not expose process-start custody off Linux", { skip: process.platform === "linux" }, () => {
    assert.equal(captureNotifyWatcherProcessStartIdentity(process.pid), null);
  });
  it("round-trips the launcher and watcher schema and rejects a reused PID identity", { skip: process.platform !== "linux" }, async () => {
    const base = await mkdtemp(join(tmpdir(), "omx-watcher-pid-contract-"));
    const root = join(base, "state");
    try {
      await mkdir(root, { recursive: true });
      const rootStat = await (await import("node:fs/promises")).stat(root);
      const identity = captureNotifyWatcherProcessStartIdentity(process.pid);
      assert.ok(identity);
      const authority = {
        canonical_state_root: root,
        generation: {
          authority_id: "authority",
          generation_id: "generation",
          root_identity: { device: String(rootStat.dev), inode: String(rootStat.ino), canonical_path: root },
        },
        workspace_identity: { digest: "workspace" },
      };
      const record = createNotifyWatcherPidRecord(authority, {
        owner_token: "owner",
        cwd: base,
        pid: process.pid,
        process_start_identity: identity,
        started_at: new Date().toISOString(),
      });
      assert.deepEqual(parseNotifyWatcherPidRecord(JSON.stringify(record)), record);
      assert.equal(processMatchesNotifyWatcherPidRecord(record), true);
      const reused = { ...record, process_start_identity: { ...record.process_start_identity, start_ticks: "0" } };
      assert.equal(processMatchesNotifyWatcherPidRecord(reused), false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("fails closed when the PID record is swapped during custody", { skip: process.platform !== "linux" }, async () => {
    const base = await mkdtemp(join(tmpdir(), "omx-watcher-pid-swap-"));
    const root = join(base, "state");
    const pidPath = join(root, "notify-fallback.pid");
    try {
      await mkdir(root, { recursive: true });
      const rootStat = await (await import("node:fs/promises")).stat(root);
      const identity = captureNotifyWatcherProcessStartIdentity(process.pid);
      assert.ok(identity);
      const authority = {
        canonical_state_root: root,
        generation: {
          authority_id: "authority",
          generation_id: "generation",
          root_identity: { device: String(rootStat.dev), inode: String(rootStat.ino), canonical_path: root },
        },
        workspace_identity: { digest: "workspace" },
      };
      const record = createNotifyWatcherPidRecord(authority, {
        owner_token: "owner",
        cwd: base,
        pid: process.pid,
        process_start_identity: identity,
        started_at: new Date().toISOString(),
      });
      await writeFile(pidPath, JSON.stringify(record));
      const read = await readNotifyWatcherPidRecordNoFollow(pidPath, authority);
      assert.deepEqual(read, record);
      await rename(root, `${root}-displaced`);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "notify-fallback.pid"), JSON.stringify(record));
      await assert.rejects(readNotifyWatcherPidRecordNoFollow(join(root, "notify-fallback.pid"), authority));
    } finally {
      await rm(base, { recursive: true, force: true });
      await rm(`${root}-displaced`, { recursive: true, force: true });
    }
  });
});
