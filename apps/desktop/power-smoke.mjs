import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function until(predicate, label) {
	const deadline = performance.now() + 10000;
	while (!await predicate()) { assert.ok(performance.now() < deadline, "POWER_SMOKE_TIMEOUT_" + label); await new Promise(resolve => setTimeout(resolve, 35)); }
}

export async function checkPowerLifecycle(driver) {
	const { api, testCommand } = driver, runtime = driver.getRuntimePid(), ui = driver.getUi(), probes = driver.getProbeSequence();
	const power = driver.getPower(), native = await api("status"), initial = await api("game", { action: "snapshot" });
	const draft = await api("workbench", { action: "ui-get", args: { key: "draft" } });
	assert.equal(power.ready, true);
	const cycles = [];
	for (const failedCheck of [false, true]) {
		driver.emitPowerForSmoke("suspend"); assert.equal(power.snapshot().phase, "suspended");
		for (const [action, args] of [["probe", { mode: "offline" }], ["bridge", { action: "refresh" }], ["game", { action: "catalog" }], ["workbench", { action: "check", args: {} }], ["game-confirmed", {}]]) await assert.rejects(api(action, args), /SYSTEM_POWER_PAUSED/);
		await until(() => !power.snapshot().draining, "DRAIN");
		assert.equal((await api("workbench", { action: "state" })).executionBlocked, true);
		await testCommand("reload");
		await until(async () => await testCommand("evaluate", { source: "document.querySelector('[data-system-power]')?.getAttribute('data-system-power')" }) === "suspended", "PAUSED_UI");
		const premature = await testCommand("evaluate", { source: "window.deck.resumeSystem().then(()=>false,error=>error.message.includes('SYSTEM_WAKE_NOT_OBSERVED'))" }); assert.equal(premature, true);
		await driver.duringPowerPause?.();
		if (failedCheck) driver.failNextPowerCheckForSmoke();
		driver.emitPowerForSmoke("resume");
		await until(() => ["ready", "blocked"].includes(power.snapshot().phase), "WAKE");
		if (failedCheck) {
			assert.equal(power.snapshot().phase, "blocked"); assert.equal(power.snapshot().canRetry, true);
			await until(async () => await testCommand("evaluate", { source: "document.querySelector('[data-system-power]')?.getAttribute('data-system-power')" }) === "blocked", "BLOCKED_UI");
			await testCommand("evaluate", { source: "[...document.querySelectorAll('[data-system-power] button')].find(button=>button.textContent==='重新检查连接').click();true" });
			await until(() => power.ready, "EXPLICIT_RETRY");
		} else assert.equal(power.snapshot().phase, "ready", JSON.stringify(power.snapshot()));
		await until(async () => await testCommand("evaluate", { source: "document.querySelector('[data-system-power]')===null" }), "READY_UI");
		assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getUi(), ui); assert.equal(driver.getProbeSequence(), probes);
		assert.deepEqual(await api("workbench", { action: "ui-get", args: { key: "draft" } }), draft);
		assert.deepEqual((await api("game", { action: "snapshot" })).tasks, initial.tasks);
		const after = await api("status");
		for (const key of ["attached", "targetPid", "hostHwnd", "viewportHwnd", "gameParentMatches", "nativeParentMatches"]) if (Object.hasOwn(native, key)) assert.equal(after[key], native[key], key);
		cycles.push({ failedCheck, generation: power.generation, explicitRetryRequired: failedCheck, sameUiAndRuntime: true, draftAndOriginalGameTasksRetained: true });
	}
	return { cycles, synthesizedPowerMonitorEvents: true, rejectedAdmissionWhileSuspended: true, reloadRetainsPowerGate: true, wakeCheckFailureStaysBlockedUntilUiRetry: true, noModelOrTaskReplay: true, originalNativeBindingRetained: true, actualOsSleepVerified: false, physicalInputVerified: false };
}

export async function runPowerSmoke(driver) {
	const result = await driver.api("probe", { mode: "offline" }); assert.equal(result.requestCount, 2);
	const base = join(driver.root, ".local/m2-smoke", driver.runId), marker = join(base, "Spherewright.Mcp.exe");
	await mkdir(base, { recursive: true }); await writeFile(marker, "OWNED_M2_SYNTHETIC_FIXTURE", { flag: "wx" });
	await driver.api("bridge-select", marker);
	await until(async () => (await driver.api("bridge", { action: "snapshot" })).observation?.summary.state === "observed", "INITIAL_READS");
	const clientPid = driver.getBridgePid();
	await driver.api("start-fixture"); await driver.api("attach", "owned-fixture");
	const proof = await checkPowerLifecycle({ ...driver, duringPowerPause: async () => {
		const bridge = await driver.api("bridge", { action: "snapshot" });
		assert.equal(bridge.systemPaused, true); assert.equal(bridge.observation.connected, false); assert.equal(bridge.observation.summary.state, "stale");
		assert.equal(driver.getBridgePid(), clientPid);
	} });
	await until(async () => (await driver.api("bridge", { action: "snapshot" })).observation?.summary.state === "observed", "FRESH_READS");
	assert.equal(driver.getBridgePid(), clientPid);
	await driver.api("detach"); await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
	const directory = join(driver.root, ".local/power-smoke", driver.runId); await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "application.private.json"), JSON.stringify({ runId: driver.runId, ...proof, sameMcpProcessRetained: true, cachedReadsInvalidated: true, ownServerExitConfirmed: true, syntheticModelRequests: 2, gameCalls: 0, realModelRequests: 0 }), { flag: "wx" });
}
