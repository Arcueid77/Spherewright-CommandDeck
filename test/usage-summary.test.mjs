import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";
import { modelContextSnapshot, sampleModelContext } from "../apps/desktop/model-context.mjs";
import { decodeUsageJson, usageSample, summarizeModelUsage, readModelUsageSummary } from "../apps/desktop/usage-summary.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";

const pricing = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 };
const context = modelContextSnapshot({ version: 1, method: "pi-estimate", stage: "task_end", contextWindow: 8192, estimatedTokens: 4096 });
function usage(rates = pricing, pending = false) {
	const value = new ModelUsage({ pricing: rates, publish() {} }); value.finish(value.start(), { usage: { input: 90, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 120, reasoning: 7 } });
	if (pending) value.start(); return value.snapshot();
}
const sample = rows => usageSample(rows, "2026-10-28T00:00:00.000Z");

test("usage summary adds only latest reported usage and original priced portions; reasoning stays within output", () => {
	const value = summarizeModelUsage({ development: sample([{ provider: "one", model: "a", usage: usage(), context }, { provider: "one", model: "a", usage: usage({ input: 2 }, true) }]), game: sample([{ provider: "two", model: "b", usage: usage(null) }, { provider: "two", model: "b", usage: usage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) }, {}]) });
	assert.equal(value.totals.tasks, 5); assert.equal(value.totals.knownRequests, 5); assert.equal(value.totals.reportedResponses, 4); assert.equal(value.totals.missingResponses, 1);
	assert.deepEqual(value.totals.tokens, { input: 360, output: 80, cacheRead: 40, cacheWrite: 0, totalTokens: 480 });
	assert.ok(Math.abs(value.totals.estimatedUsd - 0.000565) < 1e-12);
	assert.equal(value.totals.estimatedTasks, 2); assert.equal(value.totals.partialEstimateTasks, 1); assert.equal(value.totals.unpricedTasks, 2);
	assert.equal(value.totals.legacyTasks, 1); assert.equal(value.totals.unknownUsageTasks, 2); assert.equal(value.totals.maxContextPercent, 50); assert.equal(value.totals.unknownContexts, 4);
	assert.equal(value.groups.length, 3); assert.equal(value.partialSources, false); assert.equal(value.truncated, false);
});

test("absent, malformed and all-zero usage remain distinct; fabricated costs and private fields cannot enter totals", () => {
	const malformed = [false, "text", {}, { ...usage(), tokens: { ...usage().tokens, totalTokens: 0 } }, { ...usage(), tokens: { input: 7e12, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, totalTokens: 7e12 } }];
	const result = summarizeModelUsage({ development: sample([{ usage: null }, ...malformed.map(usage => ({ usage })), { usage: { ...usage(), estimate: { usd: 999 }, privateText: "PRIVATE_MODEL_TEXT" }, prompt: "PRIVATE_PROMPT", context: { ...context, percent: 999, messages: "PRIVATE_CONTEXT" } }]), game: sample([]) });
	assert.equal(result.totals.invalidTasks, malformed.length); assert.equal(result.totals.legacyTasks, 1); assert.equal(result.totals.recordedTasks, 1); assert.equal(result.totals.tokens.totalTokens, 120); assert.ok(Math.abs(result.totals.estimatedUsd - 0.000385) < 1e-12); assert.equal(result.totals.maxContextPercent, 50);
	assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
	for (const text of ["null", "bad", "".padEnd(65537, "a")]) assert.equal(decodeUsageJson(text), false);
	assert.equal(decodeUsageJson(null), null); assert.deepEqual(decodeUsageJson(JSON.stringify(usage())), usage());
});

test("source limits and failures are explicit, empty samples do not fabricate zero cost", async () => {
	const rows = Array.from({ length: 257 }, () => ({ usage: usage() })), bounded = sample(rows);
	assert.equal(bounded.hasMore, true); assert.equal(bounded.rows.length, 256); assert.throws(() => sample([...rows, {}]), /INVALID_USAGE_SAMPLE/);
	const value = await readModelUsageSummary({ development: async () => bounded, game: () => { throw new Error("PRIVATE_STORAGE_PATH"); } });
	assert.equal(value.totals.tasks, 256); assert.equal(value.truncated, true); assert.equal(value.partialSources, true); assert.equal(value.sources[1].count, null); assert.equal(value.sources[1].hasMore, null); assert.ok(!JSON.stringify(value).includes("PRIVATE_"));
	const empty = summarizeModelUsage({ development: sample([]), game: sample([]) }); assert.equal(empty.totals.tokens, null); assert.equal(empty.totals.estimatedUsd, null); assert.equal(empty.totals.maxContextPercent, null);
	const invalid = summarizeModelUsage({ development: { ...bounded, rows }, game: sample([null]) }); assert.equal(invalid.partialSources, true); assert.equal(invalid.totals.invalidTasks, 1);
});

test("Pi task-end context is numeric metadata only and recomputes percent, including unavailable estimates", () => {
	assert.deepEqual(sampleModelContext({ getContextUsage: () => ({ contextWindow: 8192, tokens: 4096, percent: 1, messages: "PRIVATE_PROMPT" }) }), context);
	assert.deepEqual(sampleModelContext({ getContextUsage() { throw new Error("PRIVATE_FAILURE"); } }), { version: 1, method: "pi-estimate", stage: "task_end", contextWindow: null, estimatedTokens: null, percent: null });
	assert.equal(sampleModelContext({ getContextUsage: () => ({ contextWindow: 8192, tokens: null }) }).percent, null);
	for (const patch of [{ estimatedTokens: -1 }, { contextWindow: 0 }, { contextWindow: 1e15 }, { estimatedTokens: Infinity }, { method: "tokenizer" }, { stage: "live" }]) assert.throws(() => modelContextSnapshot({ ...context, ...patch }), /INVALID_MODEL_CONTEXT/);
	const summary = summarizeModelUsage({ development: sample([{ context }, { context: { ...context, estimatedTokens: 2048 } }, { context: false }, { context: { ...context, estimatedTokens: null } }]), game: sample([]) });
	assert.equal(summary.totals.maxContextPercent, 50); assert.equal(summary.totals.contexts, 3); assert.equal(summary.totals.invalidContexts, 1); assert.equal(summary.totals.unknownContexts, 2);
});

async function storage(t) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-usage-summary-")), stores = [];
	t.after(async () => { for (const store of stores) await store.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-usage-summary-")); await rm(absolute, { recursive: true, force: true }); });
	return { directory, stores };
}
test("workbench reader is bounded, excludes non-agent tasks and reads latest snapshots beyond event pagination without writes", async t => {
	const f = await storage(t), workbench = new Workbench({ directory: f.directory, helperSource: "unused" }); f.stores.push(workbench);
	const store = workbench.store, root = store.upsertRoot({ path: f.directory, pathKey: f.directory, label: "fixture", canWrite: false, canExecute: false, metadata: {} });
	function create(kind = "agent") { const task = store.createTask({ rootId: root.id, kind, prompt: "PRIVATE_PROMPT", provider: "synthetic", model: "fixture" }); store.setTaskState(task.id, "running"); store.setTaskState(task.id, "succeeded"); return task; }
	create("check"); create("edit"); create("revert");
	const task = create(); store.event(task.id, "usage", usage()); for (let i = 0; i < 501; i++) store.event(task.id, "assistant-text", { text: "PRIVATE_MODEL_TEXT" });
	store.event(task.id, "usage", usage(pricing, true)); store.event(task.id, "context", context);
	const changes = store.db.prepare("SELECT total_changes() AS value").get().value;
	const data = await workbench.request("usage-data"), result = summarizeModelUsage({ development: data, game: sample([]) });
	assert.equal(result.totals.tasks, 1); assert.equal(result.totals.knownRequests, 2); assert.equal(result.totals.tokens.totalTokens, 120); assert.equal(result.totals.maxContextPercent, 50); assert.ok(!JSON.stringify(data).includes("PRIVATE_")); assert.deepEqual((await workbench.request("task", { taskId: task.id })).context, context);
	assert.equal(store.db.prepare("SELECT total_changes() AS value").get().value, changes);
	for (let i = 0; i < 256; i++) create(); const limited = await workbench.request("usage-data"); assert.equal(limited.rows.length, 256); assert.equal(limited.hasMore, true); assert.equal(limited.rows.some(row => row.usage), false);
});

test("game reader retains task-end context and latest usage after event trimming and ledger reopen without touching intents", async t => {
	const f = await storage(t), file = join(f.directory, "game.sqlite"), options = { approvalAuthority: {}, prepareResearch: async () => { throw new Error("MUST_NOT_EXECUTE"); }, readResearchProof: async () => { throw new Error("MUST_NOT_EXECUTE"); } };
	let ledger = new GameIntentLedger(file, options);
	try {
		const scope = { bridgeInstanceId: "synthetic-bridge", sessionId: "synthetic-session", planetId: 1, techId: 100, capturedAtGameTick: 1200, selectionStateHash: "sha256:" + "a".repeat(64) }, task = ledger.createResearchTask(scope);
		ledger.details(task.id, { provider: "synthetic", model: "fixture", prompt: "PRIVATE_PROMPT" }); ledger.note(task.id, "usage", usage()); ledger.note(task.id, "context", { ...context, messages: "PRIVATE_CONTEXT" });
		for (let i = 0; i < 201; i++) ledger.note(task.id, "assistant", { text: "PRIVATE_TEXT" });
		assert.ok(!ledger.events(task.id).some(event => ["usage", "context"].includes(event.kind))); ledger.close(); ledger = new GameIntentLedger(file, options);
		const changes = ledger.db.prepare("SELECT total_changes() AS value").get().value, result = summarizeModelUsage({ development: sample([]), game: ledger.usageSample() });
		assert.equal(result.totals.tokens.totalTokens, 120); assert.equal(result.totals.maxContextPercent, 50); assert.ok(!JSON.stringify(result).includes("PRIVATE_")); assert.deepEqual(ledger.unresolved(), []); assert.equal(ledger.db.prepare("SELECT total_changes() AS value").get().value, changes);
		assert.deepEqual(ledger.tasks()[0].details.context, context);
		for (let i = 0; i < 256; i++) ledger.createResearchTask(scope); const limited = ledger.usageSample(); assert.equal(limited.rows.length, 256); assert.equal(limited.hasMore, true); assert.ok(limited.rows.every(row => row.usage === undefined));
	} finally { ledger.close(); }
});
