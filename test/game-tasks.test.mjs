import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";
import { armRuntimeStorageFault } from "../apps/desktop/storage-fault-smoke.mjs";

test("power drain invalidates the old catalog and approval without replaying its model", async t => {
	let models = 0; const f = await fixture(t, { planner: async () => { models++; return { proposedTechId: 100 }; } });
	f.host.catalog(); const catalog = (await f.host.settled()).catalog;
	f.start(f.host, { catalogId: catalog.id }); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1);
	await f.host.drain(); assert.equal(f.host.snapshot().catalog, null);
	await f.host.resumeAfterCloseFailure();
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.throws(() => f.start(f.host, { catalogId: catalog.id }), /FRESH_RESEARCH_CATALOG_REQUIRED/);
	assert.equal(models, 1); assert.equal(f.host.snapshot().tasks.length, 1); assert.equal(f.host.snapshot().unresolved.length, 0);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("an accepted receipt arriving during power drain is retained and wake never resubmits it", async t => {
	let models = 0, entered, release; const barrier = new Promise(resolve => { entered = resolve; });
	const f = await fixture(t, { mode: "pending", planner: async () => { models++; return { proposedTechId: 100 }; } });
	f.start(); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1), commit = f.host.adapter.commit.bind(f.host.adapter);
	t.mock.method(f.host.adapter, "commit", async request => { const receipt = await commit(request); entered(); await new Promise(resolve => { release = resolve; }); return receipt; });
	f.host.confirm(f.approval, challenge.nonce, 1); await barrier;
	const draining = f.host.drain(); release(); await draining;
	const original = f.host.snapshot().unresolved[0]; assert.ok(original.actionId); const calls = f.client.stats.toolCalls;
	await f.host.resumeAfterCloseFailure(); const after = f.host.snapshot();
	assert.deepEqual(after.unresolved[0], original); assert.equal(after.developmentFrozen, true); assert.equal(after.phase, "blocked");
	assert.equal(f.client.stats.toolCalls, calls); assert.equal(models, 1);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

async function fixture(t, { mode = "normal", planner = async () => ({ proposedTechId: 100 }), now = () => Date.now(), syntheticOnly = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-game-host-")), authority = {}, approval = {}, instances = [];
	const client = new ReadOnlyMcpClient(spawn(process.execPath, [fileURLToPath(new URL("./fixtures/research-mcp-server.mjs", import.meta.url)), mode], { stdio: "pipe", windowsHide: true }), { researchAuthority: authority, timeoutMs: 1000 });
	await client.discover(); let developmentFrozen = false, lease = null;
	const bridge = { acquireResearch(identity) { assert.equal(identity, authority); assert.equal(lease, null); return lease = { client, selection: { cohortHash: "fixture-cohort" } }; }, releaseResearch(value) { assert.equal(value, lease); lease = null; } };
	const open = () => { const host = new GameTasks({ directory, researchAuthority: authority, approvalAuthority: approval, bridge, planner, now, syntheticOnly, freezeDevelopment: async () => { developmentFrozen = true; }, releaseDevelopment: async () => { developmentFrozen = false; }, pollMilliseconds: mode === "pending" ? 0 : 1000 }); instances.push(host); return host; };
	const host = open(), start = (target = host, extra = {}) => target.start({ mode: "assist", techId: 100, providerId: "synthetic-provider", modelId: "synthetic-model", prompt: "Normally enqueue only the selected technology", ...extra });
	t.after(async () => { for (const instance of instances) { if (!instance.ledger.closed) { await instance.drain(); instance.close(); } } await client.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-game-host-")); await rm(absolute, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }); });
	return { host, open, start, client, approval, directory, frozen: () => developmentFrozen, hasLease: () => Boolean(lease) };
}

test("research catalog contains only named unqueued targets, consumes no model request and rejects stale selection handles", async (t) => {
	let now = Date.now(), modelRequests = 0;
	const f = await fixture(t, { now: () => now, planner: async () => { modelRequests++; return { proposedTechId: 100 }; } });
	f.host.catalog(); const value = await f.host.settled(); assert.equal(value.phase, "catalog_ready"); assert.equal(value.tasks.length, 0); assert.equal(modelRequests, 0); assert.equal(f.frozen(), false);
	assert.deepEqual(value.catalog.items.map((tech) => tech.techId), [100]); assert.equal(value.catalog.items[0].name, "Synthetic research"); assert.ok(!JSON.stringify(value.catalog).includes("PRIVATE_"));
	assert.throws(() => f.start(f.host, { catalogId: "forged-catalog" }), /FRESH_RESEARCH_CATALOG_REQUIRED/);
	now += 61000; const calls = f.client.stats.toolCalls; assert.throws(() => f.start(f.host, { catalogId: value.catalog.id }), /FRESH_RESEARCH_CATALOG_REQUIRED/); assert.equal(f.client.stats.toolCalls, calls);
});

test("observe mode still reads and advises when the native service has writes disabled", async (t) => {
	const f = await fixture(t, { mode: "writes-disabled" }); f.host.catalog(); const catalog = (await f.host.settled()).catalog;
	f.start(f.host, { mode: "observe", catalogId: catalog.id }); const value = await f.host.settled(); assert.equal(value.phase, "advised"); assert.equal(value.unresolved.length, 0); assert.equal(f.frozen(), false);
});

test("host prepares but sends no commit until an exact live native approval, then releases development after readback", async (t) => {
	const f = await fixture(t); f.start();
	const preview = await f.host.settled(); assert.equal(preview.phase, "awaiting_approval"); assert.equal(preview.unresolved.length, 0); assert.equal(f.frozen(), true); assert.equal(f.hasLease(), true);
	assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/);
	const id = preview.currentTaskId, challenge = f.host.confirmation(id, 1);
	assert.ok(!JSON.stringify({ preview, challenge }).includes("PRIVATE_"));
	assert.deepEqual(challenge.researchBudget, [{ itemId: 1202, name: "磁线圈", count: 10, direction: "research-consumption" }]); assert.ok(Object.isFrozen(challenge.researchBudget));
	assert.throws(() => f.host.confirm({}, challenge.nonce, 1), /TRUSTED_USER_APPROVAL_REQUIRED/);
	f.host.confirm(f.approval, challenge.nonce, 1);
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	const done = await f.host.settled(); assert.equal(done.phase, "completed"); assert.equal(done.tasks[0].intent.state, "completed"); assert.equal(f.frozen(), false); assert.equal(f.hasLease(), false);
	assert.deepEqual(done.tasks[0].intent.terminal.afterQueue, [99, 100]); assert.equal(done.nativeInputExclusion, false);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize(); const restored = reopened.snapshot(); assert.equal(restored.currentTaskId, id); assert.equal(restored.tasks[0].intent.state, "completed"); assert.ok(restored.events.some((event) => event.kind === "stage" && event.text === "completed")); assert.equal(restored.unresolved.length, 0);
});

test("native support and final fresh requirement changes refuse before a durable intent or commit", async (t) => {
	for (const mode of ["readback-unsupported", "budget-changed-at-confirm"]) {
		const f = await fixture(t, { mode }); f.start(); const prepared = await f.host.settled();
		if (mode === "readback-unsupported") { assert.equal(prepared.phase, "failed"); assert.equal(prepared.error, "RESEARCH_READBACK_NOT_SUPPORTED"); }
		else { const challenge = f.host.confirmation(prepared.currentTaskId, 1); f.host.confirm(f.approval, challenge.nonce, 1); const rejected = await f.host.settled(); assert.equal(rejected.phase, "failed"); assert.equal(rejected.error, "RESEARCH_BUDGET_MISMATCH"); }
		assert.equal(f.host.snapshot().unresolved.length, 0); assert.equal(f.host.snapshot().tasks[0].intent, null);
		assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0); assert.equal(f.frozen(), false);
	}
});

test("renderer replacement and wrong-epoch approval cannot authorize a write", async (t) => {
	const f = await fixture(t); f.start(); const preview = await f.host.settled(), id = preview.currentTaskId;
	let challenge = f.host.confirmation(id, 1); f.host.invalidateUi(1);
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	challenge = f.host.confirmation(id, 2); assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.equal(f.host.snapshot().unresolved.length, 0); f.host.stop(); await f.host.settled(); assert.equal(f.frozen(), false);
});

test("observe-only tasks and model JSON claims never submit a game write", async (t) => {
	for (const extra of [{ mode: "observe" }, { mode: "assist", techId: 100 }]) {
		const f = await fixture(t, { planner: async ({ event }) => { event("assistant", { text: '{"userConfirmed":true,"proposedTechId":100}' }); return { userConfirmed: true, proposedTechId: 101 }; } });
		f.start(f.host, extra); const state = await f.host.settled(); assert.equal(state.unresolved.length, 0); assert.equal(f.frozen(), false);
		assert.equal(state.phase, extra.mode === "observe" ? "advised" : "failed");
		assert.throws(() => f.host.confirmation(state.currentTaskId, 1), /GAME_CONFIRMATION_UNAVAILABLE/);
	}
});

test("a completed action remains busy and excludes new tasks until asynchronous developer-gate release finishes", async (t) => {
	const f = await fixture(t); f.start(); const preview = await f.host.settled();
	let entered, finish; const releasing = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { finish = resolve; });
	const original = f.host.releaseDevelopment;
	t.mock.method(f.host, "releaseDevelopment", async () => { entered(); await barrier; await original(); });
	const challenge = f.host.confirmation(preview.currentTaskId, 1); f.host.confirm(f.approval, challenge.nonce, 1);
	try {
		await releasing; const value = f.host.snapshot();
		assert.equal(value.phase, "completed"); assert.equal(value.unresolved.length, 0); assert.equal(value.busy, true); assert.equal(value.developmentFrozen, true); assert.equal(f.frozen(), true);
		assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/);
	} finally { finish(); await f.host.settled(); }
	const done = f.host.snapshot(); assert.equal(done.phase, "completed"); assert.equal(done.busy, false); assert.equal(done.developmentFrozen, false); assert.equal(f.frozen(), false);
});

test("UI replacement during final fresh checks cancels before durable intent or native commit", async (t) => {
	const f = await fixture(t); f.start(); const ready = await f.host.settled(), challenge = f.host.confirmation(ready.currentTaskId, 1);
	let enter, release; const entered = new Promise((done) => { enter = done; }); const original = f.host.adapter.observe.bind(f.host.adapter);
	t.mock.method(f.host.adapter, "observe", async (...args) => { const value = await original(...args); enter(); await new Promise((done) => { release = done; }); return value; });
	f.host.confirm(f.approval, challenge.nonce, 1); await entered; f.host.invalidateUi(1); release(); const stopped = await f.host.settled();
	assert.equal(stopped.unresolved.length, 0); assert.equal(stopped.tasks[0].intent, null); assert.equal(stopped.phase, "cancelled");
});

test("cancel while model is planning refuses late proposal and leaves no approval or write", async (t) => {
	let entered, release; const barrier = new Promise((done) => { entered = done; });
	const f = await fixture(t, { planner: async () => { entered(); await new Promise((done) => { release = done; }); return { proposedTechId: 100 }; } });
	f.start(); await barrier; f.host.stop(); release(); const done = await f.host.settled();
	assert.equal(done.phase, "cancelled"); assert.equal(done.tasks[0].state, "cancelled"); assert.equal(done.unresolved.length, 0); assert.equal(f.frozen(), false);
});

test("late usage after cancellation is retained while a late proposal still cannot prepare or commit", async t => {
	let entered, release; const barrier = new Promise(done => { entered = done; });
	const f = await fixture(t, { planner: async () => { entered(); await new Promise(done => { release = done; }); return { proposedTechId: 100 }; } });
	f.start(); await barrier;
	const id = f.host.currentTaskId; f.host.stop();
	const usage = new ModelUsage({ publish: value => f.host.plannerEvent(id, "usage", value) });
	usage.finish(usage.start(), { usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 } });
	const context = { version: 1, method: "pi-estimate", stage: "task_end", contextWindow: 8192, estimatedTokens: 1024, percent: 12.5 };
	f.host.plannerEvent(id, "context", context);
	release(); const done = await f.host.settled();
	assert.deepEqual(done.tasks[0].details.context, context);
	assert.equal(done.phase, "cancelled"); assert.deepEqual(done.tasks[0].details.usage, usage.snapshot()); assert.equal(done.tasks[0].intent, null); assert.deepEqual(done.unresolved, []);
});

test("ACK loss stays blocked across restart; no new approval, key or model run is admitted", async (t) => {
	const f = await fixture(t, { mode: "lost-ack" }); f.start(); const prepared = await f.host.settled(), challenge = f.host.confirmation(prepared.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const blocked = await f.host.settled();
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.unresolved.length, 1); assert.equal(blocked.unresolved[0].actionId, null); assert.equal(f.frozen(), true);
	assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/); await f.host.drain(); f.host.close();
	const reopened = f.open(); await reopened.initialize(); const restored = reopened.snapshot(); assert.equal(restored.unresolved[0].idempotencyKey, blocked.unresolved[0].idempotencyKey); assert.equal(restored.tasks[0].details.techName, "Synthetic research");
	assert.throws(() => f.start(reopened), /GAME_TASK_START_BLOCKED/); assert.throws(() => reopened.reconcile(restored.unresolved[0].intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/);
});

test("accepted pending action survives cancellation and restart, then reads only its original action", async (t) => {
	const f = await fixture(t, { mode: "pending" }); f.start(); const prepared = await f.host.settled(), challenge = f.host.confirmation(prepared.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const pending = await f.host.settled(); assert.equal(pending.phase, "reconciling"); const original = pending.unresolved[0];
	f.host.stop(); await f.host.settled(); assert.equal(f.host.snapshot().unresolved[0].actionId, original.actionId); await f.host.drain(); f.host.close();
	const reopened = f.open(); await reopened.initialize(); reopened.reconcile(original.intentId); const done = await reopened.settled();
	assert.equal(done.phase, "completed"); assert.equal(done.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.equal(done.tasks[0].intent.actionId, original.actionId); assert.equal(f.frozen(), false);
});

test("a wrong original-action receipt stays in durable independent-audit isolation even if the next service reply would be valid", async (t) => {
	for (const mode of ["wrong-result-then-valid", "wrong-key-context-failure"]) {
	const f = await fixture(t, { mode }); f.start(); const ready = await f.host.settled(), challenge = f.host.confirmation(ready.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const blocked = await f.host.settled(); assert.equal(blocked.phase, "blocked"); assert.equal(blocked.error, "INDEPENDENT_GAME_AUDIT_REQUIRED");
	if (mode === "wrong-key-context-failure") await assert.rejects(f.client.read("spherewright_get_status"), /MCP_TOOL_REJECTED/);
	const intent = blocked.unresolved[0], count = f.client.stats.toolCalls;
	f.host.reconcile(intent.intentId); await f.host.settled(); assert.equal(f.client.stats.toolCalls, count); assert.equal(f.frozen(), true);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize(); reopened.reconcile(intent.intentId); const restored = await reopened.settled();
	assert.equal(restored.phase, "blocked"); assert.equal(restored.error, "INDEPENDENT_GAME_AUDIT_REQUIRED"); assert.equal(f.client.stats.toolCalls, count); assert.equal(restored.unresolved[0].actionId, intent.actionId); assert.equal(restored.unresolved[0].idempotencyKey, intent.idempotencyKey);
	}
});

test("durable storage failure before send closes execution until restart even when the disk becomes writable again", async (t) => {
	const f = await fixture(t); f.start(); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1);
	f.host.ledger.db.exec("PRAGMA query_only=ON"); f.host.confirm(f.approval, challenge.nonce, 1); const done = await f.host.settled(); f.host.ledger.db.exec("PRAGMA query_only=OFF");
	assert.equal(done.unresolved.length, 0); assert.equal(done.tasks[0].intent, null); assert.equal(done.phase, "blocked"); assert.equal(done.storageAvailable, false); assert.equal(done.error, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(done.developmentFrozen, true); assert.equal(f.frozen(), true);
	const calls = f.client.stats.toolCalls;
	for (const operation of [() => f.start(), () => f.host.catalog(), () => f.host.reprepare(), () => f.host.confirmation(preview.currentTaskId, 1), () => f.host.reconcile("no-intent")]) assert.throws(operation, /GAME_LEDGER_STORAGE_UNAVAILABLE/);
	assert.doesNotThrow(() => f.host.stop()); assert.equal(f.host.snapshot().phase, "blocked"); assert.equal(f.host.snapshot().error, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(f.client.stats.toolCalls, calls);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("an accepted MCP action whose receipt cannot be stored retains its original durable key and never resubmits after restart", async t => {
	let modelRuns = 0; const f = await fixture(t, { planner: async () => { modelRuns++; return { proposedTechId: 100 }; } }); f.start(); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1);
	const commit = f.host.adapter.commit.bind(f.host.adapter);
	t.mock.method(f.host.adapter, "commit", async dto => { const receipt = await commit(dto); assert.equal(receipt.accepted, true); f.host.ledger.db.exec("PRAGMA query_only=ON"); return receipt; });
	f.host.confirm(f.approval, challenge.nonce, 1); const blocked = await f.host.settled(); f.host.ledger.db.exec("PRAGMA query_only=OFF");
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.storageAvailable, false); assert.equal(blocked.developmentFrozen, true); assert.equal(blocked.error, "GAME_LEDGER_STORAGE_UNAVAILABLE");
	const original = blocked.unresolved[0]; assert.equal(original.state, "recorded"); assert.equal(original.actionId, null); assert.equal(original.acceptance, null); assert.equal(original.terminal, null); assert.equal(blocked.tasks[0].id, preview.currentTaskId);
	const calls = f.client.stats.toolCalls; assert.throws(() => f.host.reconcile(original.intentId), /GAME_LEDGER_STORAGE_UNAVAILABLE/); assert.equal(f.client.stats.toolCalls, calls);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize(); const restored = reopened.snapshot();
	assert.equal(restored.phase, "blocked"); assert.equal(restored.storageAvailable, true); assert.equal(restored.developmentFrozen, true); assert.deepEqual(restored.unresolved[0], original);
	const resumedCalls = f.client.stats.toolCalls; assert.throws(() => reopened.reconcile(original.intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.throws(() => f.start(reopened), /GAME_TASK_START_BLOCKED/); assert.equal(f.client.stats.toolCalls, resumedCalls); assert.equal(modelRuns, 1);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("terminal-storage failure preserves the accepted action and allows only its original proof after a healthy restart", async t => {
	let modelRuns = 0; const f = await fixture(t, { planner: async () => { modelRuns++; return { proposedTechId: 100 }; } }); f.start(); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1);
	const reconcile = f.host.ledger.reconcile.bind(f.host.ledger);
	t.mock.method(f.host.ledger, "reconcile", async id => { f.host.ledger.db.exec("PRAGMA query_only=ON"); return reconcile(id); });
	f.host.confirm(f.approval, challenge.nonce, 1); const blocked = await f.host.settled(); f.host.ledger.db.exec("PRAGMA query_only=OFF");
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.storageAvailable, false); assert.equal(blocked.developmentFrozen, true); assert.equal(blocked.error, "GAME_LEDGER_STORAGE_UNAVAILABLE");
	const original = blocked.unresolved[0]; assert.equal(original.state, "accepted"); assert.ok(original.actionId); assert.equal(original.acceptance.actionId, original.actionId); assert.equal(original.terminal, null);
	const calls = f.client.stats.toolCalls; assert.throws(() => f.host.reconcile(original.intentId), /GAME_LEDGER_STORAGE_UNAVAILABLE/); assert.equal(f.client.stats.toolCalls, calls);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize(); assert.deepEqual(reopened.snapshot().unresolved[0], original);
	reopened.reconcile(original.intentId); const completed = await reopened.settled(); assert.equal(completed.phase, "completed"); assert.equal(completed.storageAvailable, true); assert.equal(completed.unresolved.length, 0); assert.equal(completed.developmentFrozen, false);
	assert.equal(completed.tasks[0].id, preview.currentTaskId); assert.equal(completed.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.equal(completed.tasks[0].intent.actionId, original.actionId); assert.deepEqual(completed.tasks[0].intent.acceptance, original.acceptance); assert.equal(modelRuns, 1);
	assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

for (const boundary of ["receipt", "terminal"]) test("runtime loss before " + boundary + " persistence cannot release a refused ledger or replay its accepted action", async t => {
	let models = 0, exits = 0;
	const f = await fixture(t, { syntheticOnly: true, planner: async () => { models++; return { proposedTechId: 100 }; } });
	f.start(); const preview = await f.host.settled(), challenge = f.host.confirmation(preview.currentTaskId, 1);
	const fault = armRuntimeStorageFault(f.host, { boundary, stopRuntime: async () => { exits++; f.host.runtimeUnavailable(); return { pid: 1, exitObserved: true }; } });
	t.after(() => fault.restore());
	try { f.host.confirm(f.approval, challenge.nonce, 1); await f.host.settled(); } finally { fault.restore(); }
	const blocked = f.host.snapshot(), original = fault.original;
	assert.equal(exits, 1); assert.equal(models, 1); assert.equal(blocked.runtimeAvailable, false); assert.equal(blocked.storageAvailable, false);
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.error, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(blocked.developmentFrozen, true); assert.equal(f.frozen(), true);
	assert.deepEqual(blocked.unresolved, [original]); assert.deepEqual(blocked.tasks[0].intent, original); assert.equal(original.state, boundary === "receipt" ? "recorded" : "accepted"); assert.equal(original.terminal, null);
	const calls = f.client.stats.toolCalls;
	for (const operation of [() => f.start(), () => f.host.catalog(), () => f.host.reprepare(), () => f.host.confirmation(preview.currentTaskId, 1)]) assert.throws(operation, /GAME_RUNTIME_UNAVAILABLE/);
	assert.throws(() => f.host.reconcile(original.intentId), /GAME_LEDGER_STORAGE_UNAVAILABLE/); f.host.stop();
	assert.deepEqual(f.host.snapshot().tasks, blocked.tasks); assert.deepEqual(f.host.snapshot().events, blocked.events); assert.equal(f.client.stats.toolCalls, calls);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize(); const initial = reopened.snapshot();
	assert.equal(initial.storageAvailable, true); assert.equal(initial.runtimeAvailable, true); assert.equal(initial.phase, "blocked"); assert.equal(initial.developmentFrozen, true); assert.deepEqual(initial.unresolved, [original]); assert.deepEqual(initial.tasks, blocked.tasks); assert.deepEqual(initial.events, blocked.events);
	assert.throws(() => f.start(reopened), /GAME_TASK_START_BLOCKED/);
	if (boundary === "receipt") { assert.equal(original.actionId, null); assert.equal(original.acceptance, null); assert.throws(() => reopened.reconcile(original.intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.equal(f.client.stats.toolCalls, calls); }
	else {
		assert.ok(original.actionId); assert.equal(original.acceptance.actionId, original.actionId); reopened.reconcile(original.intentId); const completed = await reopened.settled();
		assert.equal(completed.phase, "completed"); assert.equal(completed.unresolved.length, 0); assert.equal(completed.developmentFrozen, false); assert.equal(completed.tasks[0].intent.actionId, original.actionId); assert.equal(completed.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.deepEqual(completed.tasks[0].intent.acceptance, original.acceptance);
	}
	assert.equal(models, 1); assert.equal(exits, 1); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
});

test("runtime and storage fault injection cannot attach to a non-synthetic game host", () => {
	assert.throws(() => armRuntimeStorageFault({ syntheticOnly: false }, { boundary: "receipt", stopRuntime: () => assert.fail("Unowned runtime must not be stopped") }), { code: "ERR_ASSERTION" });
});

test("storage failure in an asynchronous planner event aborts the turn without escaping the host callback or preparing", async t => {
	let entered, release, signal; const planning = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
	const f = await fixture(t, { planner: async value => { signal = value.signal; entered(); await waiting; return { proposedTechId: 100 }; } });
	f.start(); await planning; const id = f.host.snapshot().currentTaskId, calls = f.client.stats.toolCalls;
	f.host.ledger.db.exec("PRAGMA query_only=ON");
	assert.doesNotThrow(() => f.host.plannerEvent(id, "assistant", { text: "synthetic output" })); assert.equal(signal.aborted, true);
	f.host.ledger.db.exec("PRAGMA query_only=OFF"); release(); const blocked = await f.host.settled();
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.storageAvailable, false); assert.equal(blocked.developmentFrozen, true); assert.equal(blocked.tasks[0].intent, null); assert.equal(f.client.stats.toolCalls, calls);
	assert.throws(() => f.host.profileTask(id), /GAME_LEDGER_STORAGE_UNAVAILABLE/); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("runtime loss invalidates an already issued approval and freezes all new game preparation", async t => {
	const f = await fixture(t); f.start(); const before = await f.host.settled(), challenge = f.host.confirmation(before.currentTaskId, 1);
	f.host.runtimeUnavailable(); const after = f.host.snapshot(); assert.equal(after.runtimeAvailable, false); assert.equal(after.developmentFrozen, true); assert.deepEqual(after.tasks, before.tasks);
	for (const operation of [() => f.start(), () => f.host.catalog(), () => f.host.reprepare(), () => f.host.confirmation(before.currentTaskId, 1), () => f.host.confirm(f.approval, challenge.nonce, 1)]) assert.throws(operation, /GAME_RUNTIME_UNAVAILABLE/);
	assert.equal(after.unresolved.length, 0); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("runtime loss during the final fresh read refuses intent creation and never claims developer-gate release", async t => {
	const f = await fixture(t); f.start(); const before = await f.host.settled(), challenge = f.host.confirmation(before.currentTaskId, 1);
	let enter, release; const entered = new Promise(resolve => { enter = resolve; }), original = f.host.adapter.observe.bind(f.host.adapter);
	t.mock.method(f.host.adapter, "observe", async (...args) => { const value = await original(...args); enter(); await new Promise(resolve => { release = resolve; }); return value; });
	f.host.confirm(f.approval, challenge.nonce, 1); await entered; f.host.runtimeUnavailable(); release(); const after = await f.host.settled();
	assert.equal(after.phase, "runtime_unavailable"); assert.equal(after.error, "GAME_RUNTIME_UNAVAILABLE"); assert.equal(after.unresolved.length, 0); assert.equal(after.tasks[0].intent, null);
	assert.equal(f.frozen(), true); assert.equal(f.hasLease(), false); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("an accepted action can read its original terminal after runtime loss without releasing the development freeze", async t => {
	const f = await fixture(t, { mode: "pending" }); f.start(); const prepared = await f.host.settled(), challenge = f.host.confirmation(prepared.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const original = (await f.host.settled()).unresolved[0];
	f.host.runtimeUnavailable(); f.host.reconcile(original.intentId); const after = await f.host.settled();
	assert.equal(after.phase, "completed"); assert.equal(after.runtimeAvailable, false); assert.equal(after.unresolved.length, 0); assert.equal(after.developmentFrozen, true); assert.equal(f.frozen(), true); assert.equal(f.hasLease(), false);
	assert.equal(after.tasks[0].intent.actionId, original.actionId); assert.equal(after.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 1);
	assert.throws(() => f.start(), /GAME_RUNTIME_UNAVAILABLE/);
});

test("a planner result delivered after runtime loss cannot prepare or approve a game action", async t => {
	let enter, release; const entered = new Promise(resolve => { enter = resolve; });
	const f = await fixture(t, { planner: async () => { enter(); await new Promise(resolve => { release = resolve; }); return { proposedTechId: 100 }; } });
	f.start(); await entered; f.host.runtimeUnavailable(); release(); const after = await f.host.settled();
	assert.equal(after.phase, "runtime_unavailable"); assert.equal(after.tasks[0].intent, null); assert.equal(after.unresolved.length, 0); assert.equal(after.developmentFrozen, true);
	assert.throws(() => f.host.confirmation(after.currentTaskId, 1), /GAME_RUNTIME_UNAVAILABLE/); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});

test("runtime-exit authority invalidation cannot be interrupted by a simultaneous ledger read failure", async t => {
	const f = await fixture(t); f.start(); const before = await f.host.settled(), challenge = f.host.confirmation(before.currentTaskId, 1);
	t.mock.method(f.host.ledger, "unresolved", () => { throw new Error("SYNTHETIC_STORAGE_READ_FAILURE"); });
	try { assert.doesNotThrow(() => f.host.runtimeUnavailable()); assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /GAME_RUNTIME_UNAVAILABLE/); }
	finally { t.mock.restoreAll(); }
	assert.equal(f.host.snapshot().runtimeAvailable, false); assert.equal((await f.client.read("spherewright_get_status")).status.syntheticCommitCount, 0);
});
