import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { VISUAL_NEXT_ACTIONS_LIMIT } from "../../visual/constants.js";
import {
	initializeStateAuthority,
	mintStateAuthorityTransportCapability,
	resolveStateAuthorityForGuard,
} from "../../state/authority.js";
import { buildStateAuthorityTransportEnv } from "../../state/transport-env.js";
import { hardenTestAuthorityTreeSync } from "../../team/__tests__/authority-fixture.js";
import { writeSessionStart } from "../session.js";

const fixtureAuthorityEnv = new Map<string, NodeJS.ProcessEnv>();

interface NotifyFixtureOptions {
	readonly nativeSessionId?: string;
}

async function initializeNotifyFixtureAuthority(
	cwd: string,
	sessionId: string,
	options: NotifyFixtureOptions = {},
): Promise<void> {
	await mkdir(join(cwd, ".omx"), { recursive: true, mode: 0o700 });
	await chmod(join(cwd, ".omx"), 0o700);
	const authority = await initializeStateAuthority({
		startup_cwd: cwd,
		observed_cwd: cwd,
		launch_id: `notify-session-scope-${sessionId}-${Date.now()}`,
		session_binding: { canonical_session_id: sessionId },
	});
	await chmod(authority.canonical_state_root, 0o700);
	await writeSessionStart(cwd, sessionId, {
		pid: process.pid,
		...(options.nativeSessionId
			? { nativeSessionId: options.nativeSessionId }
			: {}),
	});
	const refreshedAuthority = await resolveStateAuthorityForGuard({
		startup_cwd: cwd,
		observed_cwd: cwd,
		session_id: sessionId,
	});
	await mintStateAuthorityTransportCapability(refreshedAuthority);
	fixtureAuthorityEnv.set(
		cwd,
		buildStateAuthorityTransportEnv(refreshedAuthority, {
			...process.env,
			OMX_SESSION_ID: sessionId,
		}),
	);
}

function runNotifyHook(
	payload: Record<string, unknown>,
	env: NodeJS.ProcessEnv = {},
) {
	const testDir = dirname(fileURLToPath(import.meta.url));
	const repoRoot = join(testDir, "..", "..", "..");
	hardenTestAuthorityTreeSync(String(payload.cwd));
	return spawnSync(
		process.execPath,
		["dist/scripts/notify-hook.js", JSON.stringify(payload)],
		{
			cwd: repoRoot,
			encoding: "utf-8",
			env: {
				...process.env,
				...fixtureAuthorityEnv.get(String(payload.cwd)),
				OMX_TEAM_WORKER: "",
				TMUX: "",
				TMUX_PANE: "",
				...env,
			},
		},
	);
}

describe("notify-hook session-scoped iteration updates", () => {
	it("does not mutate root active mode state when current session scope exists only in session.json", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-root-fallback-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const sessionId = "sess-current";
			await initializeNotifyFixtureAuthority(wd, sessionId, {
				nativeSessionId: "th-root",
			});
			await mkdir(stateDir, { recursive: true });

			await writeFile(
				join(stateDir, "team-state.json"),
				JSON.stringify({
					active: true,
					iteration: 41,
					max_iterations: 100,
					current_phase: "executing",
				}),
			);

			const result = runNotifyHook({
				cwd: wd,
				type: "agent-turn-complete",
				thread_id: "th-root",
				turn_id: "tu-root",
				input_messages: [],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const rootState = JSON.parse(
				await readFile(join(stateDir, "team-state.json"), "utf-8"),
			);
			assert.equal(rootState.iteration, 41);
			assert.equal(rootState.last_turn_at, undefined);
			assert.equal(
				existsSync(join(stateDir, "sessions", sessionId, "team-state.json")),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("increments iteration for active session-scoped mode states", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-test-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const sessionId = "sess1";
			await initializeNotifyFixtureAuthority(wd, sessionId, {
				nativeSessionId: "th",
			});
			const sessionScopedDir = join(stateDir, "sessions", sessionId);
			await mkdir(sessionScopedDir, { recursive: true });

			await writeFile(
				join(sessionScopedDir, "team-state.json"),
				JSON.stringify({
					active: true,
					iteration: 0,
					owner_codex_session_id: "th",
				}),
			);

			const result = runNotifyHook({
				cwd: wd,
				type: "agent-turn-complete",
				thread_id: "th",
				turn_id: "tu",
				input_messages: ["continue"],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const updated = JSON.parse(
				await readFile(join(sessionScopedDir, "team-state.json"), "utf-8"),
			);
			assert.equal(updated.iteration, 1);
			assert.ok(
				typeof updated.last_turn_at === "string" &&
					updated.last_turn_at.length > 0,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("auto-expands active Ralph max_iterations by 10 when the run is still progressing", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-test-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const sessionId = "sess1";
			await initializeNotifyFixtureAuthority(wd, sessionId, {
				nativeSessionId: "th2",
			});
			const sessionScopedDir = join(stateDir, "sessions", sessionId);
			await mkdir(sessionScopedDir, { recursive: true });

			await writeFile(
				join(sessionScopedDir, "ralph-state.json"),
				JSON.stringify({
					active: true,
					iteration: 1,
					max_iterations: 2,
					current_phase: "executing",
				}),
			);

			const result = runNotifyHook({
				cwd: wd,
				type: "agent-turn-complete",
				thread_id: "th2",
				turn_id: "tu2",
				input_messages: [],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const updated = JSON.parse(
				await readFile(join(sessionScopedDir, "ralph-state.json"), "utf-8"),
			);
			assert.equal(updated.iteration, 2);
			assert.equal(updated.active, true);
			assert.equal(updated.current_phase, "executing");
			assert.equal(updated.max_iterations, 12);
			assert.equal(updated.stop_reason, undefined);
			assert.equal(updated.completed_at, undefined);
			assert.equal(updated.max_iterations_auto_expand_count, 1);
			assert.ok(
				typeof updated.max_iterations_auto_expanded_at === "string" &&
					updated.max_iterations_auto_expanded_at.length > 0,
			);
			assert.ok(
				typeof updated.last_turn_at === "string" &&
					updated.last_turn_at.length > 0,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("still marks non-Ralph modes complete when max_iterations is reached", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-test-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const sessionId = "sess1";
			await initializeNotifyFixtureAuthority(wd, sessionId, {
				nativeSessionId: "th2",
			});
			const sessionScopedDir = join(stateDir, "sessions", sessionId);
			await mkdir(sessionScopedDir, { recursive: true });

			await writeFile(
				join(sessionScopedDir, "team-state.json"),
				JSON.stringify({
					active: true,
					iteration: 1,
					max_iterations: 2,
					current_phase: "executing",
				}),
			);

			const result = runNotifyHook({
				cwd: wd,
				type: "agent-turn-complete",
				thread_id: "th2",
				turn_id: "tu2",
				input_messages: [],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const updated = JSON.parse(
				await readFile(join(sessionScopedDir, "team-state.json"), "utf-8"),
			);
			assert.equal(updated.iteration, 2);
			assert.equal(updated.active, false);
			assert.equal(updated.current_phase, "complete");
			assert.equal(updated.stop_reason, "max_iterations_reached");
			assert.ok(
				typeof updated.completed_at === "string" &&
					updated.completed_at.length > 0,
			);
			assert.ok(
				typeof updated.last_turn_at === "string" &&
					updated.last_turn_at.length > 0,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("writes hud progress timestamps for leader turns", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-hud-progress-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			await initializeNotifyFixtureAuthority(wd, "codex-progress");
			await mkdir(stateDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);

			const result = runNotifyHook({
				cwd: wd,
				session_id: "codex-progress",
				type: "agent-turn-complete",
				thread_id: "th-progress",
				turn_id: "tu-progress",
				input_messages: [],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const hudState = JSON.parse(
				await readFile(
					join(stateDir, "sessions", "codex-progress", "hud-state.json"),
					"utf-8",
				),
			) as Record<string, unknown>;
			assert.ok(
				typeof hudState.last_turn_at === "string" &&
					hudState.last_turn_at.length > 0,
			);
			assert.ok(
				typeof hudState.last_progress_at === "string" &&
					hudState.last_progress_at.length > 0,
			);
			assert.equal(hudState.last_progress_at, hudState.last_turn_at);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("prefers the canonical OMX session scope over a different native payload session id for notify sidefiles", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-canonical-session-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const canonicalSessionId = "omx-canonical-session";
			const nativeSessionId = "codex-native-session";
			const canonicalDir = join(stateDir, "sessions", canonicalSessionId);
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId, {
				nativeSessionId,
			});
			await mkdir(canonicalDir, { recursive: true });

			const result = runNotifyHook({
				cwd: wd,
				session_id: nativeSessionId,
				type: "agent-turn-complete",
				thread_id: "th-canonical",
				turn_id: "tu-canonical",
				input_messages: [],
				last_assistant_message: "ok",
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			assert.equal(existsSync(join(canonicalDir, "hud-state.json")), true);
			assert.equal(
				existsSync(join(canonicalDir, "notify-hook-state.json")),
				true,
			);
			assert.equal(
				existsSync(
					join(stateDir, "sessions", nativeSessionId, "hud-state.json"),
				),
				false,
			);
			assert.equal(
				existsSync(
					join(stateDir, "sessions", nativeSessionId, "notify-hook-state.json"),
				),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("does not let an invocation OMX session alias retarget notify sidefiles to a fork scope", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-fork-session-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const canonicalSessionId = "omx-canonical-session";
			const forkSessionId = "omx-fork-session";
			const nativeSessionId = "codex-native-session";
			const forkDir = join(stateDir, "sessions", forkSessionId);
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId, {
				nativeSessionId,
			});
			await mkdir(forkDir, { recursive: true });
			await writeFile(
				join(forkDir, "notify-hook-state.json"),
				JSON.stringify({
					session_id: forkSessionId,
					owner_codex_session_id: nativeSessionId,
					recent_turns: {},
				}),
			);

			hardenTestAuthorityTreeSync(wd);
			const result = spawnSync(
				process.execPath,
				[
					"dist/scripts/notify-hook.js",
					JSON.stringify({
						cwd: wd,
						session_id: nativeSessionId,
						type: "agent-turn-complete",
						thread_id: "th-fork",
						turn_id: "tu-fork",
						input_messages: ["$ralph continue"],
						last_assistant_message: "ok",
					}),
				],
				{
					cwd: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
					encoding: "utf-8",
					env: {
						...process.env,
						...fixtureAuthorityEnv.get(wd),
						OMX_SESSION_ID: forkSessionId,
						OMX_TEAM_WORKER: "",
						TMUX: "",
						TMUX_PANE: "",
					},
				},
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			assert.equal(existsSync(join(forkDir, "hud-state.json")), false);
			assert.equal(existsSync(join(forkDir, "skill-active-state.json")), false);
			assert.equal(existsSync(join(forkDir, "ralph-state.json")), false);
			assert.equal(
				existsSync(
					join(stateDir, "sessions", canonicalSessionId, "hud-state.json"),
				),
				false,
			);
			assert.equal(
				existsSync(
					join(
						stateDir,
						"sessions",
						canonicalSessionId,
						"notify-hook-state.json",
					),
				),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects a foreign-owned notify fork before receipts, activation, or Ralph mutation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-fork-owner-conflict-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const canonicalSessionId = "omx-canonical-owner";
			const payloadSessionId = "codex-payload-owner";
			const forkSessionId = "omx-existing-fork";
			const forkDir = join(stateDir, "sessions", forkSessionId);
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId, {
				nativeSessionId: payloadSessionId,
			});
			await mkdir(forkDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);
			const ralphPath = join(forkDir, "ralph-state.json");
			const originalRalph = JSON.stringify(
				{
					mode: "ralph",
					session_id: forkSessionId,
					owner_codex_session_id: payloadSessionId,
					active: true,
					iteration: 7,
					current_phase: "executing",
					active_skills: [
						{
							skill: "ralph",
							session_id: forkSessionId,
							owner_codex_session_id: "foreign-codex-owner",
						},
					],
				},
				null,
				2,
			);
			await writeFile(ralphPath, originalRalph);

			const result = runNotifyHook(
				{
					cwd: wd,
					session_id: payloadSessionId,
					type: "agent-turn-complete",
					thread_id: "th-owner-conflict",
					turn_id: "tu-owner-conflict",
					input_messages: ["$ralph continue"],
					last_assistant_message: "ok",
				},
				{ OMX_SESSION_ID: forkSessionId },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			assert.equal(await readFile(ralphPath, "utf8"), originalRalph);
			assert.equal(existsSync(join(forkDir, "notify-hook-state.json")), false);
			assert.equal(existsSync(join(forkDir, "hud-state.json")), false);
			assert.equal(existsSync(join(forkDir, "skill-active-state.json")), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects malformed notify target state before receipts or overwrite", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-malformed-target-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const forkId = "malformed-fork";
			const forkDir = join(stateDir, "sessions", forkId);
			await initializeNotifyFixtureAuthority(wd, "canonical", {
				nativeSessionId: "payload-owner",
			});
			await mkdir(forkDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);
			const malformedPath = join(forkDir, "ralph-state.json");
			await writeFile(malformedPath, "{ malformed");
			const result = runNotifyHook(
				{
					cwd: wd,
					session_id: "payload-owner",
					type: "agent-turn-complete",
					turn_id: "malformed-turn",
					input_messages: [],
				},
				{ OMX_SESSION_ID: forkId },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(await readFile(malformedPath, "utf8"), "{ malformed");
			assert.equal(existsSync(join(forkDir, "notify-hook-state.json")), false);
			assert.equal(existsSync(join(forkDir, "hud-state.json")), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("persists visual-verdict feedback from runtime assistant output", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-visual-"));
		try {
			await initializeNotifyFixtureAuthority(wd, "sessVisual");
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);
			const sessionId = "sessVisual";
			const result = runNotifyHook({
				cwd: wd,
				session_id: sessionId,
				type: "agent-turn-complete",
				thread_id: "th-visual",
				turn_id: "tu-visual",
				input_messages: [],
				last_assistant_message: [
					"Visual verdict ready:",
					"```json",
					JSON.stringify(
						{
							score: 84,
							verdict: "revise",
							category_match: true,
							differences: [
								"Primary CTA is 3px too low",
								"Card corner radius is too round",
							],
							suggestions: [
								"Move primary CTA up by 3px",
								"Set card border-radius to 8px",
							],
							reasoning:
								"Core layout is close, but CTA alignment and shape still differ.",
						},
						null,
						2,
					),
					"```",
				].join("\n"),
			});
			assert.equal(result.status, 0, result.stderr || result.stdout);

			const progressPath = join(
				wd,
				".omx",
				"state",
				"sessions",
				sessionId,
				"ralph-progress.json",
			);
			assert.equal(existsSync(progressPath), true);
			const progress = JSON.parse(await readFile(progressPath, "utf-8")) as {
				visual_feedback?: Array<{
					score: number;
					verdict: string;
					qualitative_feedback?: { next_actions?: string[] };
				}>;
			};

			assert.equal(Array.isArray(progress.visual_feedback), true);
			assert.equal(progress.visual_feedback?.length, 1);
			assert.equal(progress.visual_feedback?.[0]?.score, 84);
			assert.equal(progress.visual_feedback?.[0]?.verdict, "revise");
			assert.equal(
				(progress.visual_feedback?.[0]?.qualitative_feedback?.next_actions
					?.length || 0) <= VISUAL_NEXT_ACTIONS_LIMIT,
				true,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("suppresses managed unmatched owner sidefiles without creating either an owner or canonical receipt scope", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-managed-unmatched-"));
		const home = join(wd, "home");
		const fakeBinDir = join(wd, "bin");
		const canonicalSessionId = "omx-canonical";
		const ownerSessionId = "omx-unmatched-owner";
		try {
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId);
			const stateDir = join(wd, ".omx", "state");
			const canonicalDir = join(stateDir, "sessions", canonicalSessionId);
			await mkdir(canonicalDir, { recursive: true });
			await mkdir(fakeBinDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);
			await writeFile(
				join(canonicalDir, "hud-state.json"),
				JSON.stringify({ turn_count: 7 }, null, 2),
			);
			const fakeTmux = join(fakeBinDir, "tmux");
			await writeFile(
				fakeTmux,
				`#!/usr/bin/env bash
set -eu
case "$*" in
  *"display-message -p -t %owner-pane #S") printf 'managed-session\\n' ;;
  *"show-option -qv -p -t %owner-pane @omx_pane_instance_id") printf '${ownerSessionId}\\n' ;;
  *) exit 0 ;;
esac
`,
			);
			await chmod(fakeTmux, 0o755);

			hardenTestAuthorityTreeSync(wd);
			const result = spawnSync(
				process.execPath,
				[
					"dist/scripts/notify-hook.js",
					JSON.stringify({
						cwd: wd,
						session_id: canonicalSessionId,
						type: "agent-turn-complete",
						thread_id: "th-managed-unmatched",
						turn_id: "tu-managed-unmatched",
						input_messages: [],
						last_assistant_message: "Waiting for user input.",
					}),
				],
				{
					cwd: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
					encoding: "utf-8",
					env: {
						...process.env,
						...fixtureAuthorityEnv.get(wd),
						HOME: home,
						CODEX_HOME: join(home, ".codex"),
						OMX_SESSION_ID: ownerSessionId,
						OMX_TEAM_WORKER: "",
						TMUX: "/tmp/tmux-1000/default,1,0",
						TMUX_PANE: "%owner-pane",
						PATH: `${fakeBinDir}:${process.env.PATH || ""}`,
					},
				},
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);

			assert.deepEqual(
				JSON.parse(
					await readFile(join(canonicalDir, "hud-state.json"), "utf-8"),
				),
				{ turn_count: 7 },
			);
			assert.equal(
				existsSync(join(canonicalDir, "notify-hook-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(canonicalDir, "idle-notif-cooldown.json")),
				false,
			);
			assert.equal(
				existsSync(join(canonicalDir, "session-idle-hook-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(canonicalDir, "lifecycle-notif-state.json")),
				false,
			);
			assert.equal(
				existsSync(join(stateDir, "sessions", ownerSessionId)),
				false,
			);
			assert.equal(
				existsSync(join(home, ".omx", "state", "reply-session-registry.jsonl")),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects a missing notify fork without creating the requested target", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-missing-fork-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const canonicalSessionId = "omx-canonical";
			const payloadSessionId = "codex-owner";
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId, {
				nativeSessionId: payloadSessionId,
			});
			await mkdir(join(stateDir, "sessions", canonicalSessionId), {
				recursive: true,
			});
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);

			const result = runNotifyHook(
				{
					cwd: wd,
					session_id: payloadSessionId,
					type: "agent-turn-complete",
					input_messages: [],
					last_assistant_message: "ok",
				},
				{ OMX_SESSION_ID: "fork-missing" },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(
				existsSync(join(stateDir, "sessions", "fork-missing")),
				false,
			);
			assert.equal(
				existsSync(
					join(
						stateDir,
						"sessions",
						canonicalSessionId,
						"notify-hook-state.json",
					),
				),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects no-input leader turns before creating a session scope", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-no-input-reject-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			await initializeNotifyFixtureAuthority(wd, "no-input-session");
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);

			const result = runNotifyHook(
				{
					cwd: wd,
					type: "agent-turn-complete",
					input_messages: [],
					last_assistant_message: "ok",
				},
				{ OMX_SESSION_ID: "unbound-owner" },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.equal(
				existsSync(
					join(
						stateDir,
						"sessions",
						"no-input-session",
						"notify-hook-state.json",
					),
				),
				false,
			);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});

	it("rejects malformed owner environment before foreign state mutation", async () => {
		const wd = await mkdtemp(join(tmpdir(), "omx-notify-malformed-owner-"));
		try {
			const stateDir = join(wd, ".omx", "state");
			const canonicalSessionId = "omx-canonical";
			const payloadSessionId = "codex-owner";
			const canonicalDir = join(stateDir, "sessions", canonicalSessionId);
			await initializeNotifyFixtureAuthority(wd, canonicalSessionId, {
				nativeSessionId: payloadSessionId,
			});
			await mkdir(canonicalDir, { recursive: true });
			await writeFile(
				join(wd, ".omx", "managed"),
				"test fixture managed workspace",
			);
			await writeFile(
				join(canonicalDir, "hud-state.json"),
				JSON.stringify({ turn_count: 7 }),
			);

			const result = runNotifyHook(
				{
					cwd: wd,
					session_id: payloadSessionId,
					type: "agent-turn-complete",
					input_messages: [],
					last_assistant_message: "ok",
				},
				{ OMX_SESSION_ID: "../malformed-owner" },
			);
			assert.equal(result.status, 0, result.stderr || result.stdout);
			assert.deepEqual(
				JSON.parse(
					await readFile(join(canonicalDir, "hud-state.json"), "utf-8"),
				),
				{ turn_count: 7 },
			);
			assert.equal(
				existsSync(join(stateDir, "sessions", "malformed-owner")),
				false,
			);
			const diagnostics = await readFile(
				join(
					wd,
					".omx",
					"logs",
					`omx-${new Date().toISOString().slice(0, 10)}.jsonl`,
				),
				"utf-8",
			).catch(() => "");
			assert.equal(diagnostics.includes("../malformed-owner"), false);
		} finally {
			await rm(wd, { recursive: true, force: true });
		}
	});
});
