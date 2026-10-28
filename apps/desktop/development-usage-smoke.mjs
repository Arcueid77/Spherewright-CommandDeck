import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { developmentUsagePrompt } from "./portable-mode.mjs";
import { profileHash } from "./portable-profile.mjs";
import { modelUsageSnapshot } from "./model-usage.mjs";

export const developmentUsageText = "DEVELOPMENT_USAGE_FIXTURE\n";
export const developmentUsageOriginalFile = "development-usage-original.private.json";
const json = value => JSON.parse(JSON.stringify(value));
export async function validateDevelopmentUsageWorkspace(context) {
	const directory = join(context.root, "development-usage-workspace"), info = await lstat(directory);
	assert.ok(info.isDirectory() && !info.isSymbolicLink()); assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
	assert.deepEqual((await readdir(directory)).sort(), [".git", "fixture.txt"]);
	for (const name of [".git", "fixture.txt"]) {
		const file = join(directory, name), entry = await lstat(file); assert.ok(!entry.isSymbolicLink()); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
		if (name === ".git") assert.ok(entry.isDirectory());
		else { assert.ok(entry.isFile() && entry.nlink === 1 && entry.size <= 4096); assert.equal(await readFile(file, "utf8"), developmentUsageText); }
	}
	return directory;
}

export async function readDevelopmentUsageOriginal(context) {
	const file = join(context.root, developmentUsageOriginalFile), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 262144); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), ["expected", "kind", "runId", "sha256", "version"]); assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-development-usage"); assert.equal(value.runId, context.runId); assert.equal(profileHash(value.expected), value.sha256);
	const { roots, tasks, task, selection, draft } = value.expected;
	assert.equal(roots.length, 1); assert.equal(roots[0].path, join(context.root, "development-usage-workspace")); assert.equal(roots[0].canWrite, false); assert.equal(roots[0].canExecute, false);
	assert.equal(tasks.length, 1); assert.equal(task.id, tasks[0].id); assert.equal(task.rootId, roots[0].id); assert.equal(task.kind, "agent"); assert.equal(task.state, "succeeded"); assert.equal(task.model, "fixture");
	assert.equal(task.invocations.length, 1); assert.equal(task.invocations[0].name, "workspace_read"); assert.equal(task.invocations[0].state, "completed"); assert.equal(task.changes.length, 0);
	const usage = modelUsageSnapshot(task.usage); assert.equal(usage.requests, 2); assert.equal(usage.reportedResponses, 2); assert.equal(usage.tokens.totalTokens, 240); assert.equal(usage.estimate.status, "estimated"); assert.ok(Math.abs(usage.estimate.usd - 0.00077) < 1e-12);
	assert.equal(selection.taskId, task.id); assert.equal(selection.rootId, task.rootId); assert.equal(draft.prompt, developmentUsagePrompt);
	return value;
}

export async function runDevelopmentUsageSmoke(driver, manifest) {
	const { api, testCommand, context } = driver, phase = driver.developmentUsageCase.phase, runtimePid = driver.getRuntimePid();
	const request = (action, args = {}) => api("workbench", { action, args }), evaluate = source => testCommand("evaluate", { source });
	const registered = await driver.registerDevelopmentUsageWorkspace(), root = registered.roots[0];
	assert.equal(root.canWrite, false); assert.equal(root.canExecute, false);
	async function until(predicate, label) { const deadline = performance.now() + 20000; while (!await predicate()) { assert.ok(performance.now() < deadline, "DEVELOPMENT_USAGE_" + label); await new Promise(resolve => setTimeout(resolve, 50)); } }
	async function visible() { await until(() => evaluate("document.querySelector('.development-panel [aria-label=模型用量与费用]')?.textContent.includes('240 tokens') && document.querySelector('.development-panel [aria-label=模型用量与费用]')?.textContent.includes('0.00077')"), "UI_NOT_READY"); }
	async function expectedState(taskId) { const state = await request("state"); assert.equal(state.activeTask, null); assert.equal(state.executionBlocked, false); return json({ roots: state.roots, tasks: state.tasks, task: await request("task", { taskId }), selection: await request("ui-get", { key: "selection" }), draft: await request("ui-get", { key: "draft" }) }); }
	let original, requests = 0;
	if (phase === "record") {
		assert.deepEqual(registered.tasks, []);
		const key = "synthetic-development-smoke-" + randomUUID(), id = "deckvault-" + randomUUID();
		const server = createServer(async (incoming, response) => {
			assert.equal(incoming.headers.authorization, "Bearer " + key); let body = ""; for await (const part of incoming) body += part;
			const data = JSON.parse(body); assert.ok(++requests <= 2); assert.deepEqual(data.tools.map(tool => tool.function.name).sort(), ["workspace_diff", "workspace_list", "workspace_read", "workspace_search"]);
			if (requests === 2) assert.ok(data.messages.some(message => message.role === "tool" && message.content.includes("DEVELOPMENT_USAGE_FIXTURE")));
			const delta = requests === 1 ? { tool_calls: [{ index: 0, id: "development-usage-read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] } : { content: "Synthetic file read: DEVELOPMENT_USAGE_FIXTURE. No files changed or commands run." };
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: requests === 1 ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "development-usage", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "development-usage", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 7 } } })}\n\n`); response.end("data: [DONE]\n\n");
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			driver.registerSyntheticProvider(server, id, key);
			const list = await api("profiles-manage", { action: "list" }); assert.deepEqual(list.profiles, []);
			const profile = { id, label: "Synthetic development usage", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", contextWindow: 32768, maxTokens: 1024, apiKey: key, pricing: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }, expectedRevision: list.revision };
			const saved = await api("profiles-manage", { action: "save", args: profile });
			await request("ui-save", { key: "selection", value: { rootId: root.id, taskId: "" } }); await request("ui-save", { key: "draft", value: { prompt: developmentUsagePrompt, model: JSON.stringify([id, "fixture"]) } });
			await testCommand("reload");
			await until(() => evaluate("document.querySelector('[aria-label=开发任务]')?.value===" + JSON.stringify(developmentUsagePrompt)), "DRAFT_NOT_READY");
			await until(() => evaluate("(()=>{const button=[...document.querySelectorAll('.development-panel button')].find(value=>value.textContent==='开始任务');if(!button||button.disabled)return false;button.click();return true})()"), "TASK_START_NOT_READY");
			let taskId;
			await until(async () => { const state = await request("state"); const task = state.tasks[0]; if (!task) return false; taskId = task.id; if (["failed", "cancelled", "interrupted"].includes(task.state)) throw new Error("DEVELOPMENT_USAGE_TASK_FAILED_" + task.error); return task.state === "succeeded" && !state.activeTask; }, "TASK_NOT_FINISHED");
			assert.equal(requests, 2); await visible();
			const task = await request("task", { taskId }); assert.equal(task.invocations.length, 1); assert.equal(task.changes.length, 0); assert.ok(!JSON.stringify(task).includes(key));
			await api("profiles-manage", { action: "save", args: { ...profile, expectedRevision: saved.revision, pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
			assert.deepEqual(await request("task", { taskId }), task);
			await request("ui-save", { key: "selection", value: { rootId: root.id, taskId } });
			const expected = await expectedState(taskId); original = { version: 1, kind: "synthetic-development-usage", runId: context.runId, expected, sha256: profileHash(expected) };
			await writeFile(join(context.root, developmentUsageOriginalFile), JSON.stringify(original), { flag: "wx" });
		} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	} else {
		assert.equal(phase, "reopen"); original = await readDevelopmentUsageOriginal(context);
		assert.deepEqual(await expectedState(original.expected.task.id), original.expected); await visible();
	}
	original = await readDevelopmentUsageOriginal(context);
	const described = await api("profiles-manage", { action: "describe", args: { id: original.expected.task.provider } }); assert.deepEqual(described.pricing, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); assert.equal(described.key, undefined);
	const denied = await evaluate("(async()=>{let count=0;for(const call of [()=>window.deck.workbench('agent'," + JSON.stringify({ rootId: root.id, providerId: original.expected.task.provider, modelId: "fixture", prompt: developmentUsagePrompt }) + "),()=>window.deck.workbench('check'," + JSON.stringify({ rootId: root.id, checkId: "npm:test" }) + "),()=>window.deck.game('start',{}),()=>window.deck.manageProfiles('save',{}),()=>window.deck.probe({mode:'offline'})])try{await call()}catch{count++}return count})()"); assert.equal(denied, 5);
	await testCommand("reload"); await visible(); assert.deepEqual(await expectedState(original.expected.task.id), original.expected); assert.equal(driver.getRuntimePid(), runtimePid); assert.equal(driver.getProbeSequence(), 0);
	const game = await api("game", { action: "snapshot" }), bridge = await api("bridge", { action: "snapshot" }); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null); assert.equal(bridge.observation, null);
	const proof = { version: 1, runId: context.runId, phase, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, expectedSha256: original.sha256, syntheticOnly: true, packaged: true, syntheticModelRequests: requests, toolInvocations: 1, normalizedTokens: 240, reportedResponses: 2, estimatedUsd: original.expected.task.usage.estimate.usd, readOnlyWorkspace: true, priceSnapshotSurvivesReconfiguration: true, uiReloadRetainsUsage: true, originalTaskRetained: true, wholeApplicationRestartVerified: phase === "reopen", newExecutionRejected: true, noMcpSelected: true, noProbeAllocated: true, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false };
	await writeFile(join(context.root, "development-usage-" + phase + "-proof.json"), JSON.stringify(proof), { flag: "wx" }); return proof;
}
