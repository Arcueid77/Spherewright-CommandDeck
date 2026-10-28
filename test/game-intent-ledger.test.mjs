import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { nativeResearchStateHash } from "../apps/desktop/research-preview.mjs";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";

async function fixture(t, { pageSize } = {}) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-game-ledger-")), file = join(directory, "game-ledger.sqlite"), authority = {}, stores = []; let now = 100000;
	if (pageSize === 512) { const seed = new DatabaseSync(file); seed.exec("PRAGMA page_size=512; VACUUM"); seed.close(); }
	let prepareReply, proofReply;
	const open = () => { const ledger = new GameIntentLedger(file, { approvalAuthority: authority, prepareResearch: async (request) => prepareReply ? prepareReply(request) : { request, plan: plan(), researchBudget: budget() }, readResearchProof: async (request) => proofReply ? proofReply(request) : { request, terminal: completion({ scope }, ledger.intent(request.intentId)), freshProgression: progression({ scope, context }), context: resultContext({ scope, context }) }, now: () => now }); stores.push(ledger); return ledger; };
	const scope = { bridgeInstanceId: "bridge-fixture", sessionId: "session-fixture", planetId: 1, techId: 100, capturedAtGameTick: 1200, selectionStateHash: "sha256:" + "a".repeat(64) };
	const budget = () => [{ itemId: 1202, name: "磁线圈", count: 10, direction: "research-consumption" }];
	const context = () => ({ ...scope, owned: true, accessRestricted: false, writeHealth: "healthy", observedAt: now, researchBudget: budget() });
	const token = "synthetic-private-plan-" + randomUUID();
	const plan = () => ({ prepared: true, actionKind: "select-research", planToken: token, expiresAtUtc: new Date(now + 30000).toISOString(), expectedStateHash: nativeResearchStateHash({ kind: "select-research", ...scope }), stateHashVersion: 1, researchQueueReadbackVersion: 1, commitAllowedNow: true, itemBudget: budget(), commitBlockers: [] });
	const ledger = open();
	t.after(async () => { stores.forEach((store) => store.close()); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-game-ledger-")); await rm(absolute, { recursive: true, force: true }); });
	const approve = async (store = ledger, extra = {}) => { const task = store.createResearchTask({ ...scope, ...extra }), review = await store.prepare(task.id); store.approve(authority, task.id, review.previewHash); return { task, review }; };
	return { directory, file, authority, scope, context, plan, budget, token, ledger, open, approve, setPrepareReply: (callback) => { prepareReply = callback; }, setProofReply: (callback) => { proofReply = callback; }, advance: (ms) => { now += ms; } };
}
function acceptance(intent, extra = {}) { return { accepted: true, actionKind: "select-research", actionId: "action-fixture", idempotencyKey: intent.idempotencyKey, ...extra }; }
function completion(f, intent, extra = {}) {
	return { actionId: "action-fixture", actionKind: "select-research", sessionId: f.scope.sessionId, planetId: f.scope.planetId, idempotencyKey: intent.idempotencyKey, terminal: true, succeeded: true, state: "completed", completedAtGameTick: 1201, researchQueueReadback: { capturedAtGameTick: 1201, beforeQueue: [99], afterQueue: [99, 100], previousCurrentTechId: 99, currentTechId: 99, inventoryPreserved: true, researchProgressPreserved: true }, ...extra };
}
const progression = (f, extra = {}) => ({ sessionId: f.scope.sessionId, planetId: f.scope.planetId, capturedAtGameTick: 1202, observedAt: f.context().observedAt, selectionStateHash: "sha256:" + "b".repeat(64), techQueue: [99, 100], ...extra });

test("usage survives transcript pruning and ledger reopen without modifying action or approval state", async t => {
	const f = await fixture(t), task = f.ledger.createResearchTask(f.scope);
	f.ledger.details(task.id, { mode: "observe", model: "fixture", provider: "synthetic" });
	const original = f.ledger.task(task.id), usage = new ModelUsage({ pricing: { input: 2 }, publish: value => f.ledger.note(task.id, "usage", { ...value, private: "PRIVATE_TEXT" }) });
	usage.finish(usage.start(), { usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100 } });
	for (let i = 0; i < 205; i++) f.ledger.note(task.id, "assistant", { text: "synthetic" });
	assert.equal(f.ledger.events(task.id).some(event => event.kind === "usage"), false);
	assert.deepEqual(f.ledger.task(task.id), original); assert.deepEqual(f.ledger.tasks()[0].details.usage, usage.snapshot());
	assert.throws(() => f.ledger.note(task.id, "usage", { version: 1, requests: 100 }), /INVALID_MODEL_USAGE/);
	f.ledger.close(); const reopened = f.open();
	assert.deepEqual(reopened.tasks()[0].details.usage, usage.snapshot()); assert.deepEqual(reopened.task(task.id), original); assert.deepEqual(reopened.unresolved(), []);
	assert.ok(!JSON.stringify(reopened.tasks()).includes("PRIVATE_TEXT"));
});
const resultContext = (f) => ({ ...f.context(), gameTick: 1202, selectionStateHash: "sha256:" + "b".repeat(64) });

test("research approval binds an immutable one-write scope and cannot be forged with model JSON", async (t) => {
	const f = await fixture(t), task = f.ledger.createResearchTask({ ...f.scope, maximumAcceptedWrites: 999, planToken: f.token });
	assert.equal(task.scope.maximumAcceptedWrites, 1); assert.equal(task.scope.planToken, undefined);
	const review = await f.ledger.prepare(task.id);
	assert.throws(() => f.ledger.approve({ userConfirmed: true }, task.id, review.previewHash), /TRUSTED_USER_APPROVAL_REQUIRED/);
	assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, f.context()), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.throws(() => f.ledger.approve(f.authority, task.id, "0".repeat(64)), /FRESH_RESEARCH_PREVIEW_REQUIRED/);
	f.ledger.approve(f.authority, task.id, review.previewHash); const intent = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	assert.equal(intent.commit.planToken, f.token); assert.equal(f.ledger.unresolved().length, 1);
	assert.match(intent.idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); assert.equal(intent.commit.idempotencyKey, intent.idempotencyKey);
	assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, f.context()), /UNRESOLVED_GAME_INTENT/);
});
test("a same-hash plan for research B cannot be attached to research A by a caller-supplied response", async (t) => {
	const f = await fixture(t), task = f.ledger.createResearchTask(f.scope); let actual;
	f.setPrepareReply((request) => { actual = request; assert.ok(Object.isFrozen(request)); assert.ok(Object.isFrozen(request.arguments)); return { request: { ...request, arguments: { ...request.arguments, techId: 101 } }, plan: { ...f.plan(), planToken: "synthetic-plan-for-research-B" } }; });
	await assert.rejects(f.ledger.prepare(task.id), /RESEARCH_PREPARE_CORRELATION_MISMATCH/);
	assert.equal(actual.arguments.techId, 100); assert.equal(actual.arguments.sessionId, f.scope.sessionId); assert.equal(actual.arguments.planetId, 1); assert.equal(actual.arguments.expectedSelectionStateHash, f.scope.selectionStateHash);
	assert.equal(f.ledger.preview, undefined); assert.equal(f.ledger.task(task.id).approvalId, null); assert.equal(f.ledger.unresolved().length, 0);
});
test("native action hash must bind the exact approved research scope rather than equal the selection hash", async (t) => {
	const f = await fixture(t);
	for (const change of [{ sessionId: "different-session" }, { planetId: 2 }, { techId: 101 }, { selectionStateHash: "sha256:" + "b".repeat(64) }]) {
		const task = f.ledger.createResearchTask(f.scope);
		f.setPrepareReply((request) => ({ request, researchBudget: f.budget(), plan: { ...f.plan(), expectedStateHash: nativeResearchStateHash({ kind: "select-research", ...f.scope, ...change }) } }));
		await assert.rejects(f.ledger.prepare(task.id), /RESEARCH_PREVIEW_REJECTED/);
	}
	const task = f.ledger.createResearchTask(f.scope);
	f.setPrepareReply((request) => ({ request, researchBudget: f.budget(), plan: { ...f.plan(), expectedStateHash: f.scope.selectionStateHash } }));
	await assert.rejects(f.ledger.prepare(task.id), /RESEARCH_PREVIEW_REJECTED/); assert.equal(f.ledger.unresolved().length, 0);
	for (const input of [{ planetId: 2147483648 }, { techId: 2147483648 }, { techId: "100" }]) assert.throws(() => f.ledger.createResearchTask({ ...f.scope, ...input }), /INVALID_RESEARCH_TASK_SCOPE/);
});
test("previews require explicit native readback support and independently matching fresh bounded budgets", async (t) => {
	const f = await fixture(t);
	for (const version of [undefined, 0, 2, "1"]) {
		const task = f.ledger.createResearchTask(f.scope);
		f.setPrepareReply((request) => ({ request, researchBudget: f.budget(), plan: { ...f.plan(), researchQueueReadbackVersion: version } }));
		await assert.rejects(f.ledger.prepare(task.id), /RESEARCH_READBACK_NOT_SUPPORTED/);
	}
	for (const budget of [undefined, [], [{ ...f.budget()[0], count: 11 }], [{ ...f.budget()[0], itemId: 1203 }], [{ ...f.budget()[0], direction: "consume" }], [...f.budget(), ...f.budget()]]) {
		const task = f.ledger.createResearchTask(f.scope);
		f.setPrepareReply((request) => ({ request, researchBudget: budget, plan: f.plan() }));
		await assert.rejects(f.ledger.prepare(task.id), /RESEARCH_BUDGET_INVALID|RESEARCH_BUDGET_MISMATCH/);
	}
	assert.equal(f.ledger.unresolved().length, 0);
});
test("native plan and budget mutations cannot replace the immutable data bound to user approval", async (t) => {
	const f = await fixture(t), task = f.ledger.createResearchTask(f.scope), native = f.plan(), observed = f.budget();
	f.setPrepareReply((request) => ({ request, plan: native, researchBudget: observed }));
	const review = await f.ledger.prepare(task.id); f.ledger.approve(f.authority, task.id, review.previewHash);
	native.planToken = "different-native-plan-token"; native.itemBudget[0].count = 999; observed[0].name = "changed"; observed[0].count = 999;
	assert.ok(Object.isFrozen(review.researchBudget)); assert.ok(Object.isFrozen(review.researchBudget[0]));
	assert.throws(() => { review.researchBudget[0].count = 999; }, TypeError);
	assert.deepEqual(review.researchBudget, f.budget());
	const intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); assert.equal(intent.commit.planToken, f.token);
});
test("repreparing a changed requirement invalidates the old preview hash and final fresh budget must still match", async (t) => {
	const f = await fixture(t), task = f.ledger.createResearchTask(f.scope), first = await f.ledger.prepare(task.id); f.ledger.approve(f.authority, task.id, first.previewHash);
	const changed = [{ ...f.budget()[0], count: 11 }];
	f.setPrepareReply((request) => ({ request, plan: { ...f.plan(), itemBudget: changed }, researchBudget: changed }));
	const second = await f.ledger.prepare(task.id); assert.notEqual(first.previewHash, second.previewHash);
	assert.throws(() => f.ledger.approve(f.authority, task.id, first.previewHash), /FRESH_RESEARCH_PREVIEW_REQUIRED/);
	f.ledger.approve(f.authority, task.id, second.previewHash);
	for (const value of [undefined, [], f.budget(), [...changed, ...changed], [{ ...changed[0], count: Number.MAX_SAFE_INTEGER + 1 }]]) {
		assert.throws(() => f.ledger.beginIntent(task.id, second.previewHash, { ...f.context(), researchBudget: value }), /RESEARCH_BUDGET_INVALID|RESEARCH_BUDGET_MISMATCH/);
		assert.equal(f.ledger.unresolved().length, 0);
	}
	assert.equal(f.ledger.beginIntent(task.id, second.previewHash, { ...f.context(), researchBudget: changed }).commit.planToken, f.token);
});
test("cancel or expiry while a trusted preparation is in flight cannot produce an approved preview", async (t) => {
	for (const mode of ["cancel", "expiry"]) {
		const f = await fixture(t), task = f.ledger.createResearchTask(f.scope), oldPlan = f.plan(); let enter, release; const entered = new Promise((done) => { enter = done; });
		f.setPrepareReply(async (request) => { enter(); await new Promise((done) => { release = done; }); return { request, plan: oldPlan }; });
		const preparing = f.ledger.prepare(task.id), rejected = assert.rejects(preparing, /RESEARCH_PREPARE_CORRELATION_MISMATCH|RESEARCH_PREVIEW_REJECTED/); await entered;
		if (mode === "cancel") f.ledger.stop(task.id); else f.advance(31000); release(); await rejected; assert.equal(f.ledger.task(task.id).approvalId, null);
	}
});
test("expired previews, stale observations, changed sessions and cancelled tasks refuse before any intent", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve();
	for (const extra of [{ sessionId: "another-world" }, { bridgeInstanceId: "new-process" }, { writeHealth: "quarantined" }, { observedAt: 0 }, { selectionStateHash: "sha256:" + "c".repeat(64) }]) assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, { ...f.context(), ...extra }), /GAME_CONTEXT_CHANGED|FRESH_GAME_CONTEXT_REQUIRED/);
	f.advance(31000); assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, f.context()), /FRESH_RESEARCH_APPROVAL_REQUIRED/); assert.equal(f.ledger.unresolved().length, 0);
	const second = await f.approve(); f.ledger.stop(second.task.id); assert.throws(() => f.ledger.beginIntent(second.task.id, second.review.previewHash, f.context()), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
});
test("a storage failure before commit intent prevents transport dispatch and latches the writer closed", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(); let sends = 0;
	f.ledger.db.exec("PRAGMA query_only=ON");
	assert.throws(() => { f.ledger.beginIntent(task.id, review.previewHash, f.context()); sends++; }, /GAME_LEDGER_STORAGE_UNAVAILABLE/);
	f.ledger.db.exec("PRAGMA query_only=OFF"); assert.equal(sends, 0); assert.equal(f.ledger.unresolved().length, 0);
	assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, f.context()), /GAME_LEDGER_STORAGE_UNAVAILABLE/);
});

test("a bounded real SQLITE_FULL during acceptance rolls back the receipt and preserves the original pending intent across reopen", async t => {
	const f = await fixture(t, { pageSize: 512 }), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	const original = f.ledger.intent(intent.intentId), receipt = acceptance(intent, { actionId: "a".repeat(128) }), db = f.ledger.db;
	db.exec("VACUUM"); assert.equal(db.prepare("PRAGMA page_size").get().page_size, 512); assert.equal(db.prepare("PRAGMA freelist_count").get().freelist_count, 0);
	const pages = db.prepare("PRAGMA page_count").get().page_count; assert.ok(pages > 0 && pages < 128); db.exec("PRAGMA max_page_count=" + pages);
	// Calibrate the actual engine failure on this bounded fixture before checking
	// the public ledger path. No filesystem is filled and no host quota is changed.
	db.exec("BEGIN IMMEDIATE");
	try { assert.throws(() => db.prepare("UPDATE game_intents SET action_id=?,acceptance=? WHERE id=?").run(receipt.actionId, JSON.stringify(receipt), intent.intentId), error => error.errcode === 13 && /full/i.test(error.message)); }
	finally { try { db.exec("ROLLBACK"); } catch {} } // SQLITE_FULL may already have rolled the transaction back.
	assert.deepEqual(f.ledger.intent(intent.intentId), original);
	assert.throws(() => f.ledger.accept(intent.intentId, receipt), /GAME_LEDGER_STORAGE_UNAVAILABLE/); assert.equal(f.ledger.storageAvailable, false); assert.deepEqual(f.ledger.intent(intent.intentId), original);
	db.exec("PRAGMA max_page_count=1073741823"); assert.throws(() => f.ledger.accept(intent.intentId, receipt), /GAME_LEDGER_STORAGE_UNAVAILABLE/);
	f.ledger.close(); const reopened = f.open(); assert.equal(reopened.storageAvailable, true); assert.deepEqual(reopened.unresolved()[0], original);
	await assert.rejects(reopened.reconcile(intent.intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.equal(reopened.task(task.id).state, "intent_recorded");
});
test("lost ACK remains blocked after reopening and never receives a new commit key", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), first = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	let sends = 1; f.ledger.markUnknown(first.intentId); f.ledger.close(); const reopened = f.open();
	assert.equal(reopened.unresolved()[0].idempotencyKey, first.idempotencyKey);
	assert.throws(() => reopened.reconciliationRequest(first.intentId, f.context()), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/);
	const next = await f.approve(reopened); assert.throws(() => { reopened.beginIntent(next.task.id, next.review.previewHash, f.context()); sends++; }, /UNRESOLVED_GAME_INTENT/); assert.equal(sends, 1);
});
test("an approval and token from a previous runtime cannot authorize a new intent", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(); f.ledger.close(); const reopened = f.open();
	assert.throws(() => reopened.beginIntent(task.id, review.previewHash, f.context()), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.throws(() => reopened.approve(f.authority, task.id, review.previewHash), /FRESH_RESEARCH_PREVIEW_REQUIRED/);
	assert.equal(reopened.unresolved().length, 0);
});
test("only the retained original action can reconcile and duplicate ACKs cannot change its identity", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	f.ledger.accept(intent.intentId, acceptance(intent)); f.ledger.accept(intent.intentId, acceptance(intent));
	assert.deepEqual(f.ledger.reconciliationRequest(intent.intentId, f.context()), { actionId: "action-fixture" });
	assert.throws(() => f.ledger.reconciliationRequest(intent.intentId, { ...f.context(), bridgeInstanceId: "different-process" }), /GAME_CONTEXT_CHANGED/);
	assert.throws(() => f.ledger.accept(intent.intentId, acceptance(intent, { actionId: "other-action" })), /ACCEPTANCE_BINDING_MISMATCH/);
	assert.equal(f.ledger.intent(intent.intentId).actionId, "action-fixture");
	f.ledger.markUnknown(intent.intentId); await assert.rejects(f.ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
});
test("cancel after acceptance stops scheduling but retains the action for terminal and queue readback", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	f.ledger.accept(intent.intentId, acceptance(intent)); assert.equal(f.ledger.stop(task.id).state, "reconciling");
	f.setProofReply((request) => ({ request, terminal: completion(f, intent), freshProgression: progression(f, { techQueue: [100] }), context: resultContext(f) }));
	const completed = await f.ledger.reconcile(intent.intentId);
	assert.equal(completed.state, "completed"); assert.equal(f.ledger.task(task.id).state, "completed"); assert.equal(f.ledger.unresolved().length, 0);
	assert.throws(() => f.ledger.beginIntent(task.id, review.previewHash, f.context()), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
});
test("native unknown, missing material preservation or missing fresh target never qualifies as success", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent));
	for (const [terminal, fresh] of [[completion(f, intent, { researchQueueReadback: { ...completion(f, intent).researchQueueReadback, inventoryPreserved: false } }), progression(f)], [completion(f, intent), progression(f, { techQueue: [] })], [completion(f, intent), progression(f, { observedAt: 0 })]]) { f.setProofReply((request) => ({ request, terminal, freshProgression: fresh, context: resultContext(f) })); await assert.rejects(f.ledger.reconcile(intent.intentId), /RESEARCH_TERMINAL_PROOF_INCOMPLETE/); }
	assert.equal(f.ledger.unresolved()[0].state, "unknown");
});
test("native unknown or recovery outcomes require independent audit even if a later reply looks successful", async (t) => {
	for (const state of ["outcome_unknown", "recovery_required", "action_failed"]) {
		const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent));
		f.setProofReply((request) => ({ request, terminal: completion(f, intent, { state }), freshProgression: progression(f), context: resultContext(f) }));
		await assert.rejects(f.ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
		f.ledger.markUnknown(intent.intentId); f.setProofReply((request) => ({ request, terminal: completion(f, intent), freshProgression: progression(f), context: resultContext(f) }));
		await assert.rejects(f.ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/); assert.equal(f.ledger.unresolved()[0].state, "unknown");
	}
});
test("a received terminal for the wrong native identity hard-latches before ordinary context or later proof", async (t) => {
	for (const extra of [{ actionId: "wrong-action" }, { actionKind: "build" }, { sessionId: "wrong-native-session" }, { planetId: 2 }, { idempotencyKey: "wrong-key" }]) {
		const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent));
		f.setProofReply((request) => ({ request, terminal: completion(f, intent, extra), freshProgression: progression(f), context: resultContext(f) }));
		await assert.rejects(f.ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
		f.setProofReply(() => { throw new Error("MUST_NOT_READ_AGAIN"); }); await assert.rejects(f.ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
		f.ledger.close(); const reopened = f.open(); await assert.rejects(reopened.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/);
	}
});

test("proof request identity, local receive age and matching fresh hashes are all required", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent));
	assert.equal(f.ledger.complete, undefined);
	for (const mode of ["old-request", "old-time", "wrong-hash", "wrong-session"]) {
		f.setProofReply((request) => ({ request: mode === "old-request" ? { ...request, requestId: "cached-request" } : request, terminal: completion(f, intent), freshProgression: progression(f, mode === "old-time" ? { observedAt: 0 } : {}), context: { ...resultContext(f), ...(mode === "wrong-hash" ? { selectionStateHash: "sha256:" + "c".repeat(64) } : mode === "wrong-session" ? { sessionId: "different-world" } : {}) } }));
		await assert.rejects(f.ledger.reconcile(intent.intentId), /RESEARCH_READ_CORRELATION_MISMATCH|RESEARCH_TERMINAL_PROOF_INCOMPLETE|GAME_CONTEXT_CHANGED/); assert.equal(f.ledger.unresolved().length, 1);
	}
	f.setProofReply((request) => ({ request, terminal: completion(f, intent), freshProgression: progression(f), context: resultContext(f) })); assert.equal((await f.ledger.reconcile(intent.intentId)).state, "completed");
});
test("separate ledger instances cannot admit a second unresolved writer", async (t) => {
	const f = await fixture(t), other = f.open(), first = await f.approve(), second = await f.approve(other);
	const intent = f.ledger.beginIntent(first.task.id, first.review.previewHash, f.context());
	assert.throws(() => other.beginIntent(second.task.id, second.review.previewHash, f.context()), /UNRESOLVED_GAME_INTENT/);
	assert.equal(other.unresolved()[0].intentId, intent.intentId);
});
test("a reopened journal can only poll and reconcile its persisted original action", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent)); f.ledger.markUnknown(intent.intentId); f.ledger.close();
	const reopened = f.open(); assert.equal((await reopened.reconcile(intent.intentId)).state, "completed");
	assert.deepEqual(reopened.reconciliationRequest(intent.intentId, f.context()), { actionId: "action-fixture" });
	const once = reopened.intent(intent.intentId); assert.deepEqual(await reopened.reconcile(intent.intentId), once);
});
test("legacy pending keys remain unchanged and reconcile only their original action after reopening", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()), legacyKey = "commanddeck-" + randomUUID();
	// Represent a pre-fix persisted record without changing its historical acceptance or action identity.
	f.ledger.db.prepare("UPDATE game_intents SET idempotency_key=? WHERE id=?").run(legacyKey, intent.intentId);
	f.ledger.accept(intent.intentId, acceptance({ ...intent, idempotencyKey: legacyKey })); f.ledger.close();
	const reopened = f.open(); assert.equal(reopened.unresolved()[0].idempotencyKey, legacyKey);
	f.setProofReply((request) => { assert.equal(request.idempotencyKey, legacyKey); assert.equal(request.actionId, "action-fixture"); return { request, terminal: completion(f, reopened.intent(request.intentId)), freshProgression: progression(f), context: resultContext(f) }; });
	const done = await reopened.reconcile(intent.intentId); assert.equal(done.state, "completed"); assert.equal(done.idempotencyKey, legacyKey);
});
test("short tokens and extra native credential fields are absent from persisted task and receipt bytes", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context());
	f.ledger.accept(intent.intentId, { ...acceptance(intent), planToken: f.token });
	f.setProofReply((request) => ({ request, terminal: completion(f, intent, { flightCheckpointReloadToken: "PRIVATE_NATIVE_CREDENTIAL" }), freshProgression: progression(f), context: resultContext(f) }));
	await f.ledger.reconcile(intent.intentId);
	assert.ok(!JSON.stringify([f.ledger.task(task.id), f.ledger.intent(intent.intentId)]).includes(f.token));
	f.ledger.close(); const bytes = await readFile(f.file); assert.ok(!bytes.includes(Buffer.from(f.token))); assert.ok(!bytes.includes(Buffer.from("PRIVATE_NATIVE_CREDENTIAL")));
});
test("v1 ledger migration preserves the exact pending action, key and scope while adding display storage", async (t) => {
	const f = await fixture(t), { task, review } = await f.approve(), intent = f.ledger.beginIntent(task.id, review.previewHash, f.context()); f.ledger.accept(intent.intentId, acceptance(intent)); f.ledger.close();
	const old = new DatabaseSync(f.file); old.exec("DROP TABLE game_task_events; DROP TABLE game_task_details; PRAGMA user_version=1"); old.close();
	const reopened = f.open(); assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, 2); assert.equal(reopened.unresolved()[0].idempotencyKey, intent.idempotencyKey); assert.equal(reopened.unresolved()[0].actionId, "action-fixture"); assert.deepEqual(reopened.task(task.id).scope, task.scope); assert.deepEqual(reopened.events(task.id), []);
});

test("future journal schemas are refused without resetting the existing file", async (t) => {
	const f = await fixture(t); f.ledger.close(); const db = new DatabaseSync(f.file); db.exec("PRAGMA user_version=99"); db.close(); const before = await readFile(f.file);
	assert.throws(() => f.open(), /GAME_LEDGER_SCHEMA_UNSUPPORTED/); assert.deepEqual(await readFile(f.file), before);
});
