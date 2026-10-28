import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { assertPortableDevelopmentUsageAction, portableDevelopmentUsageCase, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { contextSeedPrompt, contextContinuePrompt, contextCompactPrompt, assertContextFixtureTask } from "../apps/desktop/development-context-case.mjs";
import { readDevelopmentContextOriginal, developmentContextOriginalFile } from "../apps/desktop/development-context-recovery.mjs";
import { profileHash } from "../apps/desktop/portable-profile.mjs";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";
import { contextInterruptionOriginalFile, readContextInterruptionOriginal, assertRecoveredContextRecord } from "../apps/desktop/development-context-interruption.mjs";
import { assertContextInterruptionRows } from "../scripts/development-context-interruption-case.mjs";
import { WorkbenchStore } from "../apps/desktop/workbench-store.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { const absolute = await realpath(root); assert.equal(absolute, root); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-desktop-smoke-")); await rm(absolute, { recursive: true, force: true }); }); return { root, runId };
}
test("context packaged phases require explicit isolation and reject mixed modes", async t => {
	const context = await fixture(t), env = { COMMANDDECK_PORTABLE_ROOT: context.root, COMMANDDECK_PORTABLE_RUN_ID: context.runId }, app = { isPackaged: true, setPath() {} };
	for (const phase of ["record", "reopen"]) { const args = ["--portable-smoke", "--portable-development-usage=context-" + phase]; assert.deepEqual(portableDevelopmentUsageCase(args), { phase, context: true }); await preparePortableMode(app, args, env); }
	for (const args of [["--portable-development-usage=context-record"], ["--portable-smoke", "--portable-development-usage=context-record", "--portable-development-usage=record"], ["--portable-smoke", "--portable-development-usage=context-record", "--portable-mcp-loss=accepted"]]) assert.throws(() => portableDevelopmentUsageCase(args));
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-development-usage=context-record", "--smoke-workbench"], env));
});

test("context fixture admits exactly three fixed lineage steps and no execution after reopen", () => {
	const rootId = randomUUID(), profileId = "deckvault-" + randomUUID(), tasks = [randomUUID(), randomUUID(), randomUUID()], hash = "a".repeat(64), base = { rootId, providerId: profileId, modelId: "fixture" };
	for (let stage = 0; stage < 3; stage++) {
		const args = { ...base, prompt: [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt][stage], ...(stage ? { contextMode: stage === 1 ? "continue" : "compact", sourceTaskId: tasks[stage - 1], sourceSha256: hash } : {}) }, state = { rootId, profileId, tasks: tasks.slice(0, stage) };
		assertContextFixtureTask(args, state); assertPortableDevelopmentUsageAction("workbench", { action: "agent", args }, { phase: "record", context: true, rootId, profileId, contextTasks: state.tasks });
		for (const patch of [{ rootId: randomUUID() }, { providerId: "external" }, { prompt: "arbitrary request" }, { parentId: tasks[0] }, { sourceTaskId: randomUUID() }, { sourceSha256: "bad" }]) assert.throws(() => assertContextFixtureTask({ ...args, ...patch }, state));
		assert.throws(() => assertContextFixtureTask(args, { ...state, pending: true })); assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "agent", args }, { phase: "reopen", context: true, rootId, profileId, contextTasks: state.tasks }));
	}
	assert.throws(() => assertContextFixtureTask({ ...base, prompt: contextCompactPrompt }, { rootId, profileId, tasks }));
	const state = { phase: "record", context: true, rootId, profileId, contextTasks: tasks };
	assertPortableDevelopmentUsageAction("workbench", { action: "context-info", args: { rootId, taskId: tasks[0] } }, state);
	assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "context-info", args: { rootId, taskId: randomUUID() } }, state));
	for (const [action, args] of [["workbench", { action: "grants", args: { rootId, canWrite: true } }], ["workbench", { action: "check", args: { rootId, checkId: "npm:test" } }], ["game", { action: "start" }], ["probe", { mode: "offline" }], ["profiles-manage", { action: "save", args: { id: profileId } }]]) assert.throws(() => assertPortableDevelopmentUsageAction(action, args, state));
});

test("context originals bind task lineage and original usage as inert data without rewriting malformed evidence", async t => {
	const context = await fixture(t), rootId = randomUUID(), provider = "deckvault-" + randomUUID(), ids = Array.from({ length: 3 }, () => randomUUID()), infos = ids.map((sourceTaskId, index) => ({ sourceTaskId, sourceSha256: String(index + 1).repeat(64) }));
	const records = ids.map((id, index) => {
		const usage = new ModelUsage({ pricing: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, publish() {} }); for (let request = 0; request < (index === 2 ? 3 : 1); request++) usage.finish(usage.start(), { usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 } });
		return { id, rootId, parentId: index ? ids[index - 1] : null, kind: "agent", state: "succeeded", provider, model: "fixture", prompt: [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt][index], scope: index ? { context: { sourceTaskId: ids[index - 1], sourceSha256: infos[index - 1].sourceSha256, mode: index === 1 ? "continue" : "compact" } } : {}, changes: [], invocations: index === 2 ? [{ name: "workspace_read", state: "completed", arguments: { path: "fixture.txt" } }] : [], usage: usage.snapshot(), result: index === 2 ? { contextManagement: { compacted: true, compactionRequests: 1, tokensBefore: 90, estimatedTokensAfter: 20 } } : {} };
	});
	const expected = { roots: [{ id: rootId, path: join(context.root, "development-usage-workspace"), canWrite: false, canExecute: false }], tasks: ids.map(id => ({ id })), records, infos, selection: { rootId, taskId: ids[2] }, draft: { prompt: contextCompactPrompt } }, value = { version: 1, kind: "synthetic-development-context", runId: context.runId, expected, sha256: profileHash(expected) }, file = join(context.root, developmentContextOriginalFile);
	await writeFile(file, JSON.stringify(value)); assert.deepEqual(await readDevelopmentContextOriginal(context), value);
	for (const change of [data => { data.expected.records[1].parentId = ids[2]; }, data => { data.expected.roots[0].canWrite = true; }, data => { data.expected.records[2].usage.requests = 6; }, data => { data.command = "PRIVATE_EXECUTION_TEXT"; }, data => { data.runId = randomUUID(); }]) {
		const broken = structuredClone(value); change(broken); broken.sha256 = profileHash(broken.expected); const text = JSON.stringify(broken); await writeFile(file, text); await assert.rejects(readDevelopmentContextOriginal(context)); assert.equal(await readFile(file, "utf8"), text);
	}
});

test("context interruption phases retain exact three-task admission and close both recovery launches", async t => {
	const context = await fixture(t), env = { COMMANDDECK_PORTABLE_ROOT: context.root, COMMANDDECK_PORTABLE_RUN_ID: context.runId }, app = { isPackaged: true, setPath() {} };
	const rootId = randomUUID(), profileId = "deckvault-" + randomUUID();
	for (const phase of ["record", "recover", "reopen"]) {
		const args = ["--portable-smoke", "--portable-development-usage=context-interrupt-" + phase], mode = portableDevelopmentUsageCase(args);
		assert.deepEqual(mode, { phase, context: true, interruption: true }); await preparePortableMode(app, args, env);
		const state = { ...mode, rootId, profileId, contextTasks: [], internal: true }, agent = { action: "agent", args: { rootId, providerId: profileId, modelId: "fixture", prompt: contextSeedPrompt } };
		if (phase === "record") assertPortableDevelopmentUsageAction("workbench", agent, state);
		else {
			assert.throws(() => assertPortableDevelopmentUsageAction("workbench", agent, state));
			assert.throws(() => assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: profileId } }, state));
		}
		assert.throws(() => portableDevelopmentUsageCase([...args, "--portable-development-usage=context-record"]));
	}
	assert.throws(() => portableDevelopmentUsageCase(["--portable-development-usage=context-interrupt-record"]));
	assert.throws(() => portableDevelopmentUsageCase(["--portable-smoke", "--portable-development-usage=context-interrupt-unknown"]));
	assert.throws(() => assertPortableDevelopmentUsageAction("model-usage", {}, { phase: "recover", context: true }));
});

test("pending context evidence rejects invented compaction or usage and recovery only changes its terminal record", async t => {
	const context = await fixture(t), rootId = randomUUID(), provider = "deckvault-" + randomUUID(), ids = Array.from({ length: 3 }, () => randomUUID());
	const infos = ids.slice(0, 2).map((sourceTaskId, index) => ({ sourceTaskId, sourceSha256: String(index + 1).repeat(64) })), time = "2026-10-28T01:00:00.000Z";
	const records = ids.map((id, index) => {
		const usage = new ModelUsage({ pricing: { input: 2, output: 10 }, publish() {} }), request = usage.start();
		if (index < 2) usage.finish(request, { usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 } });
		return { id, rootId, parentId: index ? ids[index - 1] : null, kind: "agent", state: index === 2 ? "running" : "succeeded", provider, model: "fixture", prompt: [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt][index], scope: index ? { context: { sourceTaskId: ids[index - 1], sourceSha256: infos[index - 1].sourceSha256, mode: index === 1 ? "continue" : "compact" } } : {}, changes: [], invocations: [], usage: usage.snapshot(), result: null, response: "", error: null, startedAt: time, finishedAt: null, events: [{ sequence: index + 1, kind: "usage", value: usage.snapshot(), createdAt: time }] };
	});
	const expected = { roots: [{ id: rootId, path: join(context.root, "development-usage-workspace"), canWrite: false, canExecute: false }], tasks: records.map(({ id, state }) => ({ id, state })), records, infos, selection: { rootId, taskId: ids[2] }, draft: { prompt: contextCompactPrompt } };
	const value = { version: 1, kind: "synthetic-context-interruption", runId: context.runId, sourceRevision: "a".repeat(40), supervisorPid: 42, expected, sha256: profileHash(expected) }, file = join(context.root, contextInterruptionOriginalFile);
	await writeFile(file, JSON.stringify(value), { flag: "wx" }); assert.deepEqual(await readContextInterruptionOriginal(context), value);
	for (const change of [data => { data.expected.records[2].result = { contextManagement: { compacted: true } }; }, data => { data.expected.records[2].usage.responses = 1; }, data => { data.expected.records[2].usage.tokens = { input: 0, output: 0 }; }, data => { data.expected.records[2].scope.context.sourceSha256 = "c".repeat(64); }, data => { data.expected.records[2].invocations = [{ name: "workspace_read" }]; }, data => { data.command = "UNTRUSTED_TEXT"; }]) {
		const broken = structuredClone(value); change(broken); broken.sha256 = profileHash(broken.expected); const bytes = JSON.stringify(broken); await writeFile(file, bytes); await assert.rejects(readContextInterruptionOriginal(context)); assert.equal(await readFile(file, "utf8"), bytes);
	}
	const before = records[2], after = { ...structuredClone(before), state: "interrupted", error: "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY", finishedAt: time, events: [...before.events, { sequence: 4, kind: "task", value: { state: "interrupted", error: "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY" }, createdAt: time }] };
	assertRecoveredContextRecord(before, after);
	for (const change of [data => { data.usage.pendingResponses = 0; }, data => { data.response = "invented summary"; }, data => { data.result = { contextManagement: { compacted: true } }; }, data => { data.events[0].value = null; }, data => { data.finishedAt = "bad"; }]) { const broken = structuredClone(after); change(broken); assert.throws(() => assertRecoveredContextRecord(before, broken)); }
});

test("raw recovery comparison covers every business row and Pi byte across real Workbench recovery", () => {
	const store = new WorkbenchStore(":memory:");
	try {
		const root = store.upsertRoot({ pathKey: "context-test", path: "context-test", label: "fixture", canWrite: false, canExecute: false, metadata: {} });
		for (let index = 0; index < 3; index++) { const task = store.createTask({ rootId: root.id, kind: "agent" }); store.setTaskState(task.id, "running"); if (index < 2) store.setTaskState(task.id, "succeeded"); }
		const snapshot = () => ({ rows: { game_tasks: [] }, pi: [{ path: "source.jsonl", sha256: "original" }], vault: { sha256: "original" }, world: null, workbench: Object.fromEntries(["roots", "tasks", "events", "invocations", "changes", "ui_state"].map(table => [table, store.db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all().map(row => ({ ...row }))])) });
		const before = snapshot(); assert.equal(store.recoverInterrupted(), 1); const after = snapshot(); assertContextInterruptionRows(before, after); assert.equal(store.recoverInterrupted(), 0); assert.deepEqual(snapshot(), after);
		for (const change of [data => { data.workbench.tasks[0].response = "changed"; }, data => { data.workbench.events[0].value = "changed"; }, data => { data.workbench.roots[0].can_write = 1; }, data => { data.pi[0].sha256 = "changed"; }, data => { data.vault.sha256 = "changed"; }, data => { data.workbench.events.push({ kind: "usage" }); }]) { const broken = structuredClone(after); change(broken); assert.throws(() => assertContextInterruptionRows(before, broken)); }
	} finally { store.close(); }
});
