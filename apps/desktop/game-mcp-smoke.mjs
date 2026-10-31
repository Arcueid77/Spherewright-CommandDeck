import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runMcpGameSmoke(driver) {
	const base = join(driver.root, ".local/m3-smoke", driver.runId), marker = join(base, "Spherewright.Mcp.exe");
	await mkdir(base, { recursive: true }); await writeFile(marker, "OWNED_M3_SYNTHETIC_FIXTURE", { flag: "wx" });
	const profileId = "deckvault-" + randomUUID(), key = "synthetic-game-smoke-" + randomUUID(); let requests = 0;
	const server = createServer(async (request, response) => {
		let body = ""; for await (const part of request) body += part; const data = JSON.parse(body); requests++;
		assert.equal(request.headers.authorization, "Bearer " + key);
		assert.ok(data.tools.some(tool => tool.function.name === "spherewright_prepare_handcraft")); assert.ok(!data.tools.some(tool => /save_import|observe_research/.test(tool.function.name)));
		const replies = data.messages.filter(message => message.role === "tool"), previous = id => { const message = replies.find(message => message.tool_call_id === id); return message ? JSON.parse(message.content) : null; };
		let name, args, id;
		if (!previous("native-catalog")) { name = "spherewright_get_recipe_catalog"; args = {}; id = "native-catalog"; }
		else if (!previous("native-prepare")) { name = "spherewright_prepare_handcraft"; args = { sessionId: "synthetic-game-session", planetId: 1, recipeId: 10, count: 2 }; id = "native-prepare"; }
		else if (!previous("native-commit")) { name = "spherewright_commit_handcraft"; args = { sessionId: "synthetic-game-session", planetId: 1, planToken: previous("native-prepare").result.planToken, idempotencyKey: "model-key" }; id = "native-commit"; }
		else if (!previous("native-result")) { name = "spherewright_get_action_result"; args = { actionId: previous("native-commit").result.actionId }; id = "native-result"; }
		const delta = name ? { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : { content: "已核对合成原生动作终态；未操作 DSP。" };
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: name ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "native-fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const evaluate = source => driver.testCommand("evaluate", { source }), state = () => driver.api("game", { action: "snapshot" });
	async function until(predicate, label) { const end = performance.now() + 15000; while (!await predicate()) { if (performance.now() >= end) throw new Error("GAME_NATIVE_SMOKE_TIMEOUT_" + label); await new Promise(resolve => setTimeout(resolve, 30)); } }
	try {
		driver.registerSyntheticProvider(server, profileId, key);
		const vault = await driver.api("profiles-manage", { action: "list" });
		await driver.api("profiles-manage", { action: "save", args: { id: profileId, label: "Synthetic native MCP smoke", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", apiKey: key, contextWindow: 65536, maxTokens: 1024, expectedRevision: vault.revision } });
		await driver.api("bridge-select", marker);
		await until(() => evaluate("(()=>{const button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(!button||button.disabled)return false;button.click();return true})()"), "PANEL");
		await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"MCP 游戏 Agent 模型\"]')?.options.length>1)"), "PROFILE");
		await evaluate(`(()=>{const model=document.querySelector('[aria-label="MCP 游戏 Agent 模型"]');model.value=${JSON.stringify(JSON.stringify([profileId, "fixture"]))};model.dispatchEvent(new Event('change',{bubbles:true}));const mode=document.querySelector('[aria-label="MCP 游戏任务模式"]');mode.value='assist';mode.dispatchEvent(new Event('change',{bubbles:true}));const prompt=document.querySelector('[aria-label="MCP 游戏任务目标"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(prompt,'通过原生 MCP 手工制作并核对终态，仅替身');prompt.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
		await until(() => evaluate("!document.querySelector('.mcp-game-form button').disabled"), "START_ENABLED");
		const submit = () => evaluate("document.querySelector('.mcp-game-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
		await submit(); await until(async () => (await state()).mcp.awaitingConfirmation, "CANCEL_PREVIEW");
		await driver.testCommand("answer-game-confirmation", { response: 0 });
		await until(() => evaluate("(()=>{const b=[...document.querySelectorAll('.game-tasks-panel button')].find(b=>b.textContent==='核对并确认本次操作');if(!b||b.disabled)return false;b.click();return true})()"), "CANCEL_CLICK");
		await until(async () => !(await state()).busy, "CANCEL_END"); assert.equal(await driver.getSyntheticCommitCount(), 0);
		await until(() => evaluate("!document.querySelector('.mcp-game-form fieldset').disabled"), "NEXT_TASK");
		await submit(); await until(async () => (await state()).mcp.awaitingConfirmation, "CONFIRM_PREVIEW");
		await assert.rejects(driver.api("bridge", { action: "disconnect" }), /GAME_TASK_OWNS_BRIDGE/);
		await driver.testCommand("answer-game-confirmation", { response: 1 });
		await until(() => evaluate("(()=>{const b=[...document.querySelectorAll('.game-tasks-panel button')].find(b=>b.textContent==='核对并确认本次操作');if(!b||b.disabled)return false;b.click();return true})()"), "CONFIRM_CLICK");
		await until(async () => { const value = await state(); return !value.busy && !value.unresolved.length && value.tasks.some(task => task.scope.kind === "mcp-action" && task.intent?.state === "completed"); }, "TERMINAL");
		assert.equal(await driver.getSyntheticCommitCount(), 1); const before = await state(), count = requests, pid = driver.getBridgePid();
		await driver.testCommand("reload"); await until(() => evaluate("document.readyState==='complete' && Boolean(window.deck)"), "RELOAD");
		assert.equal(driver.getBridgePid(), pid); assert.equal(requests, count); assert.deepEqual((await state()).unresolved, []); assert.equal((await state()).tasks.find(task => task.id === before.currentTaskId)?.state, "advised");
		assert.ok(!(await evaluate("document.body.innerText")).includes("PRIVATE_SYNTHETIC"));
		await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
		const proof = { runId: driver.runId, syntheticOnly: true, gameCalls: 0, gameWrites: 0, realProviderRequests: 0, syntheticModelRequests: requests, syntheticGameCommits: 1, nativeMcpToolsToPi: true, cancelSendsNothing: true, oneDurableIntent: true, originalActionReconciled: true, ownServerExitConfirmed: true, uiReloadDoesNotReplay: true, physicalInput: "not_tested", approval: "mocked-native-dialog-return" };
		await writeFile(join(base, "native-mcp-proof.private.json"), JSON.stringify(proof), { flag: "wx" }); await writeFile(join(driver.root, ".local/desktop-smoke-game-native.json"), JSON.stringify(proof));
	} finally { server.closeAllConnections(); server.close(); }
}
