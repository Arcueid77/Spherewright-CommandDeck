import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { portableDevelopmentUsageCase, assertPortableDevelopmentUsageAction, developmentUsagePrompt, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { prepareDevelopmentUsageCase, developmentWorkspaceState } from "../scripts/development-usage-case.mjs";
import { validateDevelopmentUsageWorkspace, readDevelopmentUsageOriginal, developmentUsageOriginalFile } from "../apps/desktop/development-usage-smoke.mjs";
import { profileHash } from "../apps/desktop/portable-profile.mjs";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { usageRecoveryState } from "../scripts/model-usage-recovery-state.mjs";
import { syntheticProviderScope } from "../apps/desktop/synthetic-scope.mjs";
import { createServer } from "node:http";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { const path = await realpath(root); assert.equal(path, root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith("commanddeck-desktop-smoke-")); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { root, runId };
}
test("development usage requires one explicit packaged phase and cannot mix other portable scenarios", async t => {
	const f = await fixture(t), env = { COMMANDDECK_PORTABLE_ROOT: f.root, COMMANDDECK_PORTABLE_RUN_ID: f.runId }, app = { isPackaged: true, setPath() {} };
	assert.equal(portableDevelopmentUsageCase(["--portable-smoke"]), null);
	for (const phase of ["record", "reopen"]) { const argv = ["--portable-smoke", "--portable-development-usage=" + phase]; assert.deepEqual(portableDevelopmentUsageCase(argv), { phase }); await preparePortableMode(app, argv, env); }
	for (const argv of [["--portable-development-usage=record"], ["--portable-smoke", "--portable-development-usage=unknown"], ["--portable-smoke", "--portable-development-usage=record", "--portable-development-usage=reopen"], ["--portable-smoke", "--portable-development-usage=record", "--portable-mcp-loss=accepted"], ["--portable-smoke", "--portable-development-usage=record", "--portable-command-loss=reload"]]) assert.throws(() => portableDevelopmentUsageCase(argv));
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-development-usage=record", "--smoke-workbench"], env));
});

test("only one fixed read-only development task can start, and the renderer cannot configure a provider or execute checks", () => {
	const context = { phase: "record", rootId: randomUUID(), profileId: "deckvault-" + randomUUID() }, task = { rootId: context.rootId, providerId: context.profileId, modelId: "fixture", prompt: developmentUsagePrompt };
	assertPortableDevelopmentUsageAction("workbench", { action: "agent", args: task }, context);
	for (const patch of [{ rootId: "other" }, { providerId: "external" }, { modelId: "other" }, { prompt: "arbitrary goal" }, { testModelsPath: "PRIVATE_PATH" }]) assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "agent", args: { ...task, ...patch } }, context));
	for (const extra of [{ started: true }, { phase: "reopen" }]) assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "agent", args: task }, { ...context, ...extra }));
	for (const [action, args] of [["workbench", { action: "check", args: { rootId: context.rootId, checkId: "npm:test" } }], ["workbench", { action: "save", args: { rootId: context.rootId } }], ["workbench", { action: "add" }], ["game", { action: "start" }], ["bridge-select", "external.exe"], ["probe", { mode: "offline" }], ["probe", { mode: "live" }], ["profiles-manage", { action: "save", args: { id: context.profileId } }]]) assert.throws(() => assertPortableDevelopmentUsageAction(action, args, context));
	assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: context.profileId } }, { ...context, internal: true });
	assert.throws(() => assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: context.profileId } }, { ...context, internal: true, phase: "reopen" }));
	assertPortableDevelopmentUsageAction("profiles-manage", { action: "describe", args: { id: context.profileId } }, { ...context, internal: true, phase: "reopen" });
});

test("the development synthetic credential still requires its exact owned live loopback listener", async t => {
	const server = createServer((_request, response) => response.end()); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
	const scope = syntheticProviderScope(), id = "deckvault-" + randomUUID(), key = "synthetic-development-smoke-" + randomUUID(); scope.register(server, id, key);
	const profile = { id, key, api: "openai-completions", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1` }; scope.assertResolved(profile);
	assert.throws(() => scope.assertResolved({ ...profile, baseUrl: "https://external.invalid" })); assert.throws(() => scope.assertResolved({ ...profile, key: "another" })); assert.throws(() => scope.assertReference("external", "fixture"));
});

test("an actual owned Git fixture is validated and the development witness preserves all task rows and Pi files", { skip: process.platform !== "win32", timeout: 60000 }, async t => {
	const stage = value => process.stderr.write("DEVELOPMENT_USAGE_STAGE_" + value + "\n");
	stage("PREPARE"); const f = await fixture(t), toolchain = await prepareDevelopmentUsageCase(f.root); stage("PREPARED"); const source = await developmentWorkspaceState(f.root); stage("INVENTORIED");
	assert.equal(await validateDevelopmentUsageWorkspace(f), toolchain.workspace);
	const profile = join(f.root, "supervisor-profile/supervisor"), workbench = new Workbench({ directory: join(profile, "m1-smoke-" + f.runId), helperSource: "unused" });
	try {
		await workbench.add({ path: toolchain.workspace, label: "fixture", canWrite: false, canExecute: false }); stage("REGISTERED");
		const root = workbench.store.roots()[0], task = workbench.store.createTask({ rootId: root.id, kind: "agent", prompt: developmentUsagePrompt, provider: "synthetic", model: "fixture" });
		workbench.store.setTaskState(task.id, "running"); workbench.store.setTaskState(task.id, "succeeded"); workbench.store.saveUi("selection", { rootId: root.id, taskId: task.id });
	} finally { await workbench.close(); }
	stage("CLOSED");
	const game = new GameIntentLedger(join(profile, "game-smoke-" + f.runId, "game-tasks.sqlite"), { approvalAuthority: {}, prepareResearch: async () => { throw new Error("MUST_NOT_EXECUTE"); }, readResearchProof: async () => { throw new Error("MUST_NOT_EXECUTE"); } }); game.close();
	for (const [file, text] of [[join(profile, "m1-smoke-" + f.runId, "agent/original/sessions/original.jsonl"), "synthetic-only"], [join(profile, "vault-smoke-" + f.runId, "profiles.vault.json"), "synthetic-only"]]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); }
	stage("WITNESS"); const before = await usageRecoveryState(f.root, f.runId, { role: "development" }), after = await usageRecoveryState(f.root, f.runId, { role: "development" }); stage("WITNESSED"); assert.deepEqual(after, before); assert.equal(before.workbench.tasks.length, 1); assert.equal(before.world, null); assert.ok(Object.values(before.rows).every(values => values.length === 0)); assert.deepEqual(await developmentWorkspaceState(f.root), source);
	await assert.rejects(usageRecoveryState(f.root, f.runId));
	await writeFile(join(toolchain.workspace, "AGENTS.md"), "Untrusted additional file"); await assert.rejects(validateDevelopmentUsageWorkspace(f));
});

test("development usage originals validate the reported tokens and exact retained task without granting execution", async t => {
	const f = await fixture(t), usage = new ModelUsage({ pricing: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }, publish() {} });
	for (let i = 0; i < 2; i++) usage.finish(usage.start(), { usage: { input: 90, output: 20, cacheRead: 10, cacheWrite: 0, totalTokens: 120, reasoning: 7 } });
	const rootId = randomUUID(), id = randomUUID(), expected = { roots: [{ id: rootId, path: join(f.root, "development-usage-workspace"), canWrite: false, canExecute: false }], tasks: [{ id }], task: { id, rootId, kind: "agent", state: "succeeded", model: "fixture", invocations: [{ name: "workspace_read", state: "completed" }], changes: [], usage: usage.snapshot() }, selection: { rootId, taskId: id }, draft: { prompt: developmentUsagePrompt } };
	const original = { version: 1, kind: "synthetic-development-usage", runId: f.runId, expected, sha256: profileHash(expected) }, file = join(f.root, developmentUsageOriginalFile);
	await writeFile(file, JSON.stringify(original)); assert.deepEqual(await readDevelopmentUsageOriginal(f), original);
	for (const patch of [{ version: 2 }, { runId: randomUUID() }, { sha256: "0".repeat(64) }, { command: "PRIVATE_TEXT" }]) { const text = JSON.stringify({ ...original, ...patch }); await writeFile(file, text); await assert.rejects(readDevelopmentUsageOriginal(f)); assert.equal(await readFile(file, "utf8"), text); }
});
