import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { spherewrightCatalog, validSpherewrightArguments, publicGameValue } from "../apps/desktop/spherewright-tool-catalog.mjs";
import { readMcpAction } from "../apps/desktop/spherewright-game-session.mjs";
import { GameRecoveryVault } from "../apps/desktop/game-recovery-vault.mjs";

test("a stopped original route requires a fresh healthy owned context before failure reconciliation", async () => {
	const request = { bridgeInstanceId: "bridge", sessionId: "session", planetId: 1, actionId: "action", actionKind: "harvest", idempotencyKey: "key" };
	const terminal = { ...request, state: "action_failed", terminal: true, succeeded: false, recoveryRequired: false, failureKind: "position_stalled", stalled: true, doNotRetrySameTarget: true, startedAtGameTick: 10, completedAtGameTick: 20, afterStateHash: "sha256:" + "a".repeat(64) };
	let health = "healthy";
	const port = { async call(name) {
		if (name === "spherewright_get_status") return { success: true, status: { bridgeConnected: true, protocolVersion: 1, bridgeInstanceId: "bridge", writesConfigured: true, writeHealth: health } };
		if (name === "spherewright_get_action_result") return { success: true, result: terminal };
		return { success: true, result: { bridgeConnected: true, gameLoaded: true, ownedBySpherewright: true, accessRestricted: false, sessionId: "session", localPlanetId: 1, gameTick: 21, writesAllowed: true, writeHealth: health, peacefulMode: "confirmed_peaceful", writeBlockers: [] } };
	} };
	const result = await readMcpAction(port, request);
	assert.deepEqual(result.terminal, terminal);
	assert.equal(result.context.writeHealth, "healthy");
	health = "quarantined";
	await assert.rejects(readMcpAction(port, request), /HEALTHY_GAME_WRITES_REQUIRED/);
});

test("energy-starved harvest reads fresh player evidence only for an explicit audit", async () => {
	const request = { bridgeInstanceId: "bridge", sessionId: "session", planetId: 1, actionId: "action", actionKind: "harvest", idempotencyKey: "key" };
	const terminal = { ...request, state: "action_failed", terminal: true, succeeded: false, recoveryRequired: false,
		failureKind: null, stalled: false, doNotRetrySameTarget: false, startedAtGameTick: 10, completedAtGameTick: 20,
		beforeStateHash: "sha256:" + "b".repeat(64), afterStateHash: "sha256:" + "a".repeat(64), targetObjectId: 42,
		requestedCount: 12, itemDeltas: [{ itemId: 9001, beforeCount: 7, afterCount: 10, delta: 3 }],
		message: "The normal mining order stopped after the mecha had no core energy, reactor energy, current reactor item, or usable fuel for 600 game ticks." };
	const calls = [];
	const port = { async call(name) {
		calls.push(name);
		if (name === "spherewright_get_status") return { success: true, status: { bridgeConnected: true, protocolVersion: 1, bridgeInstanceId: "bridge", writesConfigured: true, writeHealth: "healthy" } };
		if (name === "spherewright_get_action_result") return { success: true, result: terminal };
		if (name === "spherewright_get_player_state") return { success: true, result: { sessionId: "session", planetId: 1, capturedAtGameTick: 21 } };
		return { success: true, result: { bridgeConnected: true, gameLoaded: true, ownedBySpherewright: true, accessRestricted: false, sessionId: "session", localPlanetId: 1, gameTick: 21, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [] } };
	} };
	const ordinary = await readMcpAction(port, request);
	assert.equal(ordinary.context, null);
	assert.ok(!calls.includes("spherewright_get_player_state"));
	calls.length = 0;
	const audit = await readMcpAction(port, { ...request, energyAudit: true });
	assert.equal(audit.player.capturedAtGameTick, 21);
	assert.equal(audit.context.writeHealth, "healthy");
	assert.equal(calls.filter(name => name === "spherewright_get_player_state").length, 1);
});

async function fixture(t, planner, mode = "normal") {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-unified-game-")), authority = {}, approval = {};
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/game-mcp-server.mjs", import.meta.url)), mode], { windowsHide: true, stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
	const client = new ReadOnlyMcpClient(child, { researchAuthority: authority }); await client.discover();
	let held = false, frozen = 0;
	const bridge = { metadata: client.metadata, acquireGame(value) { assert.equal(value, authority); assert.equal(held, false); held = true; return { client, selection: { cohortHash: "a".repeat(64) }, generic: true }; }, releaseResearch() { held = false; } };
	const closed = [], window = { sourceId: "window:12345:0", windowBinding: "a".repeat(32), gamePid: 12, gameStartedTicks: "638900000000000000", kind: "dsp", targetId: "synthetic" };
	const protection = { available: () => true, encrypt: async text => Buffer.from(text).map(value => value ^ 0x5a), decrypt: async bytes => Buffer.from(bytes).map(value => value ^ 0x5a).toString() };
	const recoveryVault = new GameRecoveryVault(join(directory, "recovery.vault.json"), protection);
	if (mode.startsWith("recovery")) await recoveryVault.save({ token: "PRIVATE_SYNTHETIC_TOKEN", sourceSessionId: "prior-world", gameVersion: "1.2.3", planetId: 1, savedTick: 1234, cohortHash: "a".repeat(64), schemaHash: client.metadata.schemaHash });
	const host = new GameTasks({ directory, bridge, researchAuthority: authority, approvalAuthority: approval, freezeDevelopment: async () => { frozen++; }, releaseDevelopment: async () => { frozen--; }, planner, syntheticOnly: true, captureExitWindow: async () => ({ ...window }), closeExitWindow: async value => { closed.push(value); }, recoveryVault });
	await host.initialize();
	t.after(async () => { await host.drain(); host.close(); await client.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-unified-game-")); await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	const start = extra => host.start({ kind: "mcp", mode: "assist", providerId: "commanddeck-fixture", modelId: "fixture", prompt: "Synthetic finite native task", ...extra });
	return { directory, client, host, authority, approval, start, closed, window, recoveryVault, frozen: () => frozen };
}
async function waitFor(predicate) { const end = performance.now() + 5000; while (!predicate()) { assert.ok(performance.now() < end, "SYNTHETIC_STAGE_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function approve(f) { await waitFor(() => f.host.snapshot().mcp.awaitingConfirmation); const challenge = f.host.confirmation(f.host.currentTaskId, 1); assert.equal(challenge.kind, "mcp"); assert.ok(!JSON.stringify(challenge).includes("PRIVATE_")); f.host.confirm(f.approval, challenge.nonce, 1); }

test("explicit host exit saves and verifies the original menu action before closing its window", async t => {
	const f = await fixture(t, async () => {}, "exit");
	assert.equal(f.client.metadata.gameExitAvailable, true);
	assert.ok(!f.client.gamePort(f.authority).tools().some(tool => tool.name.includes("return_to_main_menu")));
	assert.throws(() => f.client.gameExitPort({}), /TRUSTED_GAME_EXIT_CAPABILITY_REQUIRED/);
	f.host.prepareExit(); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "awaiting_approval");
	const challenge = f.host.confirmation(f.host.currentTaskId, 1); assert.equal(challenge.kind, "game-exit");
	assert.throws(() => f.host.confirm({}, challenge.nonce, 1), /TRUSTED_USER_APPROVAL_REQUIRED/);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.closed.length, 1);
	assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal(f.host.snapshot().recovery.state, "ready"); assert.equal((await f.recoveryVault.peek(f.host.snapshot().recovery.id)).savedTick, 1234);
	assert.ok(!JSON.stringify(f.host.snapshot()).includes("PRIVATE_SYNTHETIC_TOKEN"));
	const actions = f.host.ledger.tasks().filter(task => task.scope.actionKind === "return-to-main-menu");
	assert.equal(actions.length, 1); assert.equal(actions[0].intent.terminal.mainMenuReturnReadback.completeSaveVerified, true);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("a saved exit can be restored once in a separately attached game without restarting the old task", async t => {
	const f = await fixture(t, async () => { throw new Error("MODEL_MUST_NOT_START"); }, "exit-recovery");
	const previous = f.host.ledger.createMcpTask({ kind: "mcp-session", bridgeInstanceId: "synthetic-game-bridge", sessionId: "synthetic-game-session" });
	f.host.ledger.details(previous.id, { mode: "assist", prompt: "Original task remains visible" }); f.host.currentTaskId = previous.id;
	f.host.prepareExit(); await f.host.settled(); let challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().recovery.state, "ready"); assert.equal(f.closed.length, 1); assert.equal(f.host.snapshot().currentTaskId, previous.id);
	Object.assign(f.window, { sourceId: "window:54321:0", windowBinding: "b".repeat(32), gamePid: 13, gameStartedTicks: "638900000000000001", targetId: "new-game-window" });
	f.host.prepareRecovery(); await f.host.settled(); challenge = f.host.confirmation(f.host.currentTaskId, 2);
	f.host.confirm(f.approval, challenge.nonce, 2); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.host.snapshot().recovery.state, "used"); assert.equal(f.host.snapshot().currentTaskId, previous.id);
	assert.equal(f.host.ledger.detailsFor(previous.id).prompt, "Original task remains visible");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 2);
	assert.equal(f.closed.length, 1); assert.ok(!JSON.stringify(f.host.snapshot()).includes("PRIVATE_SYNTHETIC_TOKEN"));
});

test("an unproved menu result remains quarantined and never closes the window", async t => {
	const f = await fixture(t, async () => {}, "exit-bad-proof");
	f.host.prepareExit(); await f.host.settled();
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.closed.length, 0); assert.equal(f.host.snapshot().unresolved.length, 1);
});

test("cancelling a prepared exit performs no native commit and preserves the window", async t => {
	const f = await fixture(t, async () => {}, "exit");
	f.host.prepareExit(); await f.host.settled();
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.stop(); await f.host.settled();
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.equal(f.closed.length, 0); assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("a lost exit receipt freezes the original intent without closing or replay", async t => {
	const f = await fixture(t, async () => {}, "exit-lost-ack");
	f.host.prepareExit(); await f.host.settled();
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.closed.length, 0); assert.equal(f.host.snapshot().unresolved.length, 1);
	assert.equal(f.host.snapshot().unresolved[0].state, "unknown");
});

test("stopping an accepted exit preserves its original action and never closes the window", async t => {
	const f = await fixture(t, async () => {}, "exit-pending");
	f.host.prepareExit(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await waitFor(() => f.host.snapshot().phase === "accepted" || f.host.snapshot().phase === "reconciling");
	f.host.stop(); await f.host.settled();
	assert.equal(f.closed.length, 0); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
	assert.ok(f.host.ledger.tasks().some(task => task.scope.actionKind === "return-to-main-menu" && task.intent?.actionId));
});

test("exit waits through a transient menu transition without another commit", async t => {
	const f = await fixture(t, async () => {}, "exit-transition");
	f.host.prepareExit(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.closed.length, 1);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("a confirmed exit refreshes an expired preview for the same world without asking twice", async t => {
	const f = await fixture(t, async () => {}, "exit-expired");
	f.host.prepareExit(); await f.host.settled();
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	await new Promise(resolve => setTimeout(resolve, 200));
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	const status = (await f.client.read("spherewright_get_status")).status;
	assert.equal(status.syntheticPrepareCount, 2); assert.equal(status.syntheticCommitCount, 1);
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.closed.length, 1);
});

test("exit approval never carries over to a different world", async t => {
	const f = await fixture(t, async () => {}, "exit-world-change");
	f.host.prepareExit(); await f.host.settled();
	const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().error, "GAME_CONTEXT_CHANGED"); assert.equal(f.closed.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("owner-approved recovery prepares after consent, opens only the recorded primary and leaves old tasks stopped", async t => {
	const f = await fixture(t, async () => { throw new Error("MODEL_MUST_NOT_START"); }, "recovery");
	assert.equal(f.host.snapshot().recovery.state, "ready");
	assert.ok(!f.client.gamePort(f.authority).tools().some(tool => tool.name.includes("resume_owned_game")));
	assert.throws(() => f.client.gameRecoveryPort({}), /TRUSTED_GAME_RECOVERY_CAPABILITY_REQUIRED/);
	f.host.prepareRecovery(); await f.host.settled();
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticPrepareCount, 0);
	const challenge = f.host.confirmation(f.host.currentTaskId, 1); assert.equal(challenge.kind, "game-recovery");
	assert.ok(!JSON.stringify(challenge).includes("PRIVATE_SYNTHETIC_TOKEN"));
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.host.snapshot().recovery.state, "used");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
	assert.ok(!JSON.stringify(f.host.snapshot()).includes("PRIVATE_SYNTHETIC_TOKEN"));
});

test("a recovery preview that would discard progress is refused before commit", async t => {
	const f = await fixture(t, async () => {}, "recovery-bad-plan");
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().error, "GAME_RECOVERY_PREVIEW_REJECTED");
	assert.equal(f.host.snapshot().recovery.state, "ready");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

for (const mode of ["recovery-changed-scope", "recovery-altered-disclosure", "recovery-extra-blocker"]) test(`${mode} refuses the native preview without a commit`, async t => {
	const f = await fixture(t, async () => {}, mode);
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().error, "GAME_RECOVERY_PREVIEW_REJECTED");
	assert.equal(f.host.snapshot().recovery.state, "ready");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("recovery consent does not carry over after a different world is loaded", async t => {
	const f = await fixture(t, async () => {}, "recovery-world-change");
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().error, "GAME_MCP_CONTEXT_UNAVAILABLE");
	const status = (await f.client.read("spherewright_get_status")).status;
	assert.equal(status.syntheticPrepareCount, 0); assert.equal(status.syntheticCommitCount, 0);
	assert.equal(f.host.snapshot().recovery.state, "ready");
});

test("a lost recovery acknowledgement retains the pending credential and original intent", async t => {
	const f = await fixture(t, async () => {}, "recovery-lost-ack");
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().unresolved.length, 1); assert.equal(f.host.snapshot().recovery.state, "pending");
	assert.throws(() => f.host.prepareRecovery(), /GAME_RECOVERY_NOT_READY/);
});

test("stopping during local recovery bookkeeping records that no commit was dispatched", async t => {
	const f = await fixture(t, async () => {}, "recovery");
	let release, reached; const waiting = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
	const transition = f.recoveryVault.transition.bind(f.recoveryVault);
	t.mock.method(f.recoveryVault, "transition", async (...args) => { const value = await transition(...args); if (args[1] === "ready" && args[2] === "pending") { reached(); await held; } return value; });
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await waiting;
	f.host.stop(); release(); await f.host.settled();
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
	assert.equal(f.host.snapshot().unresolved.length, 0); assert.equal(f.host.snapshot().recovery.state, "ready");
	const action = f.host.ledger.tasks().find(task => task.scope.actionKind === "resume-owned-game");
	assert.equal(action.intent.terminal.state, "not_dispatched");
});

test("stopping an accepted recovery still reconciles the original without replay", async t => {
	const f = await fixture(t, async () => {}, "recovery-pending");
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await waitFor(() => f.host.snapshot().phase === "accepted" || f.host.snapshot().phase === "reconciling");
	f.host.stop(); await f.host.settled();
	assert.equal(f.host.snapshot().unresolved.length, 0); assert.equal(f.host.snapshot().recovery.state, "used");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("recovery waits through a transient load transition without another commit", async t => {
	const f = await fixture(t, async () => {}, "recovery-transition");
	f.host.prepareRecovery(); await f.host.settled(); const challenge = f.host.confirmation(f.host.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled();
	assert.equal(f.host.snapshot().phase, "completed"); assert.equal(f.host.snapshot().recovery.state, "used");
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});
const prepare = { sessionId: "synthetic-game-session", planetId: 1, recipeId: 10, count: 2 };
async function craft(invoke) { const result = await invoke("spherewright_prepare_handcraft", prepare); assert.match(result.result.planToken, /^deck-plan:/); assert.ok(!JSON.stringify(result).includes("PRIVATE_")); return invoke("spherewright_commit_handcraft", { sessionId: prepare.sessionId, planetId: 1, planToken: result.result.planToken, idempotencyKey: "model-supplied-key-is-never-used" }); }

test("MCP catalog compiles native nested schemas and refuses consent operations or misleading write hints", () => {
	const read = { name: "spherewright_get_dynamic", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 1 } } } } };
	const catalog = spherewrightCatalog([read, { ...read, name: "spherewright_prepare_save_import" }, { ...read, name: "spherewright_commit_handcraft" }]);
	assert.equal(catalog.size, 1); assert.ok(validSpherewrightArguments(catalog.get(read.name), { ids: [1, 2] }));
	for (const args of [{ ids: [0] }, { ids: [1, 2, 3] }, { ids: ["1"] }, { ids: [1], confirmation: true }]) assert.equal(validSpherewrightArguments(catalog.get(read.name), args), false);
	assert.deepEqual(publicGameValue({ planToken: "secret", saveName: "private", nested: { resumeToken: "secret", count: 2 }, beltPath: [1, 2] }), { nested: { count: 2 }, beltPath: [1, 2] });
});

test("stopped-action resolution accepts only host authority and translates it to the private ledger authority", async t => {
	const f = await fixture(t, async () => {});
	let called = false;
	f.host.ledger.resolveStoppedAction = async (authority, id, proof) => {
		assert.notEqual(authority, f.approval);
		assert.equal(id, "retained-original");
		assert.equal(proof.state, "action_failed");
		called = true;
	};
	assert.throws(() => f.host.resolveStoppedAction({}, "retained-original", {}), /TRUSTED_APPROVAL_AUTHORITY_REQUIRED/);
	f.host.resolveStoppedAction(f.approval, "retained-original", { state: "action_failed" });
	await f.host.settled();
	assert.equal(called, true);
	assert.equal(f.host.snapshot().error, null);
	assert.equal(f.frozen(), 0);
});

test("energy-stopped harvest resolution requires host authority and retains the original proof", async t => {
	const f = await fixture(t, async () => {});
	let called = false;
	f.host.ledger.resolveEnergyStoppedHarvest = async (authority, id, proof) => {
		assert.notEqual(authority, f.approval); assert.equal(id, "retained-original");
		assert.equal(proof.state, "action_failed"); called = true;
	};
	assert.throws(() => f.host.resolveEnergyStoppedHarvest({}, "retained-original", {}), /TRUSTED_APPROVAL_AUTHORITY_REQUIRED/);
	f.host.resolveEnergyStoppedHarvest(f.approval, "retained-original", { state: "action_failed" });
	await f.host.settled(); assert.equal(called, true); assert.equal(f.host.snapshot().error, null); assert.equal(f.frozen(), 0);
});

test("the user can independently reconcile a structured energy stop without replay", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const prepared = await invoke("spherewright_prepare_harvest", { sessionId: "synthetic-game-session", planetId: 1, targetObjectId: 42, count: 12 });
		const accepted = await invoke("spherewright_commit_harvest", { sessionId: "synthetic-game-session", planetId: 1, planToken: prepared.result.planToken, idempotencyKey: "ignored-model-key" });
		await assert.rejects(invoke("spherewright_get_action_result", { actionId: accepted.result.actionId }), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
	}, "energy");
	f.start({ objective: { kind: "evidence" } }); await approve(f); await f.host.settled();
	const parent = f.host.snapshot().currentTaskId, original = f.host.snapshot().unresolved[0]; assert.equal(original.state, "unknown");
	for (let index = 0; index < 40; index++) f.host.ledger.createMcpTask({ kind: "mcp-session", bridgeInstanceId: "synthetic-game-bridge", sessionId: "synthetic-game-session" });
	f.host.reconcile(original.intentId); await f.host.settled();
	assert.equal(f.host.snapshot().unresolved.length, 0); assert.equal(f.host.snapshot().currentTaskId, parent);
	const saved = f.host.ledger.intent(original.intentId); assert.equal(saved.terminal.succeeded, false);
	assert.equal(saved.terminal.failureKind, "mecha_power_starved"); assert.equal(saved.terminal.itemDeltas[0].delta, 3);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("one stdio discovery supports two native actions through one host ledger without per-action adapters", async t => {
	let nativeTools;
	const f = await fixture(t, async ({ invoke, nativeTools: tools }) => {
		nativeTools = tools; const read = await invoke("spherewright_get_recipe_catalog", {}); assert.ok(!JSON.stringify(read).includes("PRIVATE_"));
		for (let index = 0; index < 2; index++) { const receipt = await craft(invoke); assert.ok(receipt.result.accepted); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }); }
	}); f.start(); await approve(f); await approve(f); await f.host.settled();
	assert.ok(nativeTools.some(tool => tool.name === "spherewright_prepare_handcraft")); assert.ok(!nativeTools.some(tool => /save_import/.test(tool.name)));
	const actions = f.host.ledger.tasks().filter(task => task.scope.kind === "mcp-action"); assert.equal(actions.length, 2); assert.ok(actions.every(task => task.intent.state === "completed")); assert.notEqual(actions[0].intent.idempotencyKey, actions[1].intent.idempotencyKey);
	assert.ok(actions.every(task => task.intent.idempotencyKey !== "model-supplied-key-is-never-used")); assert.equal(f.frozen(), 0); assert.equal(f.host.snapshot().unresolved.length, 0);
	const bytes = JSON.stringify(f.host.ledger.db.prepare("SELECT * FROM game_tasks").all()) + JSON.stringify(f.host.ledger.db.prepare("SELECT * FROM game_intents").all()); assert.ok(!bytes.includes("PRIVATE_") && !bytes.includes("deck-plan:"));
});

test("new-world lifecycle transitions the same finite run from menu to owned world", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const prepared = await invoke("spherewright_prepare_new_game", { galaxySeed: 42, starCount: 32 });
		const receipt = await invoke("spherewright_commit_new_game", { planToken: prepared.result.planToken, idempotencyKey: "model-key" });
		await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		const state = await invoke("spherewright_get_session_state", {}); assert.equal(state.result.ownedBySpherewright, true);
		const next = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: next.result.actionId });
	}, "new-game");
	f.start(); await approve(f); await approve(f); await f.host.settled(); assert.equal(f.host.snapshot().unresolved.length, 0); assert.equal(f.host.snapshot().phase, "advised"); assert.equal(f.host.ledger.tasks().filter(task => task.scope.kind === "mcp-action").length, 2);
});

test("read-only mode exposes no prepare/commit and host rejects invented write calls", async t => {
	const f = await fixture(t, async ({ invoke, nativeTools }) => { assert.ok(nativeTools.every(tool => !/_(prepare|commit)_/.test(tool.name))); await assert.rejects(craft(invoke), /GAME_MCP_TOOL_SCOPE_REJECTED/); });
	f.start({ mode: "observe" }); await f.host.settled(); assert.equal(f.host.ledger.unresolved().length, 0); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("forged confirmation and UI invalidation never dispatch a commit", async t => {
	const f = await fixture(t, async ({ invoke }) => craft(invoke)); f.start(); await waitFor(() => f.host.snapshot().mcp.awaitingConfirmation);
	const challenge = f.host.confirmation(f.host.currentTaskId, 7); assert.throws(() => f.host.confirm({}, challenge.nonce, 7), /TRUSTED_USER_APPROVAL_REQUIRED/); assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 8), /FRESH_GAME_MCP_APPROVAL_REQUIRED/);
	f.host.invalidateUi(7); await f.host.settled(); assert.equal(f.host.ledger.unresolved().length, 0); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

for (const mode of ["unknown", "wrong-key", "lost-ack"]) test(`native ${mode} retains the original intent and blocks another submission`, async t => {
	const f = await fixture(t, async ({ invoke }) => { const receipt = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }); }, mode);
	f.start(); await approve(f); await f.host.settled(); const pending = f.host.ledger.unresolved(); assert.equal(pending.length, 1); assert.ok(pending[0].idempotencyKey); assert.equal(f.frozen(), 1);
	assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/); if (mode === "lost-ack") assert.equal(pending[0].actionId, null); else assert.equal(pending[0].state, "unknown");
});

test("submission budget ends the finite suffix while preserving the completed first action", async t => {
	const f = await fixture(t, async ({ invoke }) => { const receipt = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }); await assert.rejects(craft(invoke), /GAME_MCP_WRITE_BUDGET_OR_PENDING/); });
	f.start({ limits: { writes: 1 } }); await approve(f); await f.host.settled(); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1); assert.equal(f.host.ledger.unresolved().length, 0);
});

test("storage rejection at confirmation ends the pending tool without sending a commit or releasing the freeze", async t => {
	const f = await fixture(t, async ({ invoke }) => craft(invoke)); f.start(); await waitFor(() => f.host.snapshot().mcp.awaitingConfirmation);
	const challenge = f.host.confirmation(f.host.currentTaskId, 1); f.host.ledger.db.exec("PRAGMA query_only=ON");
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /GAME_LEDGER_STORAGE_UNAVAILABLE/); await f.host.settled();
	assert.equal(f.host.snapshot().storageAvailable, false); assert.equal(f.frozen(), 1); assert.equal(f.host.ledger.unresolved().length, 0); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0); f.host.ledger.db.exec("PRAGMA query_only=OFF");
});

test("a rejected receipt write preserves the original recorded key after the real synthetic commit", async t => {
	const f = await fixture(t, async ({ invoke }) => craft(invoke)); const original = f.client.gamePort.bind(f.client);
	t.mock.method(f.client, "gamePort", authority => { const port = original(authority); return { ...port, call: async (name, args) => { const reply = await port.call(name, args); if (name === "spherewright_commit_handcraft") f.host.ledger.db.exec("PRAGMA query_only=ON"); return reply; } }; });
	f.start(); await approve(f); await f.host.settled(); assert.equal(f.host.snapshot().storageAvailable, false); const intent = f.host.ledger.unresolved()[0]; assert.equal(intent.state, "recorded"); assert.equal(intent.actionId, null); assert.equal(f.frozen(), 1); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1); f.host.ledger.db.exec("PRAGMA query_only=OFF");
});

test("generic records opt into v3 and a healthy ledger reopen retains the same pending action without transport replay", async t => {
	const f = await fixture(t, async ({ invoke }) => craft(invoke), "pending"); f.start(); await approve(f); await f.host.settled(); const original = f.host.ledger.unresolved()[0];
	assert.equal(f.host.ledger.db.prepare("PRAGMA user_version").get().user_version, 3);
	let reads = 0; const ledger = new GameIntentLedger(join(f.directory, "game-tasks.sqlite"), { approvalAuthority: {}, prepareResearch: async () => { throw new Error("NO_PREPARE_ON_REOPEN"); }, readResearchProof: async () => { reads++; throw new Error("NO_AUTO_READ"); } });
	try { assert.deepEqual(ledger.unresolved(), [original]); assert.equal(reads, 0); } finally { ledger.close(); }
});

async function authorize(f) {
	await waitFor(() => f.host.snapshot().mcp.awaitingAuthorization);
	const challenge = f.host.confirmation(f.host.currentTaskId, 3); assert.equal(challenge.kind, "mcp-run");
	f.host.confirm(f.approval, challenge.nonce, 3); return challenge;
}
const autonomous = { mode: "autonomous", allowedFamilies: ["handcraft"] };

test("autonomous task allocates no model before its actual host approval and forged permission fields cannot start it", async t => {
	let models = 0; const f = await fixture(t, async () => { models++; });
	assert.throws(() => f.start({ ...autonomous, approved: true }), /INVALID_GAME_TASK/);
	assert.throws(() => f.start({ ...autonomous, allowedFamilies: ["save_import"] }), /INVALID_GAME_MCP_AUTHORIZATION_SCOPE/);
	f.start(autonomous); await waitFor(() => f.host.snapshot().mcp.awaitingAuthorization);
	assert.equal(models, 0); const challenge = f.host.confirmation(f.host.currentTaskId, 3);
	assert.throws(() => f.host.confirm({}, challenge.nonce, 3), /TRUSTED_USER_APPROVAL_REQUIRED/);
	await assert.rejects(f.host.callForModel(f.host.currentTaskId, "spherewright_get_recipe_catalog", {}), /GAME_MODEL_TOOL_UNAVAILABLE/);
	f.host.stop(); await f.host.settled(); assert.equal(models, 0); assert.equal(f.host.ledger.unresolved().length, 0); assert.equal(f.frozen(), 0);
});

test("one task authorization permits two ordinary native commits without a second dialog and binds both receipts to its grant", async t => {
	let models = 0;
	const f = await fixture(t, async ({ invoke, nativeTools }) => {
		models++; assert.ok(!nativeTools.some(tool => tool.name === "spherewright_prepare_new_game"));
		for (let index = 0; index < 2; index++) { const receipt = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }); }
	});
	f.start(autonomous); const challenge = await authorize(f); assert.deepEqual(challenge.allowedFamilies, ["handcraft"]); await f.host.settled();
	const tasks = f.host.ledger.tasks(), root = tasks.find(task => task.scope.kind === "mcp-session"), actions = tasks.filter(task => task.scope.kind === "mcp-action");
	assert.ok(root.approvalId); assert.match(root.previewHash, /^sha256:/); assert.equal(root.details.mode, "autonomous"); assert.equal(models, 1);
	assert.equal(actions.length, 2); assert.ok(actions.every(task => task.scope.autonomousAuthorizationHash === root.previewHash && task.intent.state === "completed")); assert.equal(f.host.snapshot().mcp.authorized, false); assert.equal(f.frozen(), 0);
});

test("an early next preparation remains blocked while the agent can reconcile the accepted original and continue", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const original = await craft(invoke);
		await assert.rejects(craft(invoke), /GAME_MCP_WRITE_BUDGET_OR_PENDING/);
		assert.equal(f.host.snapshot().mcp.authorized, true);
		for (let read = 0; read < 2; read++) await invoke("spherewright_get_action_result", { actionId: original.result.actionId });
		assert.equal(f.host.snapshot().unresolved.length, 0);
		const next = await craft(invoke);
		for (let read = 0; read < 2; read++) await invoke("spherewright_get_action_result", { actionId: next.result.actionId });
	}, "goal");
	f.start(autonomous); await authorize(f); await f.host.settled();
	assert.equal(f.host.snapshot().error, null);
	assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 2);
});

test("a known native stale commit retains its original key as unaccepted and permits fresh preparation", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		for (let index = 0; index < 2; index++) {
			const reply = await craft(invoke);
			assert.equal(reply.success, false);
			assert.equal(reply.error.code, "STALE_STATE");
			assert.equal(f.host.snapshot().unresolved.length, 0);
			assert.equal(f.host.snapshot().mcp.authorized, true);
		}
	}, "stale-commit");
	f.start({ ...autonomous, limits: { writes: 2 } }); await authorize(f); await f.host.settled();
	assert.equal(f.host.snapshot().error, null);
	const actions = f.host.ledger.tasks().filter(task => task.scope.kind === "mcp-action");
	assert.equal(actions.length, 2);
	assert.ok(actions.every(action => action.intent.terminal.state === "not_accepted"));
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("autonomous action family and write budget remain enforced after the one-time approval", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		await assert.rejects(invoke("spherewright_prepare_new_game", { galaxySeed: 42, starCount: 32 }), /GAME_MCP_TOOL_SCOPE_REJECTED/);
		const receipt = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId });
		await assert.rejects(craft(invoke), /GAME_MCP_WRITE_BUDGET_OR_PENDING/);
	});
	f.start({ ...autonomous, limits: { writes: 1 } }); await authorize(f); await f.host.settled(); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("new-game still needs its exact plan confirmation before an autonomous run adopts the resulting world", async t => {
	const f = await fixture(t, async ({ invoke }) => {
		const plan = await invoke("spherewright_prepare_new_game", { galaxySeed: 42, starCount: 32 }); assert.equal(plan.result.deckRequiresConfirmation, true);
		const created = await invoke("spherewright_commit_new_game", { planToken: plan.result.planToken, idempotencyKey: "ignored-model-key" }); await invoke("spherewright_get_action_result", { actionId: created.result.actionId });
		const crafted = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: crafted.result.actionId });
	}, "new-game");
	f.start({ mode: "autonomous", allowedFamilies: ["new_game", "handcraft"] }); await authorize(f); await approve(f); await f.host.settled();
	const actions = f.host.ledger.tasks().filter(task => task.scope.kind === "mcp-action"); assert.equal(actions.length, 2); assert.ok(!actions.find(task => task.scope.actionKind === "new-game").scope.autonomousAuthorizationHash); assert.ok(actions.find(task => task.scope.actionKind === "handcraft").scope.autonomousAuthorizationHash);
});

test("a stop during an autonomous accepted call preserves that original receipt and dispatches no next action", async t => {
	let entered, release; const barrier = new Promise(resolve => { entered = resolve; });
	const f = await fixture(t, async ({ invoke }) => { await craft(invoke); await assert.rejects(craft(invoke), /GAME_TASK_STOPPED|GAME_MCP_SESSION_STOPPED/); }, "pending");
	const original = f.client.gamePort.bind(f.client);
	t.mock.method(f.client, "gamePort", authority => { const port = original(authority); return { ...port, call: async (name, args) => { const reply = await port.call(name, args); if (name === "spherewright_commit_handcraft") { entered(); await new Promise(resolve => { release = resolve; }); } return reply; } }; });
	f.start(autonomous); await authorize(f); await barrier; f.host.stop(); release(); await f.host.settled();
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1); assert.equal(f.host.ledger.unresolved()[0].state, "accepted"); assert.equal(f.host.snapshot().mcp.authorized, false); assert.equal(f.frozen(), 1);
});

test("autonomous native uncertainty revokes the run immediately instead of asking the model to keep trying", async t => {
	const f = await fixture(t, async ({ invoke, signal }) => {
		const receipt = await craft(invoke); await assert.rejects(invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
		assert.equal(signal.aborted, true); await assert.rejects(craft(invoke), /GAME_TASK_STOPPED|GAME_MCP_SESSION_STOPPED/);
	}, "unknown");
	f.start(autonomous); await authorize(f); await f.host.settled(); assert.equal(f.host.ledger.unresolved()[0].state, "unknown"); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("storage failure while recording run authorization starts no model and never releases the storage freeze", async t => {
	let models = 0; const f = await fixture(t, async () => { models++; }); f.start(autonomous); await waitFor(() => f.host.snapshot().mcp.awaitingAuthorization);
	const challenge = f.host.confirmation(f.host.currentTaskId, 3); f.host.ledger.db.exec("PRAGMA query_only=ON"); assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 3), /GAME_LEDGER_STORAGE_UNAVAILABLE/); await f.host.settled();
	assert.equal(models, 0); assert.equal(f.host.snapshot().storageAvailable, false); assert.equal(f.frozen(), 1); f.host.ledger.db.exec("PRAGMA query_only=OFF");
});

test("persisted autonomous approval is history only and reconstructing the host schedules no model or new game call", async t => {
	let models = 0; const f = await fixture(t, async ({ invoke }) => { models++; const receipt = await craft(invoke); await invoke("spherewright_get_action_result", { actionId: receipt.result.actionId }); });
	f.start(autonomous); await authorize(f); await f.host.settled(); const calls = f.client.stats.toolCalls;
	const rebuilt = new GameTasks({ directory: f.directory, bridge: { metadata: f.client.metadata }, researchAuthority: {}, approvalAuthority: {}, freezeDevelopment: async () => { throw new Error("NO_NEW_FREEZE_EXPECTED"); }, releaseDevelopment: async () => {}, planner: async () => { models++; throw new Error("NO_AUTOMATIC_REPLAY"); } });
	try { await rebuilt.initialize(); assert.equal(rebuilt.snapshot().mcp.authorized, false); assert.equal(rebuilt.snapshot().busy, false); assert.equal(models, 1); assert.equal(f.client.stats.toolCalls, calls); } finally { rebuilt.close(); }
});
