import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function runTraySmoke(driver) {
	const { api, testCommand } = driver, tray = driver.getTray(), runtime = driver.getRuntimePid(), originalUi = driver.getUi();
	assert.ok(tray); assert.equal(tray.nativeTray.isDestroyed(), false);
	const bounds = tray.nativeTray.getBounds();
	assert.ok(["x", "y", "width", "height"].every(key => Number.isFinite(bounds[key])));
	const result = await api("probe", { mode: "offline" });
	assert.equal(result.requestCount, 2); assert.equal(result.executed, 1);
	const sequence = driver.getProbeSequence();
	await testCommand("minimize-ui");
	assert.equal((await testCommand("window-state")).minimized, true);
	tray.menu.getMenuItemById("open").click();
	const deadline = performance.now() + 5000;
	while (true) {
		const state = await testCommand("window-state");
		if (state.visible && !state.minimized) break;
		assert.ok(performance.now() < deadline, "TRAY_DID_NOT_RESTORE_WORKBENCH");
		await new Promise(resolve => setTimeout(resolve, 30));
	}
	assert.equal(driver.getUi(), originalUi); assert.equal(driver.getRuntimePid(), runtime);
	await testCommand("reload");
	assert.equal(driver.getTray(), tray); assert.equal(tray.nativeTray.isDestroyed(), false);
	assert.equal(driver.getProbeSequence(), sequence); assert.equal(driver.getRuntimePid(), runtime);
	assert.equal((await api("snapshot")).lastProbeResult.requestCount, 2);
	await api("start-fixture"); await api("attach", "owned-fixture");
	assert.equal((await api("status")).nativeParentMatches, true);
	await api("detach"); assert.equal((await api("status")).attached, false);
	const proofRoot = join(driver.root, ".local/tray-smoke", driver.runId);
	await mkdir(proofRoot, { recursive: true });
	await writeFile(join(proofRoot, "application.private.json"), JSON.stringify({ runId: driver.runId, nativeTrayCreated: true, nativeMenuOpenRestoresMinimizedUi: true, uiReloadRetainsOriginalTray: true, originalUiAndRuntimeRetained: true, noProbeReplay: true, ownFixtureEmbeddedAndDetached: true, syntheticModelRequests: 2, realModelRequests: 0, gameCalls: 0, exitRequestedThroughTray: true, physicalTrayInputVerified: false, embeddedHostMinimizeVerified: false }), { flag: "wx" });
	// The same callback is used by the native exit menu; the external runner
	// must observe this application exit and independently check its processes.
	assert.equal(await tray.activate("exit"), true);
	await new Promise((_, reject) => setTimeout(() => reject(new Error("TRAY_EXIT_DID_NOT_END_APPLICATION")), 3000));
}
