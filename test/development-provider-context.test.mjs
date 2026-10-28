import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { assertProviderContextTask, providerContextSteps, contextProviderApis, contextProviderSettings, providerContextFailures, providerContextPrefix } from "../apps/desktop/development-provider-context-case.mjs";
import { createProviderContextFixture } from "../apps/desktop/development-provider-context-fixture.mjs";
import { syntheticProviderScope } from "../apps/desktop/synthetic-scope.mjs";
import { portableDevelopmentUsageCase, assertPortableDevelopmentUsageAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { readProviderContextOriginal, providerContextOriginalFile } from "../apps/desktop/development-provider-context-smoke.mjs";
import { profileHash } from "../apps/desktop/portable-profile.mjs";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";

async function owned(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { assert.equal(await realpath(root), root); assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(root).startsWith("commanddeck-desktop-smoke-")); await rm(root, { recursive: true, force: true }); }); return { root, runId };
}

test("cross-provider fixture has exactly five fixed source/model steps and no pending or sixth admission", () => {
	const rootId = randomUUID(), profiles = ["deckvault-" + randomUUID(), "deckvault-" + randomUUID()], tasks = providerContextSteps.map(() => randomUUID());
	for (const [index, step] of providerContextSteps.entries()) {
		const args = { rootId, providerId: profiles[step.provider], modelId: "fixture", prompt: step.prompt, ...(step.source === null ? {} : { contextMode: step.mode, sourceTaskId: tasks[step.source], sourceSha256: "a".repeat(64) }) }, context = { rootId, profiles, tasks: tasks.slice(0, index) };
		assertProviderContextTask(args, context);
		for (const patch of [{ providerId: profiles[1 - step.provider] }, { rootId: randomUUID() }, { prompt: "arbitrary request" }, { parentId: randomUUID() }, { sourceTaskId: randomUUID() }, { sourceSha256: "bad" }]) assert.throws(() => assertProviderContextTask({ ...args, ...patch }, context));
		assert.throws(() => assertProviderContextTask(args, { ...context, pending: true }));
		assert.throws(() => assertProviderContextTask(args, { ...context, profiles: [profiles[0], profiles[0]] }));
	}
	assert.throws(() => assertProviderContextTask({}, { rootId, profiles, tasks }));
});

test("two synthetic APIs require distinct owned listeners and never exchange profile keys or bindings", async t => {
	const fixture = await createProviderContextFixture("fixture.txt"); t.after(() => fixture.close());
	const scope = syntheticProviderScope({ multipleApis: true }), single = syntheticProviderScope();
	for (const [index, profile] of fixture.profiles.entries()) {
		scope.register(fixture.servers[index], profile.id, profile.key, profile.api); scope.assertResolved(profile); scope.assertDraft({ ...profile, apiKey: profile.key }); scope.assertReference(profile.id, "fixture");
		if (!index) single.register(fixture.servers[index], profile.id, profile.key); else assert.throws(() => single.register(fixture.servers[index], profile.id, profile.key, profile.api));
	}
	for (const [index, profile] of fixture.profiles.entries()) {
		const other = fixture.profiles[1 - index];
		for (const patch of [{ key: other.key }, { api: other.api }, { baseUrl: other.baseUrl }, { id: other.id }, { modelId: "external" }]) assert.throws(() => scope.assertResolved({ ...profile, ...patch }));
		assert.throws(() => scope.register(fixture.servers[index], "deckvault-" + randomUUID(), profile.key, profile.api));
	}
	await new Promise(resolve => fixture.servers[1].close(resolve)); scope.assertResolved(fixture.profiles[0]); assert.throws(() => scope.assertResolved(fixture.profiles[1]), /SYNTHETIC_PROVIDER_NOT_BOUND/);
});

test("cross-provider package modes remain isolated and reopened profiles cannot authorize execution", async t => {
	const context = await owned(t), env = { COMMANDDECK_PORTABLE_ROOT: context.root, COMMANDDECK_PORTABLE_RUN_ID: context.runId }, app = { isPackaged: true, setPath() {} };
	const rootId = randomUUID(), profiles = ["deckvault-" + randomUUID(), "deckvault-" + randomUUID()], args = { rootId, providerId: profiles[0], modelId: "fixture", prompt: providerContextSteps[0].prompt };
	for (const phase of ["record", "reopen"]) {
		const argv = ["--portable-smoke", "--portable-development-usage=context-providers-" + phase], mode = portableDevelopmentUsageCase(argv);
		assert.deepEqual(mode, { phase, context: true, multipleProviders: true }); await preparePortableMode(app, argv, env);
		const state = { ...mode, rootId, contextProfiles: profiles, internal: true };
		assertPortableDevelopmentUsageAction("profiles-manage", { action: "describe", args: { id: profiles[0] } }, state);
		if (phase === "record") { assertPortableDevelopmentUsageAction("workbench", { action: "agent", args }, state); assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: profiles[1] } }, state); }
		else { assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "agent", args }, state)); assert.throws(() => assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: profiles[1] } }, state)); }
		assert.throws(() => assertPortableDevelopmentUsageAction("profiles-manage", { action: "save", args: { id: profiles[0] } }, { ...state, internal: false }));
		assert.throws(() => assertPortableDevelopmentUsageAction("profiles-manage", { action: "describe", args: { id: "external" } }, state));
		assert.throws(() => portableDevelopmentUsageCase([...argv, "--portable-development-usage=context-record"]));
	}
	assert.throws(() => portableDevelopmentUsageCase(["--portable-development-usage=context-providers-record"]));
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-development-usage=context-providers-record", "--smoke-game"], env));
});

test("summary cancellation is admitted only for the active fixture suffix and never on reopen or HTTP failure", async t => {
	const context = await owned(t), env = { COMMANDDECK_PORTABLE_ROOT: context.root, COMMANDDECK_PORTABLE_RUN_ID: context.runId }, app = { isPackaged: true, setPath() {} }, tasks = providerContextSteps.map(() => randomUUID());
	for (const summaryFailure of providerContextFailures) for (const phase of ["record", "reopen"]) {
		const argv = ["--portable-smoke", "--portable-development-usage=" + providerContextPrefix(summaryFailure) + phase], mode = portableDevelopmentUsageCase(argv);
		assert.deepEqual(mode, { phase, context: true, multipleProviders: true, summaryFailure }); await preparePortableMode(app, argv, env);
		for (const count of [1, 2, 3, 4, 5]) {
			const state = { ...mode, contextTasks: tasks.slice(0, count) }, request = { action: "cancel", args: { taskId: tasks[count - 1] } };
			if (phase === "record" && summaryFailure === "cancel" && count >= 4) {
				assertPortableDevelopmentUsageAction("workbench", request, state);
				for (const patch of [{ contextPending: true }, { phase: "reopen" }, { summaryFailure: null }, { summaryFailure: "http-error" }, { multipleProviders: false }, { context: false }]) assert.throws(() => assertPortableDevelopmentUsageAction("workbench", request, { ...state, ...patch }));
			} else assert.throws(() => assertPortableDevelopmentUsageAction("workbench", request, state));
			for (const args of [{ taskId: randomUUID() }, { taskId: tasks[count - 1], command: "UNTRUSTED_TEXT" }, {}]) assert.throws(() => assertPortableDevelopmentUsageAction("workbench", { action: "cancel", args }, state));
		}
		assert.throws(() => portableDevelopmentUsageCase([...argv, "--portable-development-usage=context-record"]));
	}
	assert.throws(() => providerContextPrefix("arbitrary")); assert.throws(() => portableDevelopmentUsageCase(["--portable-smoke", "--portable-development-usage=context-cancel-recover"]));
});

for (const summaryFailure of [null, ...providerContextFailures]) test("cross-provider original evidence binds sources, API, unknown usage and " + (summaryFailure ?? "successful results"), async t => {
	const context = await owned(t), rootId = randomUUID(), providers = ["deckvault-" + randomUUID(), "deckvault-" + randomUUID()], ids = providerContextSteps.map(() => randomUUID()), infos = ids.map((sourceTaskId, index) => ({ sourceTaskId, sourceSha256: String(index + 1).repeat(64) }));
	const records = providerContextSteps.map((step, index) => {
		const setting = contextProviderSettings[step.provider], usage = new ModelUsage({ pricing: setting.pricing, publish() {} });
		const failure = summaryFailure && step.mode === "compact";
		for (let request = 0; request < (failure ? 1 : step.mode === "compact" ? 3 : 2); request++) usage.finish(usage.start(), failure ? null : { usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25 } });
		return { id: ids[index], rootId, parentId: step.source === null ? null : ids[step.source], kind: "agent", state: failure ? summaryFailure === "cancel" ? "cancelled" : "failed" : "succeeded", ...(failure ? { error: summaryFailure === "cancel" ? "DEVELOPMENT_TASK_CANCELLED" : "DEVELOPMENT_CONTEXT_COMPACTION_FAILED" } : {}), provider: providers[step.provider], model: "fixture", prompt: step.prompt, response: failure ? "" : step.marker + "_DONE", scope: step.source === null ? {} : { context: { mode: step.mode, sourceTaskId: ids[step.source], sourceSha256: infos[step.source].sourceSha256 } }, changes: [], events: [], invocations: failure ? [] : [{ name: "workspace_read", state: "completed", arguments: { path: "fixture.txt" } }], usage: usage.snapshot(), context: { contextWindow: setting.contextWindow }, result: failure ? { outcomeUnknown: false } : { contextManagement: { compacted: step.mode === "compact", compactionRequests: 1, tokensBefore: 90, estimatedTokensAfter: 20 } } };
	});
	const expected = { roots: [{ id: rootId, path: join(context.root, "development-usage-workspace"), canWrite: false, canExecute: false }], tasks: ids.map(id => ({ id })), records, infos, models: providers.map((providerId, index) => ({ providerId, modelId: "fixture", api: contextProviderApis[index] })), selection: { rootId, taskId: ids[4] }, draft: { prompt: providerContextSteps[4].prompt, model: JSON.stringify([providers[0], "fixture"]) } };
	const value = { version: 1, kind: "synthetic-provider-context", runId: context.runId, expected, sha256: profileHash(expected), ...(summaryFailure ? { summaryFailure } : {}) }, file = join(context.root, providerContextOriginalFile);
	await writeFile(file, JSON.stringify(value), { flag: "wx" }); assert.deepEqual(await readProviderContextOriginal(context, { summaryFailure }), value);
	if (summaryFailure) await assert.rejects(readProviderContextOriginal(context));
	for (const change of [data => { data.expected.models[1].api = "openai-completions"; }, data => { data.expected.records[4].parentId = ids[3]; }, data => { data.expected.records[1].usage.pricing.input = 0; }, data => { data.expected.records[3].context.contextWindow = 32768; }, data => { data.expected.records[2].invocations[0].arguments.path = "outside.txt"; }, data => { data.expected.roots[0].canWrite = true; }, data => { data.command = "UNTRUSTED_TEXT"; }, ...(summaryFailure ? [data => { data.expected.records[4].state = "succeeded"; }, data => { data.expected.records[3].result = { contextManagement: { compacted: true } }; }, data => { data.expected.records[4].usage.tokens = { totalTokens: 0 }; }, data => { data.expected.records[3].events.push({ kind: "assistant-text", value: { text: "invented" } }); }, data => { data.summaryFailure = summaryFailure === "cancel" ? "http-error" : "cancel"; }] : [])]) {
		const broken = structuredClone(value); change(broken); broken.sha256 = profileHash(broken.expected); const bytes = JSON.stringify(broken); await writeFile(file, bytes); await assert.rejects(readProviderContextOriginal(context, { summaryFailure })); assert.equal(await readFile(file, "utf8"), bytes);
	}
});
