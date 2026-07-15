import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	initializeStateAuthority,
	mintStateAuthorityTransportCapability,
	resolveStateAuthorityForGuard,
} from "../../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../../state/transport-env.js";
import {
	TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS,
	TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS,
} from "../../team/state-root.js";
import { hardenTestAuthorityTreeSync } from "../../team/__tests__/authority-fixture.js";
import { writeSessionStart } from "../session.js";

async function notifyFixtureAuthority(
	observedCwd: string,
	sessionId: string,
): Promise<{
	env: NodeJS.ProcessEnv;
	canonicalSessionDir: string;
}> {
	const env = { ...process.env };
	for (const key of [
		...TEAM_AMBIENT_STATE_ROOT_ALIAS_ENV_KEYS,
		...TEAM_STATE_AUTHORITY_TRANSPORT_ENV_KEYS,
	]) {
		delete env[key];
	}
	await mkdir(observedCwd, { recursive: true, mode: 0o700 });
	await mkdir(join(observedCwd, ".omx"), { recursive: true, mode: 0o700 });
	await chmod(join(observedCwd, ".omx"), 0o700);
	hardenTestAuthorityTreeSync(observedCwd);
	const authority = await initializeStateAuthority({
		startup_cwd: observedCwd,
		observed_cwd: observedCwd,
		launch_id: `notify-non-omx-${sessionId}-${Date.now()}`,
		session_binding: { canonical_session_id: sessionId },
	});
	await chmod(authority.canonical_state_root, 0o700);
	await writeSessionStart(observedCwd, sessionId, { pid: process.pid });
	const refreshedAuthority = await resolveStateAuthorityForGuard({
		startup_cwd: observedCwd,
		observed_cwd: observedCwd,
		session_id: sessionId,
	});
	await mintStateAuthorityTransportCapability(refreshedAuthority);
	const childTransportEnv = buildStateAuthorityTransportEnv(
		refreshedAuthority,
		{ ...env, OMX_SESSION_ID: sessionId },
	);
	hardenTestAuthorityTreeSync(observedCwd);
	return {
		env: childTransportEnv,
		canonicalSessionDir: join(
			refreshedAuthority.canonical_state_root,
			"sessions",
			sessionId,
		),
	};
}

describe("notify-hook non-OMX project guard", () => {
	it("stores boxed prompt skill mode detail in the persisted authority session root", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-boxed-skill-"));
		const wd = join(root, "source");
		const sessionId = "sess-notify-ralplan";
		try {
			const fixture = await notifyFixtureAuthority(wd, sessionId);
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(join(wd, ".omx", "managed"), "");
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-notify",
				turn_id: "turn-notify",
				"input-messages": ["$ralplan implement issue #1307"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...fixture.env,
					},
				},
			);
			assert.equal(result.status, 0);
			const boxedSessionDir = fixture.canonicalSessionDir;
			assert.equal(
				existsSync(join(boxedSessionDir, "skill-active-state.json")),
				true,
			);
			assert.equal(
				existsSync(join(boxedSessionDir, "ralplan-state.json")),
				true,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "skill-active-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "ralplan-state.json")),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not let a team-worker prompt mutate leader-scoped skill state", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-team-worker-skill-"));
		const wd = join(root, "worker-worktree");
		const teamName = "fixhud";
		const workerName = "worker-1";
		const sessionId = "sess-worker-ralplan";
		try {
			await mkdir(wd, { recursive: true });
			const fixture = await notifyFixtureAuthority(wd, sessionId);
			const teamStateRoot = fixture.canonicalSessionDir;
			const teamDir = join(teamStateRoot, "team", teamName);
			await mkdir(join(teamDir, "workers", workerName), { recursive: true });
			await writeFile(
				join(teamDir, "config.json"),
				JSON.stringify({
					name: teamName,
					session_id: sessionId,
					leader: { session_id: sessionId },
					workers: [{ name: workerName, worktree_path: wd }],
				}),
			);
			await writeFile(
				join(teamDir, "workers", workerName, "identity.json"),
				JSON.stringify({
					name: workerName,
					team_name: teamName,
					session_id: sessionId,
					worktree_path: wd,
					team_state_root: teamStateRoot,
				}),
			);
			hardenTestAuthorityTreeSync(wd);
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-worker",
				turn_id: "turn-worker",
				"input-messages": ["$ralplan implement issue #1307"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...fixture.env,
						OMX_TEAM_INTERNAL_WORKER: `${teamName}/${workerName}`,
						OMX_TEAM_STATE_ROOT: teamStateRoot,
						OMX_TEAM_LEADER_CWD: wd,
					},
				},
			);
			assert.equal(result.status, 0);
			const teamSessionDir = fixture.canonicalSessionDir;
			assert.equal(
				existsSync(join(teamSessionDir, "skill-active-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(teamSessionDir, "ralplan-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "skill-active-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "ralplan-state.json")),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stores non-worker prompt skill state in the persisted authority session root", async () => {
		const root = await mkdtemp(join(tmpdir(), "omx-notify-team-root-skill-"));
		const wd = join(root, "source");
		const sessionId = "sess-notify-team-root";
		try {
			await mkdir(join(wd, ".omx"), { recursive: true });
			await writeFile(join(wd, ".omx", "managed"), "");
			const fixture = await notifyFixtureAuthority(wd, sessionId);
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				session_id: sessionId,
				thread_id: "thread-notify-team-root",
				turn_id: "turn-notify-team-root",
				"input-messages": ["$ralplan implement issue #1307"],
				"last-assistant-message": "working",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
					env: {
						...fixture.env,
					},
				},
			);
			assert.equal(result.status, 0);
			const teamSessionDir = fixture.canonicalSessionDir;
			assert.equal(
				existsSync(join(teamSessionDir, "skill-active-state.json")),
				true,
			);
			assert.equal(
				existsSync(join(teamSessionDir, "ralplan-state.json")),
				true,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "skill-active-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(wd, ".omx", "state", "ralplan-state.json")),
				false,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("exits without creating .omx artifacts for unmanaged cwd", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-unmanaged-"));
		try {
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				"turn-id": "t1",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
				},
			);
			assert.equal(result.status, 0);
			assert.equal(existsSync(join(wd, ".omx")), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("ignores stale .omx state/log directories without an ownership marker", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-stale-state-"));
		try {
			await mkdir(join(wd, ".omx", "state"), { recursive: true });
			await mkdir(join(wd, ".omx", "logs"), { recursive: true });
			const payload = JSON.stringify({
				cwd: wd,
				type: "agent-turn-complete",
				"turn-id": "t1",
				"last-assistant-message": "completed",
			});
			const result = spawnSync(
				process.execPath,
				["dist/scripts/notify-hook.js", payload],
				{
					cwd: process.cwd(),
					encoding: "utf-8",
				},
			);
			assert.equal(result.status, 0);
			assert.equal(existsSync(join(wd, ".omx", "state", "notify.json")), false);
			assert.equal(
				existsSync(join(wd, ".omx", "logs", "notify-hook.log")),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
