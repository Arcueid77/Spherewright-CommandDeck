import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { profileHash } from "./portable-profile.mjs";
import { modelUsageSnapshot } from "./model-usage.mjs";
import { runDevelopmentContextSmoke } from "./development-context-smoke.mjs";
import { contextSeedPrompt, contextContinuePrompt, contextCompactPrompt } from "./development-context-case.mjs";

export const contextInterruptionOriginalFile = "development-context-interrupted-original.private.json";
const interruptedError = "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY";

// This marker contains comparison data only. The portable policy independently
// closes model, tool and game admission on both recovery launches.
export async function readContextInterruptionOriginal(context) {
	const file = join(context.root, contextInterruptionOriginalFile), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 524288);
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), ["expected", "kind", "runId", "sha256", "sourceRevision", "supervisorPid", "version"]);
	assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-context-interruption"); assert.equal(value.runId, context.runId);
	assert.match(value.sourceRevision, /^[a-f0-9]{40}$/); assert.ok(Number.isSafeInteger(value.supervisorPid) && value.supervisorPid > 0); assert.equal(profileHash(value.expected), value.sha256);
	const { roots, tasks, records, infos, selection, draft } = value.expected;
	assert.deepEqual(Object.keys(value.expected).sort(), ["draft", "infos", "records", "roots", "selection", "tasks"]);
	assert.equal(roots.length, 1); assert.equal(roots[0].path, join(context.root, "development-usage-workspace")); assert.equal(roots[0].canWrite, false); assert.equal(roots[0].canExecute, false);
	assert.equal(tasks.length, 3); assert.equal(records.length, 3); assert.equal(infos.length, 2); assert.equal(new Set(records.map(task => task.id)).size, 3);
	for (let index = 0; index < 3; index++) {
		const task = records[index], usage = modelUsageSnapshot(task.usage);
		assert.deepEqual(task.usage, usage);
		assert.match(task.id, /^[a-f0-9-]{36}$/); assert.ok(tasks.some(value => value.id === task.id && value.state === task.state));
		assert.equal(task.kind, "agent"); assert.equal(task.rootId, roots[0].id); assert.equal(task.state, index === 2 ? "running" : "succeeded");
		assert.equal(task.model, "fixture"); assert.match(task.provider, /^deckvault-[a-f0-9-]{36}$/); assert.equal(task.provider, records[0].provider);
		assert.equal(task.prompt, [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt][index]); assert.equal(task.parentId, index ? records[index - 1].id : null);
		assert.deepEqual(task.invocations, []); assert.deepEqual(task.changes, []); assert.equal(usage.requests, 1);
		if (index < 2) { assert.equal(usage.coverage, "reported"); assert.equal(infos[index].sourceTaskId, task.id); assert.match(infos[index].sourceSha256, /^[a-f0-9]{64}$/); }
		else {
			assert.equal(task.result, null); assert.equal(task.error, null); assert.equal(task.finishedAt, null); assert.equal(task.response, ""); assert.equal(task.context, undefined);
			assert.equal(usage.pendingResponses, 1); assert.equal(usage.responses, 0); assert.equal(usage.tokens, null); assert.equal(usage.estimate.usd, null);
			assert.ok(!task.events.some(event => ["context-management", "context", "assistant-text", "tool-result"].includes(event.kind)));
		}
		if (index) { assert.equal(task.scope.context.sourceTaskId, records[index - 1].id); assert.equal(task.scope.context.sourceSha256, infos[index - 1].sourceSha256); assert.equal(task.scope.context.mode, index === 1 ? "continue" : "compact"); }
	}
	assert.equal(selection.rootId, roots[0].id); assert.equal(selection.taskId, records[2].id); assert.equal(draft.prompt, contextCompactPrompt);
	return value;
}

export function assertRecoveredContextRecord(before, after) {
	assert.equal(before.state, "running"); assert.equal(after.state, "interrupted"); assert.equal(after.error, interruptedError); assert.equal(after.result, null);
	assert.ok(Number.isFinite(Date.parse(after.finishedAt)) && Date.parse(after.finishedAt) >= Date.parse(before.startedAt));
	assert.deepEqual(after.events.slice(0, -1), before.events); assert.equal(after.events.length, before.events.length + 1);
	const event = after.events.at(-1); assert.equal(event.kind, "task"); assert.deepEqual(event.value, { state: "interrupted", error: interruptedError }); assert.ok(Number.isSafeInteger(event.sequence) && event.sequence > before.events.at(-1).sequence);
	assert.deepEqual(after, { ...before, state: "interrupted", finishedAt: after.finishedAt, error: interruptedError, events: after.events });
}

export async function runDevelopmentContextInterruption(driver, manifest) {
	assert.equal(manifest.portableDevelopmentContextInterruption, 1); assert.equal(manifest.developmentContextManagement, 1);
	const { context, api, testCommand } = driver, phase = driver.developmentUsageCase.phase;
	const request = (action, args = {}) => api("workbench", { action, args }), registered = await driver.registerDevelopmentUsageWorkspace(), root = registered.roots[0], runtime = driver.getRuntimePid();
	async function state(ids) {
		const work = await request("state"); assert.equal(work.executionBlocked, false);
		return JSON.parse(JSON.stringify({ roots: work.roots, tasks: work.tasks, records: await Promise.all(ids.map(taskId => request("task", { taskId }))), infos: await Promise.all(ids.slice(0, 2).map(taskId => request("context-info", { rootId: root.id, taskId }))), selection: await request("ui-get", { key: "selection" }), draft: await request("ui-get", { key: "draft" }) }));
	}
	if (phase === "record") {
		assert.deepEqual(registered.tasks, []);
		await runDevelopmentContextSmoke(driver, root.id, { readPath: "fixture.txt", readOnlyWorkspace: true, keepProfile: true, onCompactionPending: async ({ seed, continued, pending, syntheticModelRequests }) => {
			assert.equal(syntheticModelRequests, 3); assert.equal((await request("state")).activeTask, pending.id);
			await request("ui-save", { key: "selection", value: { rootId: root.id, taskId: pending.id } });
			const expected = await state([seed.id, continued.id, pending.id]);
			const marker = { version: 1, kind: "synthetic-context-interruption", runId: context.runId, sourceRevision: manifest.sourceRevision, supervisorPid: process.pid, expected, sha256: profileHash(expected) };
			const ready = join(context.root, contextInterruptionOriginalFile), staging = ready + ".pending";
			await assert.rejects(lstat(ready), { code: "ENOENT" }); await writeFile(staging, JSON.stringify(marker), { flag: "wx" }); await rename(staging, ready);
			await readContextInterruptionOriginal(context);
			// No close/abort here: the controller observes this exact app process,
			// snapshots the durable running task, then terminates its spawn handle.
			await new Promise(() => {});
		} });
		throw new Error("CONTEXT_INTERRUPTION_CONTROLLER_DID_NOT_TERMINATE");
	}
	assert.ok(["recover", "reopen"].includes(phase));
	const original = await readContextInterruptionOriginal(context); assert.equal(original.sourceRevision, manifest.sourceRevision);
	const ids = original.expected.records.map(task => task.id), actual = await state(ids); assert.equal((await request("state")).activeTask, null);
	assert.deepEqual(actual.records.slice(0, 2), original.expected.records.slice(0, 2)); assertRecoveredContextRecord(original.expected.records[2], actual.records[2]);
	const pending = actual.records[2], tasks = original.expected.tasks.map(task => task.id === pending.id ? { ...task, state: pending.state, error: pending.error, finishedAt: pending.finishedAt } : task);
	assert.deepEqual(actual, { ...original.expected, tasks, records: actual.records });
	async function show() {
		const deadline = performance.now() + 10000; let opened = false;
		while (true) {
			const ready = await testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('.development-panel'),usage=panel?.querySelector('[aria-label=模型用量与费用]')?.textContent;return panel?.textContent.includes('RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY')&&document.querySelector('[aria-label=开发上下文模式]')?.value==='new'&&usage?.includes('1 次未取得终报')&&usage?.includes('费用估算未知')})()" });
			if (ready && !opened) opened = await testCommand("evaluate", { source: "(()=>{const button=[...document.querySelectorAll('header button')].find(value=>value.textContent==='用量汇总');if(!button||button.disabled)return false;button.click();return true})()" });
			if (opened && await testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('[aria-label=模型用量汇总]');return panel?.querySelector('[data-usage-summary-total]')?.textContent.includes('1 次缺失或未取得终报')&&panel?.querySelector('[data-usage-summary-cost]')?.textContent.includes('无法估算 1 项')})()" })) break;
			assert.ok(performance.now() < deadline, "INTERRUPTED_CONTEXT_UI_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50));
		}
		const usage = await api("model-usage"), reported = original.expected.records.slice(0, 2).map(task => modelUsageSnapshot(task.usage));
		assert.equal(usage.partialSources, false); assert.equal(usage.truncated, false); assert.equal(usage.totals.tasks, 3); assert.equal(usage.totals.knownRequests, 3); assert.equal(usage.totals.reportedResponses, 2); assert.equal(usage.totals.missingResponses, 1); assert.equal(usage.totals.unpricedTasks, 1);
		assert.equal(usage.totals.tokens.totalTokens, reported.reduce((sum, value) => sum + value.tokens.totalTokens, 0)); assert.ok(Math.abs(usage.totals.estimatedUsd - reported.reduce((sum, value) => sum + value.estimate.usd, 0)) < 1e-12);
		return usage.totals;
	}
	const totals = await show();
	const rejected = await testCommand("evaluate", { source: "(async()=>{let denied=0;for(const call of [()=>window.deck.workbench('agent',{}),()=>window.deck.workbench('check',{}),()=>window.deck.game('start',{}),()=>window.deck.manageProfiles('save',{}),()=>window.deck.probe({mode:'offline'})])try{await call()}catch{denied++}return denied})()" }); assert.equal(rejected, 5);
	await testCommand("reload"); assert.deepEqual(await show(), totals); assert.deepEqual(await state(ids), actual); assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), 0);
	const game = await api("game", { action: "snapshot" }), bridge = await api("bridge", { action: "snapshot" }); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null); assert.equal(bridge.observation, null);
	const proof = { version: 1, runId: context.runId, phase, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, expectedSha256: original.sha256, recoveredStateSha256: profileHash(actual), packaged: true, syntheticOnly: true, originalCompletedTasksAndContextsRetained: true, unfinishedCompactionInterrupted: true, unfinishedUsageRemainsUnknown: true, noCompactionOrPromptReplayed: true, uiReloadDoesNotReplay: true, newExecutionRejected: true, noMcpSelected: true, noProbeAllocated: true, readOnlyWorkspace: true, wholeApplicationRestartVerified: true, totals, syntheticModelRequests: 0, actualToolCalls: 0, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false };
	await writeFile(join(context.root, "development-context-interruption-" + phase + "-proof.json"), JSON.stringify(proof), { flag: "wx" }); return proof;
}
