import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";
import { createGameGoal, gameObjective, gameGoalProjection } from "../apps/desktop/game-goal.mjs";
import { extendProductionGoal, productionGoalSample } from "../apps/desktop/game-production-goal.mjs";
import { JournalProjector } from "../apps/desktop/journal-format.mjs";

const scope = { sessionId: "synthetic-game-session", planetId: 1, bridgeInstanceId: "synthetic-game-bridge", loaded: true, capturedAtGameTick: 1234 };
const check = count => ({ label: "合成制造次数", tool: "spherewright_get_status", args: {}, path: "/status/syntheticCommitCount", operator: "gte", value: count });
const plan = count => ({ stage: "准备合成材料", reason: "验证原生动作与目标记录", nextStep: "核对真实回执", completionChecks: [check(count)] });

test("the existing run journal retains goal waiting, verification and terminal phases", () => {
	const projector = new JournalProjector();
	for (const phase of ["waiting", "verifying", "goal_completed", "goal_blocked"]) {
		const result = projector.project({ type: "game-changed" }, { game: { currentTaskId: "synthetic-goal", phase, busy: true, runtimeAvailable: true, unresolved: [] } });
		assert.equal(result.facts.state, phase);
		assert.equal(result.task, "game-1");
	}
});

async function fixture(t, planner, mode = "normal") {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-goal-"));
	const authority = {}, approval = {};
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/game-mcp-server.mjs", import.meta.url)), mode], { windowsHide: true, stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
	const client = new ReadOnlyMcpClient(child, { researchAuthority: authority });
	await client.discover();
	let held = false;
	const bridge = { metadata: client.metadata, acquireGame(value) { assert.equal(value, authority); assert.equal(held, false); held = true; return { client, selection: { cohortHash: "a".repeat(64) }, generic: true }; }, releaseResearch() { held = false; } };
	const options = { directory, bridge, researchAuthority: authority, approvalAuthority: approval, freezeDevelopment: async () => {}, releaseDevelopment: async () => {}, planner, syntheticOnly: true };
	const host = new GameTasks(options);
	t.after(async () => {
		await host.drain(); host.close(); await client.close();
		const path = await realpath(directory);
		assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(path).startsWith("commanddeck-goal-"));
		await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	return { directory, host, client, approval, options, start: extra => host.start({ kind: "mcp", mode: "assist", providerId: "commanddeck-fixture", modelId: "fixture", prompt: "完成合成原生任务", objective: { kind: "evidence" }, ...extra }) };
}

async function until(predicate) {
	const end = performance.now() + 7000;
	while (!predicate()) {
		assert.ok(performance.now() < end, "GOAL_TEST_TIMEOUT");
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}
async function approve(f) {
	await until(() => f.host.snapshot().mcp.awaitingConfirmation);
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1);
}
async function craft(invoke) {
	const args = { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 };
	const preview = await invoke("spherewright_prepare_handcraft", args);
	return invoke("spherewright_commit_handcraft", { sessionId: scope.sessionId, planetId: 1, planToken: preview.result.planToken, idempotencyKey: "model-key" });
}

test("goal objective rejects invalid rates, unknown fields and forged completion", () => {
	assert.deepEqual(gameObjective({ kind: "evidence" }), { kind: "evidence" });
	for (const value of [{ kind: "evidence", completed: true }, { kind: "production", itemId: 6001, minimumPerMinute: 0, windowSeconds: 60 }, { kind: "production", itemId: 6001, minimumPerMinute: 60, windowSeconds: 9 }]) assert.throws(() => gameObjective(value), /INVALID_GAME_OBJECTIVE/);
});

test("a goal executes through the same stdio gateway and waits for its original action without a model poll", async t => {
	let waiting;
	const f = await fixture(t, async ({ invoke, goalTools }) => {
		assert.equal(goalTools.length, 5);
		await invoke("deck_goal_plan", plan(1));
		const receipt = await craft(invoke);
		assert.equal(f.host.snapshot().goal.behavior.actionId, receipt.result.actionId);
		assert.equal(f.host.snapshot().goal.behavior.state, "executing");
		waiting = invoke("deck_goal_wait", { reason: "等待原制造动作", timeoutSeconds: 5 });
		await until(() => f.host.snapshot().goal.status === "waiting");
		assert.equal(f.host.snapshot().goal.wait.reason, "等待原制造动作");
		const outcome = await waiting;
		assert.equal(outcome.satisfied, true);
		assert.equal(outcome.originalActions[0].actionId, receipt.result.actionId);
		assert.equal(outcome.originalActions[0].state, "completed");
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	}, "goal");
	f.start(); await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "completed");
	assert.equal(f.host.snapshot().goal.usage.writes, 1);
	assert.equal(f.host.snapshot().phase, "goal_completed");
	assert.equal(f.host.ledger.children(f.host.currentTaskId).length, 1);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("a wait returns missing-field evidence immediately so the agent can correct its condition", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const result = await invoke("deck_goal_wait", { reason: "检查观察路径", timeoutSeconds: 120, condition: { ...check(1), path: "/missing" } });
		assert.equal(result.satisfied, false);
		assert.equal(result.timedOut, false);
		assert.equal(result.reason, "GAME_GOAL_WAIT_FIELD_UNAVAILABLE");
		assert.ok(result.goal.observations.at(-1).availableFields.includes("status"));
		assert.equal(result.goal.status, "running");
	});
	f.start(); await f.host.settled();
});

test("one autonomous action tool prepares, commits and returns its sole original terminal", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		await assert.rejects(invoke("deck_goal_execute_action", { prepareTool: "spherewright_prepare_new_game", args: { galaxySeed: 42, starCount: 32 } }), /AUTONOMOUS_GAME_ACTION_REQUIRED/);
		const result = await invoke("deck_goal_execute_action", { prepareTool: "spherewright_prepare_handcraft", args: { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 } });
		assert.equal(result.success, true);
		assert.equal(result.result.terminal, true);
		assert.equal(result.result.succeeded, true);
		assert.equal(result.result.stillPending, false);
		assert.equal(f.host.snapshot().unresolved.length, 0);
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	}, "goal");
	f.start({ mode: "autonomous", allowedFamilies: ["handcraft"], limits: { modelRequests: 4, toolCalls: 20, writes: 1, durationMs: 10000 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.ledger.children(f.host.currentTaskId).length, 1);
	assert.equal(f.host.snapshot().goal.usage.writes, 1);
});

test("autonomous action execution preserves a native unknown original without a replay", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await assert.rejects(invoke("deck_goal_execute_action", { prepareTool: "spherewright_prepare_handcraft", args: { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 } }), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
	}, "unknown");
	f.start({ mode: "autonomous", allowedFamilies: ["handcraft"], limits: { modelRequests: 4, toolCalls: 20, writes: 1, durationMs: 10000 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().unresolved.length, 1);
	assert.equal(f.host.snapshot().unresolved[0].state, "unknown");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("an autonomous action cannot commit when preparation consumes its remaining tool allowance", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await assert.rejects(invoke("deck_goal_execute_action", { prepareTool: "spherewright_prepare_handcraft", args: { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 } }), /GAME_GOAL_TOOL_LIMIT/);
	});
	f.start({ mode: "autonomous", allowedFamilies: ["handcraft"], limits: { modelRequests: 4, toolCalls: 2, writes: 1, durationMs: 10000 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("assisted goals keep ordinary actions behind their existing confirmations", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await assert.rejects(invoke("deck_goal_execute_action", { prepareTool: "spherewright_prepare_handcraft", args: { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 } }), /AUTONOMOUS_GAME_ACTION_REQUIRED/);
	});
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.usage.writes, 0);
	assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("native read conditions can be revised during observation", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await assert.rejects(invoke("deck_goal_plan", { ...plan(1), completionChecks: [{ ...check(1), tool: "spherewright_commit_handcraft" }] }), /GAME_GOAL_READ_CONDITION_REQUIRED/);
		await invoke("deck_goal_plan", plan(1));
		await invoke("deck_goal_plan", plan(2));
		assert.equal((await invoke("deck_goal_verify", {})).completed, false);
	});
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "blocked");
	assert.equal(f.host.snapshot().goal.completionChecks[0].value, 2);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("after execution, proposed conditions can be corrected with a retained revision", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		await invoke("deck_goal_plan", { ...plan(1), completionChecks: [{ ...check(1), path: "/status/missingField" }] });
		const missing = await invoke("deck_goal_verify", {});
		assert.equal(missing.completed, false);
		assert.ok(missing.goal.observations.at(-1).availableFields.includes("syntheticCommitCount"));
		await invoke("deck_goal_plan", { ...plan(1), completionChecks: [check(1), { ...check(1), label: "受管世界", path: "/status/gameLoaded", operator: "eq", value: true }] });
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	});
	f.start(); await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().goal.completionChecks.length, 2);
	assert.equal(f.host.snapshot().goal.checkRevision, 3);
	assert.ok(f.host.ledger.events(f.host.currentTaskId).some(event => event.previousChecks?.some(check => check.path === "/status/missingField")));
});

test("model string literals are compared using observed numeric and boolean types", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", { ...plan(1), completionChecks: [{ ...check(1), operator: "eq", value: "1" }, { ...check(1), label: "已加载", path: "/status/gameLoaded", operator: "eq", value: "true" }] });
		const receipt = await craft(invoke);
		await invoke("deck_goal_wait", { reason: "等待原终态", condition: { label: "原动作结束", tool: "spherewright_get_action_result", args: { actionId: receipt.result.actionId }, path: "/result/terminal", operator: "eq", value: "true" }, timeoutSeconds: 1 });
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	});
	f.start(); await approve(f); await f.host.settled();
	const observation = f.host.snapshot().goal.observations.find(value => value.label === "合成制造次数");
	assert.equal(observation.requested, "1");
	assert.equal(observation.expected, 1);
	assert.equal(observation.actual, 1);
});

test("early conversational stops continue finitely and repeated lack of progress remains incomplete", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		let rounds = 0, next;
		do { next = await invoke("deck_goal_next_decision", {}); rounds++; } while (next.continue);
		assert.equal(rounds, 4);
	});
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "blocked");
	assert.equal(f.host.snapshot().goal.problem, "GAME_GOAL_NO_PROGRESS");
	await f.host.drain();
	assert.equal(f.host.snapshot().goal.status, "blocked");
	assert.equal(f.host.snapshot().goal.problem, "GAME_GOAL_NO_PROGRESS");
});

test("pause aborts condition waiting promptly and reopening restores goal display with zero model replay", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		await invoke("deck_goal_wait", { reason: "等待合成计数", condition: check(1), timeoutSeconds: 120 });
	});
	f.start(); await until(() => f.host.snapshot().goal?.status === "waiting");
	const id = f.host.currentTaskId;
	f.host.stop(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "paused");
	const original = f.host.ledger.detailsFor(id).goal;
	await f.host.drain(); f.host.close();
	let models = 0;
	const reopened = new GameTasks({ ...f.options, planner: async () => { models++; } });
	try {
		assert.equal(reopened.currentTaskId, id);
		assert.equal(reopened.snapshot().goal.status, "paused");
		assert.deepEqual(reopened.ledger.detailsFor(id).goal, original);
		assert.equal(models, 0);
	} finally { await reopened.drain(); reopened.close(); }
});

test("continuing with another model retains goal identity, revision and cumulative request budget", async t => {
	let run = 0;
	const f = await fixture(t, async ({ invoke, event, modelId }) => {
		run++;
		if (run === 1) {
			await invoke("deck_goal_plan", plan(1));
			event("usage", { version: 1, requests: 2, responses: 2, reportedResponses: 0, tokens: null, pricing: null });
			f.host.stop(); return;
		}
		assert.equal(modelId, "next-model");
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	});
	f.start({ limits: { modelRequests: 5, toolCalls: 100, writes: 2, durationMs: 30000 } }); await f.host.settled();
	const priorId = f.host.currentTaskId, prior = f.host.snapshot().goal;
	assert.equal(prior.usage.modelRequests, 2);
	assert.throws(() => f.start({ continueTaskId: priorId, limits: { modelRequests: 4, toolCalls: 90, writes: 2, durationMs: 10000 } }), /GAME_GOAL_REMAINING_BUDGET_REQUIRED/);
	f.start({ continueTaskId: priorId, modelId: "next-model", limits: { modelRequests: 3, toolCalls: 90, writes: 2, durationMs: 10000 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().goal.id, prior.id);
	assert.equal(f.host.snapshot().goal.revision, 2);
	assert.equal(f.host.snapshot().goal.usage.modelRequests, 2);
	assert.equal(f.host.snapshot().goal.usage.writes, 1);
});

test("production goal requires its unchanged native checks and enough continuous native windows", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		assert.equal((await invoke("deck_goal_verify", {})).completed, false);
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		let result;
		for (let index = 0; index < 3; index++) result = await invoke("deck_goal_verify", {});
		assert.equal(result.completed, true);
	});
	f.start({ objective: { kind: "production", itemId: 6001, minimumPerMinute: 60, windowSeconds: 30 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "completed");
	assert.equal(f.host.snapshot().goal.verification.minimumRate, 60);
	assert.ok(f.host.snapshot().goal.verification.seconds >= 30);
});

test("production waiting monitors the game window without spending model requests", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		const result = await invoke("deck_goal_wait", { reason: "等待连续产量窗口", timeoutSeconds: 5 });
		assert.equal(result.satisfied, true);
		assert.ok(result.goal.verification.seconds >= 20);
		assert.equal(result.goal.usage.modelRequests, 0);
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	});
	f.start({ objective: { kind: "production", itemId: 6001, minimumPerMinute: 60, windowSeconds: 20 } });
	await approve(f); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "completed");
});

test("storage failure on goal persistence freezes the existing host before any native commit", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		f.host.ledger.db.exec("PRAGMA query_only=ON");
		await invoke("deck_goal_plan", plan(1));
	});
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().storageAvailable, false);
	assert.equal(f.host.snapshot().developmentFrozen, true);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
	f.host.ledger.db.exec("PRAGMA query_only=OFF");
});

test("an authoritative read refusal reaches the agent so it can continue other safe goal work", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const refusal = await invoke("spherewright_get_recipe_catalog", {});
		assert.equal(refusal.success, false);
		assert.equal(refusal.error.code, "RECIPE_LOCKED");
		await invoke("deck_goal_plan", plan(0));
		assert.equal((await invoke("deck_goal_verify", {})).completed, true);
	}, "refused-read");
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().error, null);
	assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal(f.host.snapshot().goal.usage.writes, 0);
});

test("known native refusal reaches the model and repeated identical attempts block without a commit", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		for (let index = 0; index < 3; index++) {
			const reply = await invoke("spherewright_prepare_handcraft", { sessionId: scope.sessionId, planetId: 1, recipeId: 10, count: 2 });
			assert.equal(reply.success, false);
			assert.deepEqual(reply.result.commitBlockers, ["Synthetic material shortage"]);
		}
		await assert.rejects(invoke("spherewright_get_status", {}), /GAME_GOAL_NOT_RUNNING/);
	}, "refused");
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.problem, "GAME_GOAL_REPEATED_FAILURE");
	assert.equal(f.host.snapshot().goal.status, "blocked");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("unknown original action retains the parent goal and blocks continuation after a host restart", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
	}, "unknown");
	f.start(); await approve(f); await f.host.settled();
	const id = f.host.currentTaskId, original = f.host.ledger.unresolved()[0];
	await f.host.drain(); f.host.close();
	const reopened = new GameTasks(f.options);
	try {
		assert.equal(reopened.currentTaskId, id);
		assert.equal(reopened.snapshot().goal.behavior.actionId, original.actionId);
		assert.equal(reopened.snapshot().goal.status, "blocked");
		assert.deepEqual(reopened.ledger.unresolved()[0], original);
		assert.throws(() => reopened.start({ kind: "mcp" }), /GAME_TASK_START_BLOCKED/);
	} finally { await reopened.drain(); reopened.close(); }
});

test("condition timeout returns a finite result and changing stage tools cannot expand native authority", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		await assert.rejects(invoke("deck_goal_plan", { ...plan(1), activeTools: ["spherewright_commit_save_import"] }), /GAME_GOAL_TOOL_SCOPE_REJECTED/);
		const result = await invoke("deck_goal_wait", { reason: "等待尚未到达的合成材料", condition: check(1), timeoutSeconds: 1 });
		assert.equal(result.timedOut, true);
		assert.equal(result.satisfied, false);
		assert.equal(result.goal.status, "running");
		assert.equal((await invoke("deck_goal_verify", {})).completed, false);
	});
	f.start(); await f.host.settled();
	assert.equal(f.host.snapshot().goal.status, "blocked");
});

test("coordination and native calls share the same remaining tool budget", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		await invoke("spherewright_get_status", {});
		await invoke("deck_goal_guidance_access", {});
		await assert.rejects(invoke("spherewright_get_status", {}), /GAME_GOAL_TOOL_LIMIT/);
	});
	f.start({ limits: { toolCalls: 3 } }); await f.host.settled();
	assert.equal(f.host.snapshot().goal.usage.toolCalls, 3);
	assert.equal(f.host.snapshot().goal.usage.writes, 0);
});

test("a reconstructed running goal is displayed as paused and unknown receipts take precedence over model text", () => {
	const goal = createGameGoal("Test goal", { kind: "evidence" }, scope, Date.now());
	assert.equal(gameGoalProjection(goal, []).status, "paused");
	const view = gameGoalProjection(goal, [{ id: "native-task", scope: { actionKind: "handcraft" }, intent: { state: "unknown", actionId: "original" } }]);
	assert.equal(view.status, "blocked");
	assert.equal(view.behavior.actionId, "original");
	assert.equal(view.behavior.state, "reconciling");
});

test("a completed goal survives normal close and host reconstruction after its child actions", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await invoke("deck_goal_plan", plan(1));
		const receipt = await craft(invoke);
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		await invoke("deck_goal_verify", {});
	});
	f.start(); await approve(f); await f.host.settled();
	const id = f.host.currentTaskId, goal = f.host.ledger.detailsFor(id).goal;
	assert.equal(f.host.ledger.task(id).state, "completed");
	await f.host.drain(); f.host.close();
	const reopened = new GameTasks(f.options);
	try {
		assert.equal(reopened.currentTaskId, id);
		assert.equal(reopened.snapshot().goal.status, "completed");
		assert.equal(reopened.ledger.task(id).state, "completed");
		assert.deepEqual(reopened.ledger.detailsFor(id).goal, goal);
		assert.equal(reopened.ledger.children(id).length, 1);
	} finally { await reopened.drain(); reopened.close(); }
});

test("production coverage rejects overlaps as extra time, gaps, low rates, stale windows and scope changes", () => {
	const objective = { kind: "production", itemId: 6001, minimumPerMinute: 60, windowSeconds: 30 };
	const sample = (startTick, endTick, rate = 60) => ({ startTick, endTick, rate });
	let value = extendProductionGoal(null, sample(1, 600), objective, 0, 1);
	value = extendProductionGoal(value, sample(1, 600), objective, 0, 2);
	assert.equal(value.seconds, 10); assert.equal(value.samples, 1);
	value = extendProductionGoal(value, sample(301, 900), objective, 0, 3);
	assert.equal(value.seconds, 15);
	value = extendProductionGoal(value, sample(1001, 1600), objective, 0, 4);
	assert.equal(value.seconds, 10);
	value = extendProductionGoal(value, sample(1601, 2200, 30), objective, 0, 5);
	assert.equal(value.seconds, 0);
	assert.equal(extendProductionGoal(value, null, objective, 0, 6).state, "unavailable");
	assert.throws(() => productionGoalSample({ sessionId: "other", requestedItemIds: [6001], planets: [] }, scope, objective), /GAME_GOAL_PRODUCTION_SCOPE_CHANGED/);
});
