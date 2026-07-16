import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	initializeStateAuthority,
	mintStateAuthorityTransportCapability,
	resolveStateAuthorityForGuard,
} from "../../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../../state/transport-env.js";
import { hardenTestAuthorityTreeSync } from "../../team/__tests__/authority-fixture.js";
import { resolveWorkerNotifyTeamStateRoot } from "../../team/state-root.js";
import { writeSessionStart } from "../session.js";

const fixtureAuthorityEnv = new Map<string, NodeJS.ProcessEnv>();

async function initializeNotifyFixtureAuthority(cwd: string): Promise<void> {
	const sessionId = "notify-worker-idle";
	await mkdir(join(cwd, ".omx"), { recursive: true, mode: 0o700 });
	await chmod(join(cwd, ".omx"), 0o700);
	await initializeStateAuthority({
		startup_cwd: cwd,
		observed_cwd: cwd,
		launch_id: `notify-worker-idle-${Date.now()}`,
		session_binding: { canonical_session_id: sessionId },
	});
	await writeSessionStart(cwd, sessionId, {
		pid: process.pid,
		nativeSessionId: sessionId,
		tmuxSessionName: "session-test",
		tmuxPaneId: "%1",
	});
	const refreshedAuthority = await resolveStateAuthorityForGuard({
		startup_cwd: cwd,
		observed_cwd: cwd,
		session_id: sessionId,
	});
	await mintStateAuthorityTransportCapability(refreshedAuthority);
	await chmod(refreshedAuthority.canonical_state_root, 0o700);
	fixtureAuthorityEnv.set(
		cwd,
		buildStateAuthorityTransportEnv(refreshedAuthority, {
			...process.env,
			OMX_SESSION_ID: sessionId,
		}),
	);
}

const NOTIFY_HOOK_SCRIPT = new URL(
	"../../../dist/scripts/notify-hook.js",
	import.meta.url,
);

async function withTempWorkingDir(
	run: (cwd: string) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "omx-notify-worker-idle-"));
	try {
		await initializeNotifyFixtureAuthority(cwd);
		await run(cwd);
	} finally {
		fixtureAuthorityEnv.delete(cwd);
		await rm(cwd, { recursive: true, force: true });
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	const isTeamConfig = path.endsWith("config.json");
	const workspaceMarker = "/.omx/state/";
	const workspaceIndex = path.indexOf(workspaceMarker);
	const leaderCwd =
		workspaceIndex > 0 ? path.slice(0, workspaceIndex) : undefined;
	const persisted =
		path.includes("/team/") && value && typeof value === "object"
			? {
					session_id: "notify-worker-idle",
					owner_session_id: "notify-worker-idle",
					owner_codex_session_id: "notify-worker-idle",
					...(isTeamConfig && leaderCwd ? { leader_cwd: leaderCwd } : {}),
					...(value as Record<string, unknown>),
				}
			: value;
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify(persisted, null, 2));
	if (isTeamConfig && persisted && typeof persisted === "object") {
		const config = persisted as {
			name?: unknown;
			workers?: unknown[];
			tmux_session?: unknown;
			leader_pane_id?: unknown;
			leader_cwd?: unknown;
		};
		await writeFile(
			join(path, "..", "manifest.v2.json"),
			JSON.stringify(
				{
					schema_version: 2,
					name: config.name ?? "fixture-team",
					session_id: "notify-worker-idle",
					owner_session_id: "notify-worker-idle",
					owner_codex_session_id: "notify-worker-idle",
					leader: {
						session_id: "notify-worker-idle",
						worker_id: "leader-fixed",
						role: "coordinator",
					},
					leader_cwd: config.leader_cwd ?? null,
					tmux_session: config.tmux_session ?? null,
					leader_pane_id: config.leader_pane_id ?? null,
					workers: config.workers ?? [],
				},
				null,
				2,
			),
		);
	}
}

function buildFakeTmux(tmuxLogPath: string): string {
	return `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "show-option" ]]; then
  echo "notify-worker-idle"
  exit 0
fi
if [[ "$cmd" == "display-message" ]]; then
  if [[ "\${@: -1}" == "#{@omx_instance_id}" || "\${@: -1}" == "#{@omx_pane_instance_id}" ]]; then
    echo "notify-worker-idle"
  elif [[ "\${@: -1}" == "#S" ]]; then
    echo "session-test"
  elif [[ "\${@: -1}" == "#{session_name}\t#{pane_id}\t#{pane_pid}" ]]; then
    target=""
    while (($#)); do
      case "$1" in
        -t) target="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    printf 'session-test\t%s\t12345\n' "$target"
  fi
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  if [[ "$*" == *"pane_active"* ]]; then
    printf '%%1\t1\tcodex\tcodex\n'
  else
    echo "%1 12345"
  fi
  exit 0
fi
exit 0
`;
}

function writeWorkerIdentityFixture(cwd: string, workerEnv: string): string {
	const [teamName, workerName] = workerEnv.split("/");
	assert.ok(teamName, "worker env fixture should include a team name");
	assert.ok(workerName, "worker env fixture should include a worker name");

	const stateRoot = join(
		cwd,
		".omx",
		"state",
		"sessions",
		"notify-worker-idle",
	);
	const workerDir = join(stateRoot, "team", teamName, "workers", workerName);
	const identityPath = join(workerDir, "identity.json");
	if (!existsSync(identityPath)) {
		mkdirSync(workerDir, { recursive: true });
		writeFileSync(
			identityPath,
			JSON.stringify(
				{
					name: workerName,
					team_name: teamName,
					owner_session_id: "notify-worker-idle",
					session_id: "notify-worker-idle",
					owner_codex_session_id: "notify-worker-idle",
					index: Number(workerName.replace(/^worker-/, "")) || 1,
					role: "executor",
					assigned_tasks: [],
					worktree_path: cwd,
					team_state_root: stateRoot,
				},
				null,
				2,
			),
		);
	}
	const manifestPath = join(stateRoot, "team", teamName, "manifest.v2.json");
	if (existsSync(manifestPath)) {
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			workers?: Array<Record<string, unknown>>;
		};
		const workerIdentity = JSON.parse(
			readFileSync(identityPath, "utf8"),
		) as Record<string, unknown>;
		manifest.workers = [
			...(manifest.workers ?? []).filter(
				(candidate) => candidate.name !== workerName,
			),
			{
				name: workerName,
				index: workerIdentity.index,
				role: workerIdentity.role,
				assigned_tasks: workerIdentity.assigned_tasks,
				worktree_path: cwd,
			},
		];
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	}
	const configPath = join(stateRoot, "team", teamName, "config.json");
	if (existsSync(configPath)) {
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {
			workers?: Array<Record<string, unknown>>;
		};
		const workerIdentity = JSON.parse(
			readFileSync(identityPath, "utf8"),
		) as Record<string, unknown>;
		config.workers = [
			...(config.workers ?? []).filter(
				(candidate) => candidate.name !== workerName,
			),
			{
				name: workerName,
				index: workerIdentity.index,
				role: workerIdentity.role,
				assigned_tasks: workerIdentity.assigned_tasks,
				worktree_path: cwd,
			},
		];
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	}
	return stateRoot;
}

function runNotifyHookAsWorker(
	cwd: string,
	fakeBinDir: string,
	workerEnv: string,
	extraEnv: Record<string, string> = {},
	options: { writeIdentity?: boolean } = {},
): ReturnType<typeof spawnSync> {
	if (options.writeIdentity !== false)
		writeWorkerIdentityFixture(cwd, workerEnv);
	const payload = {
		cwd,
		type: "agent-turn-complete",
		"thread-id": "thread-worker",
		"turn-id": `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		"input-messages": ["working"],
		"last-assistant-message": "task done",
	};

	hardenTestAuthorityTreeSync(cwd);
	return spawnSync(
		process.execPath,
		[NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)],
		{
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
				...fixtureAuthorityEnv.get(cwd),
				OMX_TEAM_WORKER: workerEnv,
				OMX_TEST_TMUX_BIN: join(fakeBinDir, "tmux"),
				OMX_TEAM_INTERNAL_WORKER: workerEnv,
				OMX_TEAM_WORKER_IDLE_COOLDOWN_MS: "500",
				OMX_TEAM_ALL_IDLE_COOLDOWN_MS: "600000", // suppress all-idle to isolate per-worker
				TMUX:
					options.writeIdentity === false ? "" : "/tmp/tmux-1000/default,1,0",
				TMUX_PANE: options.writeIdentity === false ? "" : "%1",
				// Isolate from inherited team env (same pattern as all-workers-idle tests)
				OMX_TEAM_STATE_ROOT:
					options.writeIdentity === false
						? ""
						: join(cwd, ".omx", "state", "sessions", "notify-worker-idle"),
				OMX_TEAM_LEADER_CWD: options.writeIdentity === false ? "" : cwd,
				...extraEnv,
			},
		},
	);
}

describe("notify-hook per-worker idle notification", {
	concurrency: false,
}, () => {
	it("fires notification on working->idle transition", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "idle-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Worker is now idle
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				current_task_id: "task-42",
				reason: "task complete",
				updated_at: new Date().toISOString(),
			});

			// Previous state was working
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			writeWorkerIdentityFixture(cwd, `${teamName}/worker-1`);
			const workerResolution = await resolveWorkerNotifyTeamStateRoot(
				cwd,
				{ teamName, workerName: "worker-1" },
				{
					...fixtureAuthorityEnv.get(cwd),
					OMX_TEAM_INTERNAL_WORKER: `${teamName}/worker-1`,
					OMX_TEAM_STATE_ROOT: stateDir,
					OMX_TEAM_LEADER_CWD: cwd,
				},
			);
			assert.equal(workerResolution.ok, true, JSON.stringify(workerResolution));
			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/-t devsess:0/,
					"should not target session for leader notify",
				);
			}

			const heartbeatPath = join(workersDir, "worker-1", "heartbeat.json");
			assert.ok(existsSync(heartbeatPath), `authenticated worker heartbeat should exist: ${result.stderr || result.stdout}`);
			const heartbeat = JSON.parse(await readFile(heartbeatPath, "utf-8"));
			assert.equal(heartbeat.session_id, "notify-worker-idle");
			const eventsPath = join(teamDir, "events", "events.ndjson");
			assert.ok(
				existsSync(eventsPath),
				"events.ndjson should exist for deferred leader notification",
			);
			const events = (await readFile(eventsPath, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const event = events.find(
				(entry: { type?: string; reason?: string }) =>
					entry.type === "leader_notification_deferred" &&
					entry.reason === "leader_pane_missing_no_injection",
			);
			assert.ok(event, "should emit deferred event with missing-pane reason");
			assert.equal(event.to_worker, "leader-fixed");
			assert.equal(event.source_type, "worker_idle");
			assert.equal(event.tmux_session, "devsess:0");
			assert.equal(event.leader_pane_id, null);
			assert.equal(event.tmux_injection_attempted, false);
		});
	});

	it("fails closed instead of guessing the worker cwd .omx/state when identity is missing", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "missing-identity-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "missing-identity:0",
				leader_pane_id: "%77",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				current_task_id: "task-42",
				reason: "task complete",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{ OMX_TEAM_STATE_ROOT: "" },
				{ writeIdentity: false },
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			assert.equal(
				existsSync(join(workersDir, "worker-1", "heartbeat.json")),
				false,
				"heartbeat should not be written without a validated worker identity",
			);
			assert.equal(
				existsSync(join(workersDir, "worker-1", "worker-idle-notify.json")),
				false,
				"idle notify state should not be written without a validated worker identity",
			);
			assert.equal(
				existsSync(join(teamDir, "all-workers-idle.json")),
				false,
				"all-idle state should not be written without a validated worker identity",
			);
			assert.equal(
				existsSync(join(teamDir, "events", "events.ndjson")),
				false,
				"worker idle events should not be emitted without a validated worker identity",
			);
			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/send-keys/,
					"missing identity must not inject leader notifications",
				);
			}
		});
	});

	it("fires notification on working->done transition", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "done-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "done-sess:0",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "done",
				current_task_id: "task-42",
				reason: "task complete",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			const eventsPath = join(teamDir, "events", "events.ndjson");
			assert.ok(
				existsSync(eventsPath),
				"events.ndjson should exist for done-state leader notification",
			);
			const events = (await readFile(eventsPath, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const event = events.find(
				(entry: {
					type?: string;
					reason?: string;
					worker?: string;
					to_worker?: string;
				}) =>
					entry.type === "leader_notification_deferred" &&
					entry.reason === "leader_pane_missing_no_injection" &&
					entry.worker === "worker-1" &&
					entry.to_worker === "leader-fixed",
			);
			assert.ok(
				event,
				"done transition should still notify the leader through the deferred path when no pane is available",
			);
			assert.equal(event.tmux_session, "done-sess:0");
			assert.equal(event.leader_pane_id, null);
			assert.equal(event.tmux_injection_attempted, false);
		});
	});

	it("does not inject worker-idle notification into a shell leader pane", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "shell-idle-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:21",
				leader_pane_id: "%79",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				current_task_id: "task-42",
				reason: "task complete",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{session_name}\t#{pane_id}\t#{pane_pid}" ]]; then
    printf 'session-test\t%s\t12345\n' "$target"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%79" ]]; then
    echo "zsh"
  fi
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
			await writeFile(fakeTmuxPath, fakeTmux);
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.match(
				tmuxLog,
				/display-message -p -t %79 #\{pane_current_command\}/,
			);
			assert.doesNotMatch(
				tmuxLog,
				/send-keys -t %79/,
				"should not inject worker-idle into a shell pane",
			);

			const eventsPath = join(teamDir, "events", "events.ndjson");
			const events = (await readFile(eventsPath, "utf-8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const deferred = events.find(
				(entry: { type?: string; reason?: string }) =>
					entry.type === "leader_notification_deferred" &&
					entry.reason === "leader_pane_shell_no_injection",
			);
			assert.ok(deferred, "should emit deferred shell-pane event");
			assert.equal(deferred.pane_current_command, "zsh");

			const cooldown = JSON.parse(
				await readFile(
					join(workersDir, "worker-1", "worker-idle-notify.json"),
					"utf-8",
				),
			);
			assert.equal(cooldown.delivery, "deferred_shell");
			assert.equal(cooldown.pane_current_command, "zsh");
		});
	});

	it("injects worker-idle notification even while the leader pane has an active task", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "busy-leader-worker-idle";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "busy-worker-idle:0",
				leader_pane_id: "%81",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				current_task_id: "task-42",
				reason: "task complete",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			const fakeTmux = `#!/usr/bin/env bash
set -eu
echo "$@" >> "${tmuxLogPath}"
cmd="$1"
shift || true
if [[ "$cmd" == "display-message" ]]; then
  target=""
  format=""
  while (($#)); do
    case "$1" in
      -p) shift ;;
      -t) target="$2"; shift 2 ;;
      *) format="$1"; shift ;;
    esac
  done
  if [[ "$format" == "#{pane_in_mode}" && "$target" == "%81" ]]; then
    echo "0"
    exit 0
  fi
  if [[ "$format" == "#{session_name}\t#{pane_id}\t#{pane_pid}" ]]; then
    printf 'session-test\t%s\t12345\n' "$target"
    exit 0
  fi
  if [[ "$format" == "#{pane_current_command}" && "$target" == "%81" ]]; then
    echo "codex"
    exit 0
  fi
  exit 0
fi
if [[ "$cmd" == "capture-pane" ]]; then
  printf "• Running tests (2m 10s • esc to interrupt)\\n"
  exit 0
fi
if [[ "$cmd" == "set-buffer" ]]; then
  printf '%s' "\${@: -1}" > "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "show-buffer" ]]; then
  if [[ -f "${tmuxLogPath}.buffer" ]]; then cat "${tmuxLogPath}.buffer"; fi
  exit 0
fi
if [[ "$cmd" == "paste-buffer" ]]; then
  target=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      -t) target="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [[ -f "${tmuxLogPath}.buffer" ]]; then
    echo "send-keys -t \${target} -l $(cat "${tmuxLogPath}.buffer")" >> "${tmuxLogPath}"
  fi
  exit 0
fi
if [[ "$cmd" == "delete-buffer" ]]; then
  rm -f "${tmuxLogPath}.buffer"
  exit 0
fi
if [[ "$cmd" == "send-keys" ]]; then
  exit 0
fi
if [[ "$cmd" == "list-panes" ]]; then
  echo "%1 12345"
  exit 0
fi
exit 0
`;
			await writeFile(fakeTmuxPath, fakeTmux);
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.match(
				tmuxLog,
				/capture-pane/,
				"busy-pane reminders should still inspect pane state",
			);
			assert.match(
				tmuxLog,
				/send-keys -t %81/,
				"worker-state transition reminder should still inject into a busy leader pane",
			);

			const eventsPath = join(teamDir, "events", "events.ndjson");
			if (existsSync(eventsPath)) {
				const events = (await readFile(eventsPath, "utf-8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line));
				const deferred = events.find(
					(entry: { type?: string; reason?: string }) =>
						entry.type === "leader_notification_deferred" &&
						entry.reason === "pane_has_active_task",
				);
				assert.equal(
					deferred,
					undefined,
					"busy leader panes must not suppress worker-state transition reminders",
				);
			}
		});
	});

	it("does not fire when worker was already idle (idle->idle)", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "no-transition";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%57",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Worker is idle
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});

			// Previous state was also idle
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "idle",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"should NOT fire for idle->idle",
				);
			}
		});
	});

	it("does not fire when worker is still working", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "still-working";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%58",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Worker is still working
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "working",
				updated_at: new Date().toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"should NOT fire when worker is not idle",
				);
			}
		});
	});

	it("respects per-worker cooldown", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "cooldown-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%59",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Worker is idle with working->idle transition
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			// Pre-populate cooldown state with a recent notification
			await writeJson(join(workersDir, "worker-1", "worker-idle-notify.json"), {
				last_notified_at_ms: Date.now() - 100, // 100ms ago
				last_notified_at: new Date().toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{
					OMX_TEAM_WORKER_IDLE_COOLDOWN_MS: "600000", // 10 minute cooldown
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"cooldown should block per-worker idle notification",
				);
			}
		});
	});

	it("can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=false", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "disabled-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%61",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Working->idle transition
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{
					OMX_TEAM_WORKER_IDLE_NOTIFY: "false",
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"should NOT fire when disabled",
				);
			}
		});
	});

	it("can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=0", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "disabled-zero";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{
					OMX_TEAM_WORKER_IDLE_NOTIFY: "0",
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"should NOT fire when disabled with 0",
				);
			}
		});
	});

	it("can be disabled via OMX_TEAM_WORKER_IDLE_NOTIFY=off", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "disabled-off";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{
					OMX_TEAM_WORKER_IDLE_NOTIFY: "off",
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"should NOT fire when disabled with off",
				);
			}
		});
	});

	it("writes worker_idle event to events.ndjson", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "event-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const eventsDir = join(teamDir, "events");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(eventsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%62",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				current_task_id: "task-99",
				reason: "finished",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);
			writeWorkerIdentityFixture(cwd, `${teamName}/worker-1`);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			const eventsPath = join(eventsDir, "events.ndjson");
			assert.ok(existsSync(eventsPath), "events.ndjson should exist");
			const content = await readFile(eventsPath, "utf-8");
			const events = content
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const workerIdleEvent = events.find(
				(e: { type: string; orchestration_intent?: string }) =>
					e.type === "worker_idle",
			);
			assert.ok(workerIdleEvent, "should have a worker_idle event");
			assert.equal(workerIdleEvent.team, teamName);
			assert.equal(workerIdleEvent.worker, "worker-1");
			assert.equal(workerIdleEvent.prev_state, "working");
			assert.equal(workerIdleEvent.task_id, "task-99");
			assert.equal(workerIdleEvent.reason, "finished");
			assert.equal(workerIdleEvent.orchestration_intent, "followup-reuse");
			assert.ok(workerIdleEvent.event_id, "event should have an event_id");
			assert.ok(workerIdleEvent.created_at, "event should have a created_at");

			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.doesNotMatch(tmuxLog, /\[OMX_INTENT:/);
		});
	});

	it("targets leader_pane_id when available", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "pane-team";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%55",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.match(
				tmuxLog,
				/-t %55/,
				"should target leader pane when available",
			);
			assert.doesNotMatch(
				tmuxLog,
				/-t devsess:0/,
				"should not target session when leader pane is available",
			);
		});
	});

	it("does not fire for leader (non-team-worker) context", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "leader-test";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%70",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			// Run as LEADER (no OMX_TEAM_WORKER env var)
			const payload = {
				cwd,
				type: "agent-turn-complete",
				"thread-id": "thread-leader",
				"turn-id": `turn-${Date.now()}`,
				"input-messages": ["leader turn"],
				"last-assistant-message": "done",
			};
			hardenTestAuthorityTreeSync(cwd);
			const result = spawnSync(
				process.execPath,
				[NOTIFY_HOOK_SCRIPT.pathname, JSON.stringify(payload)],
				{
					encoding: "utf8",
					env: {
						...process.env,
						...fixtureAuthorityEnv.get(cwd),
						PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
						OMX_TEAM_WORKER: "",
						TMUX: "",
						TMUX_PANE: "",
					},
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"leader context should not send per-worker idle notification",
				);
			}
		});
	});

	it("fires on first invocation when no prev state file exists (unknown->idle)", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "first-run";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%71",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Worker is idle, but NO prev-notify-state.json exists
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			assert.ok(
				existsSync(tmuxLogPath),
				"tmux should have been called for unknown->idle",
			);
			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.match(
				tmuxLog,
				/worker-1 idle/,
				"should fire on unknown->idle transition",
			);
			assert.match(
				tmuxLog,
				/Next: read worker-1's latest message\/output, then assign the next concrete step or mark the task complete/,
				"per-worker idle nudge should include a next action",
			);
		});
	});

	it("does not fire when worker status is stale", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "stale-status";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "heartbeat.json"), {
				pid: 123,
				last_turn_at: new Date().toISOString(),
				turn_count: 1,
				alive: true,
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			if (existsSync(tmuxLogPath)) {
				const tmuxLog = await readFile(tmuxLogPath, "utf-8");
				assert.doesNotMatch(
					tmuxLog,
					/worker-1 idle/,
					"stale status should suppress worker-idle notification",
				);
			}
		});
	});

	it("existing all-workers-idle hook still fires alongside per-worker", async () => {
		await withTempWorkingDir(async (cwd) => {
			const stateDir = join(
				cwd,
				".omx",
				"state",
				"sessions",
				"notify-worker-idle",
			);
			const logsDir = join(cwd, ".omx", "logs");
			const teamName = "both-hooks";
			const teamDir = join(stateDir, "team", teamName);
			const workersDir = join(teamDir, "workers");
			const fakeBinDir = join(cwd, "fake-bin");
			const fakeTmuxPath = join(fakeBinDir, "tmux");
			const tmuxLogPath = join(cwd, "tmux.log");

			await mkdir(logsDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });

			await writeJson(join(teamDir, "config.json"), {
				name: teamName,
				tmux_session: "devsess:0",
				leader_pane_id: "%63",
				workers: [
					{ name: "worker-1", index: 1, role: "executor", assigned_tasks: [] },
				],
			});

			// Single worker: working->idle transition should fire BOTH hooks
			await writeJson(join(workersDir, "worker-1", "status.json"), {
				state: "idle",
				updated_at: new Date().toISOString(),
			});
			await writeJson(join(workersDir, "worker-1", "prev-notify-state.json"), {
				state: "working",
				updated_at: new Date(Date.now() - 5000).toISOString(),
			});

			await writeFile(fakeTmuxPath, buildFakeTmux(tmuxLogPath));
			await chmod(fakeTmuxPath, 0o755);

			const result = runNotifyHookAsWorker(
				cwd,
				fakeBinDir,
				`${teamName}/worker-1`,
				{
					OMX_TEAM_ALL_IDLE_COOLDOWN_MS: "500", // re-enable all-idle
				},
			);
			assert.equal(
				result.status,
				0,
				`notify-hook failed: ${result.stderr || result.stdout}`,
			);

			assert.ok(existsSync(tmuxLogPath), "tmux should have been called");
			const tmuxLog = await readFile(tmuxLogPath, "utf-8");
			assert.match(tmuxLog, /worker-1 idle/, "per-worker idle should fire");
			assert.match(
				tmuxLog,
				/Next: read worker-1's latest message\/output, then assign the next concrete step or mark the task complete/,
				"per-worker idle nudge should include a next action",
			);
			assert.match(
				tmuxLog,
				/All 1 worker idle/,
				"all-workers-idle should also fire",
			);
			assert.match(
				tmuxLog,
				/Run `omx team status both-hooks` now, read unread worker messages, then assign the next concrete task, reconcile results, or shut the team down/,
				"all-workers-idle nudge should tell the agent to execute the runtime status check directly",
			);
			assert.doesNotMatch(
				tmuxLog,
				/Next: run omx team status both-hooks, read unread worker messages, then decide whether to assign the next concrete task, reconcile results, or shut the team down/,
				"all-workers-idle nudge should not fall back to human-advisory wording",
			);
		});
	});
});
