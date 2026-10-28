import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profileHash } from "./portable-profile.mjs";
import { modelUsageSnapshot } from "./model-usage.mjs";
import { runDevelopmentContextSmoke } from "./development-context-smoke.mjs";
import { contextSeedPrompt, contextContinuePrompt, contextCompactPrompt } from "./development-context-case.mjs";

export const developmentContextOriginalFile = "development-context-original.private.json";
export async function readDevelopmentContextOriginal(context) {
	const file = join(context.root, developmentContextOriginalFile), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 524288); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), ["expected", "kind", "runId", "sha256", "version"]); assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-development-context"); assert.equal(value.runId, context.runId); assert.equal(profileHash(value.expected), value.sha256);
	const { roots, tasks, records, infos, selection, draft } = value.expected;
	assert.deepEqual(Object.keys(value.expected).sort(), ["draft", "infos", "records", "roots", "selection", "tasks"]);
	assert.equal(roots.length, 1); assert.equal(roots[0].path, join(context.root, "development-usage-workspace")); assert.equal(roots[0].canWrite, false); assert.equal(roots[0].canExecute, false); assert.equal(tasks.length, 3); assert.equal(records.length, 3); assert.equal(infos.length, 3);
	assert.equal(new Set(records.map(task => task.id)).size, 3);
	for (let index = 0; index < records.length; index++) {
		const task = records[index]; assert.match(task.id, /^[a-f0-9-]{36}$/); assert.ok(tasks.some(value => value.id === task.id)); assert.equal(task.rootId, roots[0].id); assert.equal(task.kind, "agent"); assert.equal(task.state, "succeeded"); assert.equal(task.model, "fixture"); assert.match(task.provider, /^deckvault-[a-f0-9-]{36}$/); assert.equal(task.provider, records[0].provider); assert.equal(task.changes.length, 0);
		assert.equal(infos[index].sourceTaskId, task.id); assert.match(infos[index].sourceSha256, /^[a-f0-9]{64}$/); assert.equal(task.parentId, index ? records[index - 1].id : null); assert.equal(task.prompt, [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt][index]);
		if (index) { assert.equal(task.scope.context.sourceTaskId, records[index - 1].id); assert.equal(task.scope.context.sourceSha256, infos[index - 1].sourceSha256); assert.equal(task.scope.context.mode, index === 1 ? "continue" : "compact"); }
		const usage = modelUsageSnapshot(task.usage); assert.equal(usage.coverage, "reported"); assert.equal(usage.requests, index === 2 ? task.result.contextManagement.compactionRequests + 2 : 1); assert.equal(usage.estimate.status, "estimated");
		assert.equal(task.invocations.length, index === 2 ? 1 : 0);
	}
	const last = records[2], management = last.result.contextManagement;
	assert.equal(management.compacted, true); assert.ok(management.compactionRequests >= 1 && management.compactionRequests <= 2); assert.ok(management.estimatedTokensAfter < management.tokensBefore);
	assert.equal(last.invocations[0].name, "workspace_read"); assert.equal(last.invocations[0].state, "completed"); assert.equal(last.invocations[0].arguments.path, "fixture.txt"); assert.equal(selection.taskId, last.id); assert.equal(selection.rootId, roots[0].id); assert.equal(draft.prompt, contextCompactPrompt);
	return value;
}

export async function runDevelopmentContextRecovery(driver, manifest) {
	assert.equal(manifest.portableDevelopmentContext, 1); assert.equal(manifest.developmentContextManagement, 1);
	const { context, api, testCommand } = driver, phase = driver.developmentUsageCase.phase, runtime = driver.getRuntimePid(), request = (action, args = {}) => api("workbench", { action, args });
	const registered = await driver.registerDevelopmentUsageWorkspace(), root = registered.roots[0]; let exercise = null, original;
	async function state(ids) { const work = await request("state"); assert.equal(work.activeTask, null); assert.equal(work.executionBlocked, false); return JSON.parse(JSON.stringify({ roots: work.roots, tasks: work.tasks, records: await Promise.all(ids.map(taskId => request("task", { taskId }))), infos: await Promise.all(ids.map(taskId => request("context-info", { rootId: root.id, taskId }))), selection: await request("ui-get", { key: "selection" }), draft: await request("ui-get", { key: "draft" }) })); }
	if (phase === "record") {
		assert.deepEqual(registered.tasks, []); let ids;
		exercise = await runDevelopmentContextSmoke(driver, root.id, { readPath: "fixture.txt", readOnlyWorkspace: true, keepProfile: true, onComplete: value => { ids = [value.seed.id, value.continued.id, value.compacted.id]; } });
		const expected = await state(ids); original = { version: 1, kind: "synthetic-development-context", runId: context.runId, expected, sha256: profileHash(expected) };
		await writeFile(join(context.root, developmentContextOriginalFile), JSON.stringify(original), { flag: "wx" });
	} else { assert.equal(phase, "reopen"); original = await readDevelopmentContextOriginal(context); }
	original = await readDevelopmentContextOriginal(context); const ids = original.expected.records.map(task => task.id);
	assert.deepEqual(await state(ids), original.expected);
	async function show() {
		const until = performance.now() + 10000;
		const lastUsage = modelUsageSnapshot(original.expected.records[2].usage);
		while (!await testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('.development-panel'),usage=panel?.querySelector('[aria-label=模型用量与费用]')?.textContent;return panel?.textContent.includes('压缩后续接自')&&document.querySelector('[aria-label=开发上下文模式]')?.value==='new'&&usage?.includes(" + JSON.stringify(lastUsage.tokens.totalTokens.toLocaleString("zh-CN") + " tokens") + ")})()" })) { assert.ok(performance.now() < until, "CONTEXT_REOPEN_UI_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50)); }
		const usage = await api("model-usage"), snapshots = original.expected.records.map(task => modelUsageSnapshot(task.usage));
		assert.equal(usage.partialSources, false); assert.equal(usage.truncated, false); assert.equal(usage.totals.tasks, 3); assert.equal(usage.totals.knownRequests, snapshots.reduce((sum, value) => sum + value.requests, 0)); assert.equal(usage.totals.tokens.totalTokens, snapshots.reduce((sum, value) => sum + value.tokens.totalTokens, 0)); assert.ok(Math.abs(usage.totals.estimatedUsd - snapshots.reduce((sum, value) => sum + value.estimate.usd, 0)) < 1e-12);
		let opened = false;
		while (true) {
			if (!opened) opened = await testCommand("evaluate", { source: "(()=>{const button=[...document.querySelectorAll('header button')].find(value=>value.textContent==='用量汇总');if(!button||button.disabled)return false;button.click();return true})()" });
			if (opened && await testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('[aria-label=模型用量汇总]');return panel?.querySelector('[data-usage-summary-total]')?.textContent.includes('已读取 3 项任务')&&panel?.textContent.includes(" + JSON.stringify(usage.totals.tokens.totalTokens.toLocaleString("zh-CN") + " tokens") + ")&&panel?.querySelector('[data-usage-summary-cost]')?.textContent.includes(" + JSON.stringify(usage.totals.estimatedUsd.toLocaleString("zh-CN", { maximumFractionDigits: 9 })) + ")})()" })) break;
			assert.ok(performance.now() < until, "CONTEXT_SUMMARY_UI_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50));
		}
		return { requests: usage.totals.knownRequests, normalizedTokens: usage.totals.tokens.totalTokens, estimatedUsd: usage.totals.estimatedUsd };
	}
	const totals = await show(), rejected = await testCommand("evaluate", { source: "(async()=>{let denied=0;for(const call of [()=>window.deck.workbench('agent',{}),()=>window.deck.workbench('check',{}),()=>window.deck.game('start',{}),()=>window.deck.manageProfiles('save',{}),()=>window.deck.probe({mode:'offline'})])try{await call()}catch{denied++}return denied})()" }); assert.equal(rejected, 5);
	await testCommand("reload"); assert.deepEqual(await show(), totals); assert.deepEqual(await state(ids), original.expected); assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), 0);
	const game = await api("game", { action: "snapshot" }), bridge = await api("bridge", { action: "snapshot" }); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null); assert.equal(bridge.observation, null);
	const proof = { version: 1, runId: context.runId, phase, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, expectedSha256: original.sha256, packaged: true, syntheticOnly: true, originalTasksAndContextsRetained: true, usageIncludesCompaction: true, uiReloadDoesNotReplay: true, newExecutionRejected: true, noMcpSelected: true, noProbeAllocated: true, readOnlyWorkspace: true, wholeApplicationRestartVerified: phase === "reopen", syntheticModelRequests: exercise?.syntheticModelRequests ?? 0, actualToolCalls: phase === "record" ? 1 : 0, totals, exercise, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false };
	await writeFile(join(context.root, "development-context-" + phase + "-proof.json"), JSON.stringify(proof), { flag: "wx" }); return proof;
}
