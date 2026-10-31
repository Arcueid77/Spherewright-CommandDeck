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

async function fixture(t, planner, mode = "normal") {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-unified-game-")), authority = {}, approval = {};
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/game-mcp-server.mjs", import.meta.url)), mode], { windowsHide: true, stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
	const client = new ReadOnlyMcpClient(child, { researchAuthority: authority }); await client.discover();
	let held = false, frozen = 0;
	const bridge = { metadata: client.metadata, acquireGame(value) { assert.equal(value, authority); assert.equal(held, false); held = true; return { client, selection: { cohortHash: "a".repeat(64) }, generic: true }; }, releaseResearch() { held = false; } };
	const host = new GameTasks({ directory, bridge, researchAuthority: authority, approvalAuthority: approval, freezeDevelopment: async () => { frozen++; }, releaseDevelopment: async () => { frozen--; }, planner, syntheticOnly: true });
	t.after(async () => { await host.drain(); host.close(); await client.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-unified-game-")); await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	const start = extra => host.start({ kind: "mcp", mode: "assist", providerId: "commanddeck-fixture", modelId: "fixture", prompt: "Synthetic finite native task", ...extra });
	return { directory, client, host, approval, start, frozen: () => frozen };
}
async function waitFor(predicate) { const end = performance.now() + 5000; while (!predicate()) { assert.ok(performance.now() < end, "SYNTHETIC_STAGE_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function approve(f) { await waitFor(() => f.host.snapshot().mcp.awaitingConfirmation); const challenge = f.host.confirmation(f.host.currentTaskId, 1); assert.equal(challenge.kind, "mcp"); assert.ok(!JSON.stringify(challenge).includes("PRIVATE_")); f.host.confirm(f.approval, challenge.nonce, 1); }
const prepare = { sessionId: "synthetic-game-session", planetId: 1, recipeId: 10, count: 2 };
async function craft(invoke) { const result = await invoke("spherewright_prepare_handcraft", prepare); assert.match(result.result.planToken, /^deck-plan:/); assert.ok(!JSON.stringify(result).includes("PRIVATE_")); return invoke("spherewright_commit_handcraft", { sessionId: prepare.sessionId, planetId: 1, planToken: result.result.planToken, idempotencyKey: "model-supplied-key-is-never-used" }); }

test("MCP catalog compiles native nested schemas and refuses consent operations or misleading write hints", () => {
	const read = { name: "spherewright_get_dynamic", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 1 } } } } };
	const catalog = spherewrightCatalog([read, { ...read, name: "spherewright_prepare_save_import" }, { ...read, name: "spherewright_commit_handcraft" }]);
	assert.equal(catalog.size, 1); assert.ok(validSpherewrightArguments(catalog.get(read.name), { ids: [1, 2] }));
	for (const args of [{ ids: [0] }, { ids: [1, 2, 3] }, { ids: ["1"] }, { ids: [1], confirmation: true }]) assert.equal(validSpherewrightArguments(catalog.get(read.name), args), false);
	assert.deepEqual(publicGameValue({ planToken: "secret", saveName: "private", nested: { resumeToken: "secret", count: 2 }, beltPath: [1, 2] }), { nested: { count: 2 }, beltPath: [1, 2] });
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
