import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profileHash } from "./portable-profile.mjs";
import { modelUsageSnapshot } from "./model-usage.mjs";
import { createProviderContextFixture, assertProviderContextResult } from "./development-provider-context-fixture.mjs";
import { contextProviderApis, contextProviderSettings, providerContextSteps } from "./development-provider-context-case.mjs";

export const providerContextOriginalFile = "development-provider-context-original.private.json";
export async function readProviderContextOriginal(context) {
	const file = join(context.root, providerContextOriginalFile), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 1048576); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), ["expected", "kind", "runId", "sha256", "version"]); assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-provider-context"); assert.equal(value.runId, context.runId); assert.equal(profileHash(value.expected), value.sha256);
	const { roots, tasks, records, infos, models, selection, draft } = value.expected;
	assert.deepEqual(Object.keys(value.expected).sort(), ["draft", "infos", "models", "records", "roots", "selection", "tasks"]);
	assert.equal(roots.length, 1); assert.equal(roots[0].path, join(context.root, "development-usage-workspace")); assert.equal(roots[0].canWrite, false); assert.equal(roots[0].canExecute, false);
	assert.equal(tasks.length, 5); assert.equal(records.length, 5); assert.equal(infos.length, 5); assert.equal(new Set(records.map(task => task.id)).size, 5); assert.equal(models.length, 2); assert.notEqual(records[0].provider, records[1].provider);
	const providers = [records[0].provider, records[1].provider];
	for (let index = 0; index < 5; index++) {
		const task = records[index], step = providerContextSteps[index], setting = contextProviderSettings[step.provider], usage = modelUsageSnapshot(task.usage);
		assert.match(task.id, /^[a-f0-9-]{36}$/); assert.ok(tasks.some(value => value.id === task.id)); assert.equal(task.kind, "agent"); assert.equal(task.rootId, roots[0].id); assert.equal(task.state, "succeeded"); assert.equal(task.provider, providers[step.provider]); assert.match(task.provider, /^deckvault-[a-f0-9-]{36}$/); assert.equal(task.model, "fixture");
		assert.ok(models.some(model => model.providerId === task.provider && model.modelId === task.model && model.api === contextProviderApis[step.provider]));
		assert.equal(task.prompt, step.prompt); assert.equal(task.response, step.marker + "_DONE"); assert.equal(task.parentId, step.source === null ? null : records[step.source].id); assert.equal(task.changes.length, 0);
		assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].name, "workspace_read"); assert.equal(task.invocations[0].state, "completed"); assert.equal(task.invocations[0].arguments.path, "fixture.txt");
		assert.equal(infos[index].sourceTaskId, task.id); assert.match(infos[index].sourceSha256, /^[a-f0-9]{64}$/); assert.equal(task.context.contextWindow, setting.contextWindow); assert.equal(usage.coverage, "reported"); assert.deepEqual(usage.pricing, setting.pricing);
		if (step.source !== null) { assert.equal(task.scope.context.mode, step.mode); assert.equal(task.scope.context.sourceTaskId, records[step.source].id); assert.equal(task.scope.context.sourceSha256, infos[step.source].sourceSha256); assert.equal(task.result.contextManagement.compacted, step.mode === "compact"); }
		if (step.mode === "compact") { const management = task.result.contextManagement; assert.ok(management.compactionRequests >= 1 && management.compactionRequests <= 2); assert.equal(usage.requests, management.compactionRequests + 2); assert.ok(management.estimatedTokensAfter < management.tokensBefore); }
		else assert.equal(usage.requests, 2);
	}
	assert.equal(selection.rootId, roots[0].id); assert.equal(selection.taskId, records[4].id); assert.equal(draft.prompt, providerContextSteps[4].prompt); assert.equal(draft.model, JSON.stringify([providers[0], "fixture"])); return value;
}

export async function runProviderContextSmoke(driver, manifest) {
	assert.equal(manifest.portableDevelopmentProviderContext, 1); assert.equal(manifest.developmentContextManagement, 1);
	const { context, api, testCommand } = driver, phase = driver.developmentUsageCase.phase, runtime = driver.getRuntimePid(), request = (action, args = {}) => api("workbench", { action, args }), evaluate = source => testCommand("evaluate", { source });
	const registered = await driver.registerDevelopmentUsageWorkspace(), root = registered.roots[0]; let original, exercise = null;
	async function until(predicate, code) { const deadline = performance.now() + 20000; while (!await predicate()) { assert.ok(performance.now() < deadline, code); await new Promise(resolve => setTimeout(resolve, 50)); } }
	async function state(ids) {
		const work = await request("state"); assert.equal(work.activeTask, null); assert.equal(work.executionBlocked, false);
		return JSON.parse(JSON.stringify({ roots: work.roots, tasks: work.tasks, records: await Promise.all(ids.map(taskId => request("task", { taskId }))), infos: await Promise.all(ids.map(taskId => request("context-info", { rootId: root.id, taskId }))), models: await api("profiles"), selection: await request("ui-get", { key: "selection" }), draft: await request("ui-get", { key: "draft" }) }));
	}
	if (phase === "record") {
		assert.deepEqual(registered.tasks, []); assert.deepEqual(await api("profiles"), []); const fixture = await createProviderContextFixture("fixture.txt"), records = [], infos = [];
		try {
			for (const [index, profile] of fixture.profiles.entries()) {
				driver.registerSyntheticProvider(fixture.servers[index], profile.id, profile.key, profile.api);
				const previous = await api("profiles-manage", { action: "list" }), { key, ...draft } = profile;
				await api("profiles-manage", { action: "save", args: { ...draft, apiKey: key, expectedRevision: previous.revision } });
			}
			for (const [index, step] of providerContextSteps.entries()) {
				fixture.begin(index); const profile = fixture.profiles[step.provider]; let taskId;
				if (step.source === null) taskId = (await request("agent", { rootId: root.id, providerId: profile.id, modelId: "fixture", prompt: step.prompt })).id;
				else {
					const source = records[step.source], beforeModel = JSON.stringify([source.provider, "fixture"]), nextModel = JSON.stringify([profile.id, "fixture"]); assert.notEqual(beforeModel, nextModel);
					await request("ui-save", { key: "selection", value: { rootId: root.id, taskId: source.id } }); await request("ui-save", { key: "draft", value: { prompt: step.prompt, model: beforeModel } }); await testCommand("reload");
					await until(() => evaluate("document.querySelector('[aria-label=开发任务]')?.value===" + JSON.stringify(step.prompt) + "&&document.querySelector('[aria-label=开发模型]')?.value===" + JSON.stringify(beforeModel)), "PROVIDER_CONTEXT_DRAFT_NOT_READY");
					await evaluate("(()=>{const model=document.querySelector('[aria-label=开发模型]');model.value=" + JSON.stringify(nextModel) + ";model.dispatchEvent(new Event('change',{bubbles:true}));const mode=document.querySelector('[aria-label=开发上下文模式]');mode.value=" + JSON.stringify(step.mode) + ";mode.dispatchEvent(new Event('change',{bubbles:true}))})()");
					await until(() => evaluate("(()=>{const panel=document.querySelector('.development-panel'),button=[...panel.querySelectorAll('button')].find(value=>value.textContent==='开始任务');if(document.querySelector('[aria-label=开发模型]')?.value!==" + JSON.stringify(nextModel) + "||!panel.textContent.includes(" + JSON.stringify("来源 " + source.id.slice(0, 8)) + ")||!button||button.disabled)return false;button.click();return true})()"), "PROVIDER_CONTEXT_UI_START_NOT_READY");
					await until(async () => { taskId = (await request("state")).tasks.find(task => task.parentId === source.id && !records.some(record => record.id === task.id))?.id; return Boolean(taskId); }, "PROVIDER_CONTEXT_CHILD_NOT_CREATED");
				}
				let task; await until(async () => { task = await request("task", { taskId }); return (await request("state")).activeTask === null && !["queued", "running", "cancelling"].includes(task.state); }, "PROVIDER_CONTEXT_TASK_NOT_SETTLED");
				assertProviderContextResult(task, index, fixture); records.push(task); infos.push(await request("context-info", { rootId: root.id, taskId }));
				for (let previous = 0; previous <= index; previous++) { assert.deepEqual(await request("task", { taskId: records[previous].id }), records[previous]); assert.deepEqual(await request("context-info", { rootId: root.id, taskId: records[previous].id }), infos[previous]); }
			}
			assert.deepEqual(fixture.errors, []); assert.equal(fixture.calls.length, 12); assert.equal(fixture.calls.filter(call => call.summary).length, 2);
			await until(async () => (await request("ui-get", { key: "selection" }))?.taskId === records[4].id, "PROVIDER_CONTEXT_SELECTION_NOT_SAVED");
			exercise = { syntheticModelRequests: fixture.calls.length, compactionRequests: 2, actualToolCalls: 5, uiModelSwitches: 4, crossProviderToolPairsVerified: true, independentCredentialsAndPrices: true, currentReadOnlyTools: true };
			const expected = await state(records.map(task => task.id)); original = { version: 1, kind: "synthetic-provider-context", runId: context.runId, expected, sha256: profileHash(expected) };
			await writeFile(join(context.root, providerContextOriginalFile), JSON.stringify(original), { flag: "wx" });
		} finally { await fixture.close(); }
	} else assert.equal(phase, "reopen");
	original = await readProviderContextOriginal(context); const ids = original.expected.records.map(task => task.id); assert.deepEqual(await state(ids), original.expected);
	async function show() {
		const snapshots = original.expected.records.map(task => modelUsageSnapshot(task.usage)), last = snapshots[4];
		await until(() => evaluate("(()=>{const panel=document.querySelector('.development-panel');return panel?.textContent.includes('压缩后续接自')&&document.querySelector('[aria-label=开发上下文模式]')?.value==='new'&&panel.querySelector('[aria-label=模型用量与费用]')?.textContent.includes(" + JSON.stringify(last.tokens.totalTokens.toLocaleString("zh-CN") + " tokens") + ")})()"), "PROVIDER_CONTEXT_HISTORY_UI_NOT_READY");
		const summary = await api("model-usage"); assert.equal(summary.partialSources, false); assert.equal(summary.truncated, false); assert.equal(summary.totals.tasks, 5); assert.equal(summary.totals.knownRequests, 12); assert.equal(summary.groups.length, 2);
		assert.equal(summary.totals.tokens.totalTokens, snapshots.reduce((sum, usage) => sum + usage.tokens.totalTokens, 0)); assert.ok(Math.abs(summary.totals.estimatedUsd - snapshots.reduce((sum, usage) => sum + usage.estimate.usd, 0)) < 1e-12);
		for (const group of summary.groups) { const selected = original.expected.records.filter(task => task.provider === group.provider); assert.equal(group.tasks, selected.length); assert.equal(group.knownRequests, selected.reduce((sum, task) => sum + task.usage.requests, 0)); }
		let opened = false; await until(async () => {
			if (!opened) opened = await evaluate("(()=>{const button=[...document.querySelectorAll('header button')].find(value=>value.textContent==='用量汇总');if(!button||button.disabled)return false;button.click();return true})()");
			return opened && evaluate("(()=>{const panel=document.querySelector('[aria-label=模型用量汇总]');return panel?.querySelector('[data-usage-summary-total]')?.textContent.includes('已读取 5 项任务')&&panel?.querySelectorAll('tbody tr').length===2})()");
		}, "PROVIDER_CONTEXT_SUMMARY_UI_NOT_READY"); return summary.totals;
	}
	const totals = await show();
	const denied = await evaluate("(async()=>{let count=0;for(const call of [()=>window.deck.workbench('agent',{}),()=>window.deck.workbench('check',{}),()=>window.deck.game('start',{}),()=>window.deck.manageProfiles('save',{}),()=>window.deck.probe({mode:'offline'})])try{await call()}catch{count++}return count})()"); assert.equal(denied, 5);
	await testCommand("reload"); assert.deepEqual(await show(), totals); assert.deepEqual(await state(ids), original.expected); assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), 0);
	const game = await api("game", { action: "snapshot" }), bridge = await api("bridge", { action: "snapshot" }); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null); assert.equal(bridge.observation, null);
	const proof = { version: 1, runId: context.runId, phase, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, expectedSha256: original.sha256, packaged: true, syntheticOnly: true, originalTasksAndContextsRetained: true, originalPricesAndModelLimitsRetained: true, bidirectionalContinuationAndCompaction: true, uiReloadDoesNotReplay: true, newExecutionRejected: true, noMcpSelected: true, noProbeAllocated: true, readOnlyWorkspace: true, wholeApplicationRestartVerified: phase === "reopen", syntheticModelRequests: exercise?.syntheticModelRequests ?? 0, actualToolCalls: phase === "record" ? 5 : 0, totals, exercise, apis: contextProviderApis, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false };
	await writeFile(join(context.root, "development-context-providers-" + phase + "-proof.json"), JSON.stringify(proof), { flag: "wx" }); return proof;
}
