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
