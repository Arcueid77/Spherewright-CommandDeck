import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeClient } from "./native-client.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 10000) {
	const deadline = performance.now() + ms;
	while (!(await check())) { if (performance.now() > deadline) throw new Error("ADAPTER_DESKTOP_PROOF_TIMEOUT"); await delay(50); }
}
export async function runAdapterDesktopSmoke(driver) {
	const game = new NativeClient(["--adapter-pipe-fixture"]);
	const evaluate = (source) => driver.testCommand("evaluate", { source });
	try {
		await game.ready;
		const targets = await evaluate("window.deck.targets()");
		const target = targets.find((item) => item.id.startsWith("adapter:") && item.pid === game.child.pid);
		assert.ok(target);
		let state = await evaluate(`window.deck.attach(${JSON.stringify(target.id)})`);
		for (const field of ["active", "attached", "gameAlive", "gameParentMatches", "nativeParentMatches", "hostVisible", "uiVisible"])
			assert.equal(state[field], true, field);
		assert.equal(state.kind, "adapter-fixture"); assert.equal(state.targetPid, game.child.pid);
		const original = await game.request("fixture-identity");
		assert.notEqual(original.hostHwnd, "0"); assert.notEqual(original.gameHwnd, "0");
		const runtimePid = driver.getRuntimePid();
		await driver.testCommand("focus");
		assert.equal((await driver.api("status")).uiThreadHasFocus, true);
		let completedAt;
		const inFlight = driver.api("probe", { mode: "offline" }).then((result) => { completedAt = performance.now(); return result; });
		inFlight.catch(() => {});
		await until(() => driver.getState().busy && driver.getState().currentProbeToolFinished);
		const recovered = once(driver.events, "recovered");
		driver.beginUiHang();
		const [rescue] = await recovered;
		const result = await inFlight;
		assert.equal(rescue.reason, "ui-heartbeat-timeout");
		assert.equal(rescue.exitConfirmed, true);
		assert.equal(driver.getRuntimePid(), runtimePid);
		assert.equal(driver.getProbeSequence(), 1);
		assert.equal(result.executed, 1); assert.equal(result.requestCount, 2);
		assert.ok(completedAt > rescue.exitConfirmedAt);
		assert.deepEqual(await game.request("fixture-identity"), original);
		state = await driver.api("status");
		assert.equal(state.active, true); assert.equal(state.attached, false); assert.equal(state.gameAlive, true);
		await until(async () => (await evaluate("window.deck.snapshot()")).lastProbeResult?.executed === 1);
		await driver.api("attach", target.id);
		assert.equal((await driver.api("status")).attached, true);
		assert.deepEqual(await game.request("fixture-identity"), original);
		await driver.api("detach");
		const restored = await game.request("restored");
		for (const field of ["gameAlive", "gameVisible", "topLevel", "styleRestored", "exStyleRestored", "boundsRestored"])
			assert.equal(restored[field], true, field);
		const proof = {
			runId: driver.runId, fixtureOnly: true, realDsp: "not_connected", physicalInput: "not_tested", gameCalls: 0,
			privateEndpointDiscovery: true, actualElectronUiEmbedded: true, nativeFocusEstablished: true,
			osPeerVerifiedTransport: true, ownedUiExitConfirmed: true, uiReplacements: 1,
			heartbeatAgeAtDecisionMs: Math.round(rescue.heartbeatAgeMs),
			sameHostAndViewport: true, samePiRuntime: true, inFlightProbeCompletedAfterUiExit: true,
			noProbeReplay: true, oneExplicitReattachment: true, normalDetachRestoresBoth: true,
		};
		await mkdir(join(driver.root, ".local"), { recursive: true });
		await writeFile(join(driver.root, ".local/desktop-smoke-adapter.json"), JSON.stringify(proof, null, 2));
	} finally {
		try { await driver.api("detach"); } catch {}
		if (!game.stopped) { try { await game.request("close"); } catch { game.child.kill(); } }
	}
}
