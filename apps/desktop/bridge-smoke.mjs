import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ReadOnlyMcpClient } from "./mcp-client.mjs";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export function bridgeFixtureOptions(root, runId) {
	if (!/^[0-9a-f-]{36}$/.test(runId ?? "")) throw new Error("EXPLICIT_BRIDGE_SMOKE_REQUIRED");
	const marker = join(root, ".local/m2-smoke", runId, "Spherewright.Mcp.exe");
	return {
		async fingerprint(path) { assert.equal(await realpath(path), await realpath(marker)); const bytes = await readFile(marker); assert.equal(bytes.toString(), "OWNED_M2_SYNTHETIC_FIXTURE"); return { path: marker, cohortHash: createHash("sha256").update(bytes).digest("hex"), fileCount: 1 }; },
		launch() { return new ReadOnlyMcpClient(spawn(process.execPath, [join(root, "test/fixtures/mcp-server.mjs"), "telemetry"], { windowsHide: true, stdio: "pipe", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } })); },
	};
}
export async function runBridgeSmoke(driver) {
	const base = join(driver.root, ".local/m2-smoke", driver.runId), path = join(base, "Spherewright.Mcp.exe"); await mkdir(base, { recursive: true }); await writeFile(path, "OWNED_M2_SYNTHETIC_FIXTURE");
	await driver.api("bridge-select", path); await driver.api("bridge", { action: "refresh" });
	const evaluate = (source) => driver.testCommand("evaluate", { source });
	const state = () => driver.api("bridge", { action: "snapshot" });
	async function until(predicate, label) { const deadline = Date.now() + 8000; while (!await predicate()) { if (Date.now() >= deadline) { await writeFile(join(base, "failure.private.json"), JSON.stringify({ label, state: await state(), ui: await evaluate("({text:document.body.innerText,tabs:[...document.querySelectorAll('.dv-tab')].map(tab=>({text:tab.textContent,active:tab.className}))})") }, null, 2)); throw new Error("BRIDGE_SMOKE_TIMEOUT_" + label); } await delay(50); } }
	await until(async () => (await state()).observation?.production.data?.coverage.complete === true, "DATA");
	const initial = await state(), pid = driver.getBridgePid(); assert.equal(initial.observation.summary.data.coverage.returned, 2); assert.equal(initial.observation.production.data.planets[0].production[0].actualProductionPerMinute, 24);
	assert.equal(initial.observation.runtimePerformance.state, 'observed'); assert.equal(initial.observation.runtimePerformance.data.updateInterval.p95Ms, 18);
	assert.ok(!JSON.stringify(initial).includes("PRIVATE_SYNTHETIC"));
	const denied = await evaluate("(async()=>{let n=0;for(const action of ['call','tools/call','select','commit'])try{await window.deck.bridge(action,{})}catch{n++}return n})()"); assert.equal(denied, 4);
	await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='只读舰桥').click()");
	await until(async () => (await evaluate("document.body.innerText")).includes("MCP 服务已连接"), "CONNECTION");
	await until(async () => (await evaluate("document.body.innerText")).includes("Unity 更新间隔"), "RUNTIME_PERFORMANCE");
	const timing = await evaluate("document.querySelector('[aria-label=\"运行性能\"]').innerText");
	assert.ok(timing.includes('60 / 600')); assert.ok(timing.includes('P95')); assert.ok(timing.includes('当前排队 2 / 32')); assert.ok(!timing.includes('PRIVATE_SYNTHETIC'));
	await evaluate("[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()==='科研').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))");
	await until(async () => (await evaluate("document.body.innerText")).includes("Synthetic research"), "RESEARCH");
	await evaluate("[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()==='生产').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))");
	await until(async () => (await evaluate("document.body.innerText")).includes("Synthetic matrix 6001"), "PRODUCTION");
	const rendered = await evaluate("document.body.innerText"); assert.ok(rendered.includes("分页完整")); assert.ok(rendered.includes("窗口就绪")); assert.ok(rendered.includes("估计")); assert.ok(!rendered.includes("PRIVATE_SYNTHETIC"));
	for (const [tab, expected] of [["供电", "60"], ["物流", "2"]]) {
		await evaluate(`[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()===${JSON.stringify(tab)}).dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))`);
		await until(async () => (await evaluate("[...document.querySelectorAll('.bridge-panel table')].find(table=>table.getBoundingClientRect().height>0)?.querySelector('tbody tr td:nth-child(2)')?.textContent")) === expected, tab === "供电" ? "POWER" : "LOGISTICS");
	}
	await evaluate("[...document.querySelectorAll('.dv-tab')].find(tab=>tab.textContent.trim()==='生产').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:1,pointerType:'mouse',isPrimary:true}))");
	await until(async () => (await evaluate("document.body.innerText")).includes("Synthetic matrix 6001"), "RETURN_PRODUCTION");
	const capture = await driver.testCommand("capture-bridge");
	// A synthetic transport-loss notice exercises the real renderer handler; the supervisor stays alive.
	driver.emit({ type: "supervisor-disconnected", text: "Synthetic UI transport-loss fixture" });
	await until(async () => (await evaluate("document.body.innerText")).includes("旧数据 · 已过期"), "UI_TRANSPORT_NOTICE");
	assert.equal((await state()).observation.connected, true);
	await driver.testCommand("reload");
	await until(async () => (await evaluate("document.body.innerText")).includes("Synthetic matrix 6001"), "RELOAD");
	assert.equal(driver.getBridgePid(), pid);
	await driver.api("bridge", { action: "disconnect" });
	await until(async () => (await evaluate("document.body.innerText")).includes("旧数据 · 已过期"), "DISCONNECTED");
	assert.equal((await state()).observation.connected, false); assert.equal(driver.bridgeExitConfirmed(), true);
	const proof = { runId: driver.runId, syntheticOnly: true, modelRequests: 0, gameCalls: 0, gameWrites: 0, supportedReadTools: initial.metadata.readTools.length, cursorCoverageComplete: true, privateFieldsAbsent: true, actualRate: 24, theoryLabeledEstimate: true, powerMegawattConversion: 60, logisticsStationCount: 2, visualCapture: capture.captured ? "captured" : "unavailable", rendererRejectsGenericCalls: true, uiTransportNoticeInvalidatesData: true, realSupervisorLoss: "not_tested", reloadKeptSameMcp: true, disconnectMarksDataStale: true, ownServerExitConfirmed: true, physicalInput: "not_tested" };
	await writeFile(join(driver.root, ".local/desktop-smoke-bridge.json"), JSON.stringify(proof, null, 2));
}
