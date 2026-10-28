import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { contextSeedPrompt, contextContinuePrompt, contextCompactPrompt } from "./development-context-case.mjs";

// Runs inside the existing owned workbench fixture; no real provider or game.
export async function runDevelopmentContextSmoke(driver, rootId, { readPath = "code.mjs", readOnlyWorkspace = false, keepProfile = false, onComplete } = {}) {
	const request = (action, args = {}) => driver.api("workbench", { action, args }), evaluate = source => driver.testCommand("evaluate", { source });
	const id = "deckvault-" + randomUUID(), key = "synthetic-development-smoke-" + randomUUID(), calls = [], errors = [], runtime = driver.getRuntimePid();
	const server = createServer(async (incoming, response) => {
		try {
			assert.equal(incoming.headers.authorization, "Bearer " + key); let body = ""; for await (const part of incoming) body += part;
			const data = JSON.parse(body), encoded = JSON.stringify(data.messages), tools = (data.tools ?? []).map(tool => tool.function.name); calls.push({ summary: !tools.length }); let delta, input = 4000;
			if (!tools.length) { assert.ok(encoded.includes("CONTEXT_SEED_MARKER")); input = 5000; delta = { content: "HISTORICAL_CONTEXT_SUMMARY: seed completed, follow-up answered. Recheck current files and permissions." }; }
			else if (encoded.includes("CONTEXT_AFTER_COMPACT")) {
				assert.deepEqual(tools.sort(), ["workspace_diff", "workspace_list", "workspace_read", "workspace_search"]); assert.ok(encoded.includes("HISTORICAL_CONTEXT_SUMMARY")); input = 400;
				delta = data.messages.some(message => message.role === "tool" && message.tool_call_id === "context-fresh-read") ? { content: "CONTEXT_COMPACT_DONE" } : { tool_calls: [{ index: 0, id: "context-fresh-read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: readPath }) } }] };
			} else if (encoded.includes("CONTEXT_CONTINUE")) { assert.ok(encoded.includes("CONTEXT_SEED_DONE")); assert.ok(!tools.includes("workspace_edit") && !tools.includes("workspace_check")); input = 5000; delta = { content: "CONTEXT_CONTINUE_DONE" }; }
			else { assert.ok(encoded.includes("CONTEXT_SEED_MARKER")); delta = { content: "CONTEXT_SEED_DONE" }; }
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "synthetic-context", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "synthetic-context", choices: [], usage: { prompt_tokens: input, completion_tokens: 20 } })}\n\n`); response.end("data: [DONE]\n\n");
		} catch (error) { errors.push(error); response.writeHead(500); response.end("Synthetic context fixture failed"); }
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	async function until(predicate, code) { const deadline = performance.now() + 20000; while (!await predicate()) { assert.ok(performance.now() < deadline, code); await new Promise(resolve => setTimeout(resolve, 50)); } }
	async function settled(taskId) { let task; await until(async () => { task = await request("task", { taskId }); return (await request("state")).activeTask === null && !["queued", "running", "cancelling"].includes(task.state); }, "CONTEXT_TASK_NOT_SETTLED"); assert.equal(task.state, "succeeded", task.error); return task; }
	async function startFromUi(parent, mode, prompt) {
		await request("ui-save", { key: "selection", value: { rootId, taskId: parent.id } }); await request("ui-save", { key: "draft", value: { prompt, model: JSON.stringify([id, "fixture"]) } }); await driver.testCommand("reload");
		await until(() => evaluate("document.querySelector('[aria-label=开发任务]')?.value===" + JSON.stringify(prompt)), "CONTEXT_DRAFT_NOT_READY");
		await evaluate("(()=>{const select=document.querySelector('[aria-label=开发上下文模式]');select.value=" + JSON.stringify(mode) + ";select.dispatchEvent(new Event('change',{bubbles:true}))})()");
		await until(() => evaluate("(()=>{const panel=document.querySelector('.development-panel'),button=[...panel.querySelectorAll('button')].find(button=>button.textContent==='开始任务');if(!panel.textContent.includes(" + JSON.stringify("来源 " + parent.id.slice(0, 8)) + ")||!button||button.disabled)return false;button.click();return true})()"), "CONTEXT_UI_START_NOT_READY");
		let taskId; await until(async () => { taskId = (await request("state")).tasks.find(task => task.parentId === parent.id)?.id; return Boolean(taskId); }, "CONTEXT_CHILD_NOT_CREATED"); return settled(taskId);
	}
	let profileSaved = false;
	try {
		if (readOnlyWorkspace) driver.registerSyntheticProvider(server, id, key);
		const profiles = await driver.api("profiles-manage", { action: "list" }); assert.deepEqual(profiles.profiles, []);
		await driver.api("profiles-manage", { action: "save", args: { id, label: "Synthetic context management", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", contextWindow: 32768, maxTokens: 2048, apiKey: key, pricing: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 }, expectedRevision: profiles.revision } }); profileSaved = true;
		const seed = await settled((await request("agent", { rootId, prompt: contextSeedPrompt, providerId: id, modelId: "fixture" })).id), source = await request("context-info", { rootId, taskId: seed.id });
		if (readOnlyWorkspace) { const root = (await request("state")).roots.find(value => value.id === rootId); assert.equal(root.canWrite, false); assert.equal(root.canExecute, false); }
		else await request("grants", { rootId, canWrite: false, canExecute: false });
		const continued = await startFromUi(seed, "continue", contextContinuePrompt), current = await request("context-info", { rootId, taskId: continued.id }); assert.equal(current.canCompact, true);
		const compacted = await startFromUi(continued, "compact", contextCompactPrompt); assert.equal(compacted.response, "CONTEXT_COMPACT_DONE"); assert.equal(compacted.result.contextManagement.compacted, true); assert.ok(compacted.result.contextManagement.estimatedTokensAfter < compacted.result.contextManagement.tokensBefore);
		assert.equal(compacted.invocations.length, 1); assert.equal(compacted.invocations[0].name, "workspace_read"); assert.equal(compacted.result.toolCalls, 1); assert.equal(compacted.result.contextManagement.compactionRequests, calls.filter(call => call.summary).length); assert.equal(compacted.usage.requests, calls.filter(call => call.summary).length + 2);
		assert.deepEqual(await request("task", { taskId: seed.id }), seed); assert.deepEqual(await request("task", { taskId: continued.id }), continued); assert.deepEqual(await request("context-info", { rootId, taskId: seed.id }), source); assert.deepEqual(await request("context-info", { rootId, taskId: continued.id }), current);
		const requestCount = calls.length; await driver.testCommand("reload");
		await until(() => evaluate("document.querySelector('.development-panel')?.textContent.includes('压缩后续接自')"), "CONTEXT_RELOAD_LINEAGE_NOT_READY");
		assert.deepEqual(await request("task", { taskId: compacted.id }), compacted); assert.equal(calls.length, requestCount); assert.equal(driver.getRuntimePid(), runtime); assert.deepEqual(errors, []);
		if (onComplete) await onComplete({ seed, continued, compacted, source, current });
		return { syntheticOnly: true, uiContinuationVerified: true, uiCompactionVerified: true, copiedSourceHashesRetained: true, originalTasksAndReceiptsRetained: true, freshReadOnlyGrants: true, actualToolCalls: 1, syntheticModelRequests: calls.length, compactionRequests: compacted.result.contextManagement.compactionRequests, tokensBefore: compacted.result.contextManagement.tokensBefore, estimatedTokensAfter: compacted.result.contextManagement.estimatedTokensAfter, usageIncludesCompaction: true, uiReloadDoesNotReplay: true, physicalInputVerified: false, wholeApplicationRestartVerified: false, realModelRequests: 0, gameCalls: 0 };
	} finally {
		try { if (!keepProfile && profileSaved && !(await request("state")).activeTask) { const profiles = await driver.api("profiles-manage", { action: "list" }); await driver.api("profiles-manage", { action: "remove", args: { id, expectedRevision: profiles.revision } }); } }
		finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	}
}
