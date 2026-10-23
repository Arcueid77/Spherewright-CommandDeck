import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ReadOnlyMcpClient } from "./mcp-client.mjs";
import { runGameRuntimeLossSmoke } from "./runtime-loss-smoke.mjs";
import { runGameMcpLossSmoke } from "./mcp-loss-smoke.mjs";
import { preparePortableFixtureDirectory, createSyntheticResearchWorld, syntheticMcpEnvironment } from "./synthetic-scope.mjs";

export function gameFixtureOptions(root, runId, { mode = "normal", directory = join(root, ".local/m3-smoke", runId) } = {}) {
	if (!/^[0-9a-f-]{36}$/.test(runId ?? "")) throw new Error("EXPLICIT_GAME_SMOKE_REQUIRED");
	assert.ok(["normal", "pending", "mcp-drop-after-accept", "mcp-lost-ack"].includes(mode));
	const marker = join(directory, "Spherewright.Mcp.exe");
	return {
		async fingerprint(path) { assert.equal(await realpath(path), await realpath(marker)); const bytes = await readFile(marker); assert.equal(bytes.toString(), "OWNED_M3_SYNTHETIC_FIXTURE"); return { path: marker, cohortHash: createHash("sha256").update(bytes).digest("hex"), fileCount: 1 }; },
		launch(_selection, { researchAuthority }) { const persistent = ["mcp-drop-after-accept", "mcp-lost-ack"].includes(mode), env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" }; return new ReadOnlyMcpClient(spawn(process.execPath, [join(root, "test/fixtures/research-mcp-server.mjs"), mode, ...(persistent ? [join(directory, "synthetic-research-world.json"), runId] : [])], { windowsHide: true, stdio: "pipe", env: persistent ? syntheticMcpEnvironment(env) : env }), { researchAuthority }); },
	};
}

export async function runGameSmoke(driver) {
	const physical = process.argv.includes("--smoke-game-physical");
	const scenario = driver.runtimeScenario ?? (process.argv.includes("--smoke-runtime-loss") ? process.argv.includes("--smoke-runtime-planning") ? "planning" : process.argv.includes("--smoke-runtime-accepted") ? "accepted" : "confirmation" : null);
	const base = driver.context ? await preparePortableFixtureDirectory(driver.context) : join(driver.root, ".local/m3-smoke", driver.runId), marker = join(base, "Spherewright.Mcp.exe");
	await mkdir(base, { recursive: true }); await writeFile(marker, "OWNED_M3_SYNTHETIC_FIXTURE", { flag: "wx" });
	if (driver.mcpLossScenario) await createSyntheticResearchWorld(base, driver.runId);
	const key = "synthetic-game-smoke-" + randomUUID(), profileId = "deckvault-" + randomUUID(); let requests = 0;
	const server = createServer(async (request, response) => {
		assert.equal(request.headers.authorization, "Bearer " + key); let body = ""; for await (const part of request) body += part;
		const data = JSON.parse(body); requests++;
		const available = data.tools.map((value) => value.function.name).sort(); assert.deepEqual(available, ["observe_research", "propose_research"]);
		if (scenario === "planning") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(": synthetic in-flight response held until the owned runtime exits\n\n"); return; }
		const replies = data.messages.filter((value) => value.role === "tool"), observed = replies.some((value) => value.tool_call_id === "game-observe"), proposed = replies.some((value) => value.tool_call_id === "game-proposal");
		const name = !observed ? "observe_research" : !proposed ? "propose_research" : null;
		const delta = name ? { tool_calls: [{ index: 0, id: name === "observe_research" ? "game-observe" : "game-proposal", type: "function", function: { name, arguments: JSON.stringify(name === "observe_research" ? {} : { techId: 100, reason: "已观察指定科技与前置条件；只建议正常入队，等待用户确认。" }) } }] } : { content: "建议已提出，尚未执行。确认后由程序提交一次并核对队列。" };
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: name ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "synthetic-game", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	try {
		driver.registerSyntheticProvider?.(server, profileId, key);
		const vault = await driver.api("profiles-manage", { action: "list" });
		if (driver.context) assert.deepEqual(vault.profiles, [], "PORTABLE_RUNTIME_VAULT_MUST_BE_EMPTY");
		await driver.api("profiles-manage", { action: "save", args: { id: profileId, label: "Synthetic game smoke", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, modelId: "fixture", apiKey: key, contextWindow: 65536, maxTokens: 1024, expectedRevision: vault.revision } });
		await driver.api("bridge-select", marker); await driver.api("bridge", { action: "refresh" });
		const evaluate = (source) => driver.testCommand("evaluate", { source }), state = () => driver.api("game", { action: "snapshot" });
		async function until(predicate, label, budget = 12000) { const deadline = Date.now() + budget; while (!await predicate()) { if (Date.now() > deadline) { await writeFile(join(base, "failure.private.json"), JSON.stringify({ label, state: await state(), ui: await evaluate("document.body.innerText") }, null, 2)); throw new Error("GAME_SMOKE_TIMEOUT_" + label); } await new Promise((done) => setTimeout(done, 50)); } }
		async function realDialog(taskId, stage) {
			await evaluate(`(()=>{window.__gamePhysicalAnswer=null;void window.deck.confirmResearch(${JSON.stringify(taskId)}).then(value=>window.__gamePhysicalAnswer={ok:true,value},()=>window.__gamePhysicalAnswer={ok:false});return true})()`);
			await writeFile(join(driver.root, ".local/m3-physical-stage.private.json"), JSON.stringify({ runId: driver.runId, stage, syntheticOnly: true }));
			await until(async () => await evaluate("Boolean(window.__gamePhysicalAnswer)"), stage, 90000);
			const answer = await evaluate("window.__gamePhysicalAnswer"); assert.equal(answer.ok, true); return answer.value;
		}
		await until(async () => (await driver.api("bridge", { action: "snapshot" })).observation?.session.data?.gameLoaded === true, "CONNECTION");
		const pid = driver.getBridgePid();
		await until(() => evaluate("(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "GAME_LAYOUT_READY");
		await until(async () => await evaluate("Boolean(document.querySelector('[aria-label=游戏任务目标]'))"), "PANEL");
		await until(async () => await evaluate("[...document.querySelector('[aria-label=\"游戏 Agent 模型\"]').options].some(option=>option.textContent.includes('Synthetic game smoke'))"), "PROFILE");
		await driver.api("game", { action: "catalog" }); await until(async () => (await state()).phase === "catalog_ready", "CATALOG");
		await until(async () => await evaluate("[...document.querySelector('[aria-label=目标科技]').options].some(option=>option.value==='100')"), "CATALOG_DISPLAY");
		await evaluate(`(()=>{const node=document.querySelector('[aria-label="游戏 Agent 模型"]');node.value=${JSON.stringify(JSON.stringify([profileId, "fixture"]))};node.dispatchEvent(new Event('change',{bubbles:true}));const input=document.querySelector('[aria-label="目标科技"]');input.value='100';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
		await evaluate("document.querySelector('.game-tasks-panel form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
		if (scenario === "planning") {
			await until(async () => (await state()).phase === "planning" && requests === 1, "MODEL_REQUEST_IN_FLIGHT");
			await runGameRuntimeLossSmoke(driver, { evaluate, state, until, requests: () => requests, base }); return;
		}
		await until(async () => (await state()).phase === "awaiting_approval", "PREVIEW");
		let current = await state(); assert.equal(current.unresolved.length, 0); assert.equal(current.developmentFrozen, true);
		assert.equal(await driver.getSyntheticCommitCount(), 0); assert.equal(requests, 3);
		const denied = await evaluate("(async()=>{let count=0;for(const action of ['approve','commit','game-confirmed','game-confirmation'])try{await window.deck.game(action,{userConfirmed:true})}catch{count++}try{await window.deck.workbench('game-end')}catch{count++}try{await window.deck.workbench('agent',{})}catch{count++}return count})()"); assert.equal(denied, 6);
		await assert.rejects(driver.api("bridge", { action: "disconnect" }), /GAME_TASK_OWNS_BRIDGE/);
		await until(async () => (await evaluate("document.body.innerText")).includes("等待你确认"), "APPROVAL_DISPLAY");
		if (driver.mcpLossScenario) { await runGameMcpLossSmoke(driver, { evaluate, state, until, requests: () => requests, base }); return; }
		if (scenario) { await runGameRuntimeLossSmoke(driver, { evaluate, state, until, requests: () => requests, base }); return; }
		if (!physical) await driver.testCommand("answer-game-confirmation", { response: 0 });
		const cancelled = physical ? await realDialog(current.currentTaskId, "cancel_required") : await evaluate(`window.deck.confirmResearch(${JSON.stringify(current.currentTaskId)})`); assert.equal(cancelled.cancelled, true); assert.equal(await driver.getSyntheticCommitCount(), 0);
		await driver.testCommand("reload");
		await until(async () => (await evaluate("document.body.innerText")).includes("等待你确认"), "RELOAD_PREVIEW"); assert.equal(driver.getBridgePid(), pid);
		await driver.api("game", { action: "reprepare" }); await until(async () => (await state()).phase === "awaiting_approval", "REPREPARE");
		if (physical) await realDialog(current.currentTaskId, "confirm_required");
		else { await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate(`window.deck.confirmResearch(${JSON.stringify(current.currentTaskId)})`); }
		await until(async () => { const value = await state(); return value.phase === "completed" && !value.busy && !value.developmentFrozen; }, "COMPLETION_AND_GATE_RELEASE"); current = await state();
		assert.equal(current.unresolved.length, 0); assert.equal(current.developmentFrozen, false); assert.equal(await driver.getSyntheticCommitCount(), 1); assert.equal(requests, 3);
		assert.deepEqual(current.tasks[0].intent.terminal.afterQueue, [99, 100]);
		assert.ok(!JSON.stringify(current).includes("PRIVATE_")); assert.ok(!JSON.stringify(current).includes(key));
		await until(async () => (await evaluate("document.body.innerText")).includes("队列变化已核对"), "RECEIPT_DISPLAY");
		const capture = await driver.testCommand("capture-game");
		await driver.testCommand("reload"); await until(async () => (await evaluate("document.body.innerText")).includes("队列变化已核对"), "RELOAD_RECEIPT");
		assert.equal(await driver.getSyntheticCommitCount(), 1);
		const profiles = await driver.api("profiles-manage", { action: "list" }); await driver.api("profiles-manage", { action: "remove", args: { id: profileId, expectedRevision: profiles.revision } });
		await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
		if (physical) await writeFile(join(driver.root, ".local/m3-physical-stage.private.json"), JSON.stringify({ runId: driver.runId, stage: "completed", syntheticOnly: true }));
		await writeFile(join(driver.root, ".local/desktop-smoke-game.json"), JSON.stringify({ runId: driver.runId, syntheticOnly: true, gameCalls: 0, gameWrites: 0, realProviderRequests: 0, syntheticModelRequests: requests, syntheticGameCommits: 1, pinnedPiTools: ["observe_research", "propose_research"], hostCredentialBinding: true, approval: physical ? "actual-native-dialog-return" : "mocked-native-dialog-return", physicalInput: "not_tested", nativeDialogPhysicalInput: physical ? "external-operator-not-identified" : "not_tested", rendererCannotApprove: true, cancelSendsNothing: true, reloadKeepsSameMcp: true, reloadDoesNotReplay: true, taskReceiptRetained: true, developerGateReleased: true, ownServerExitConfirmed: true, visualCapture: capture.captured ? "captured" : "unavailable" }, null, 2));
	} finally { server.closeAllConnections(); server.close(); }
}
