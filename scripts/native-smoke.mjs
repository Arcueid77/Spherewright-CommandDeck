import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	NativeClient,
	nativeExecutable,
} from "../apps/desktop/native-client.mjs";

const executable = process.argv.includes("--isolated-build")
	? fileURLToPath(
			new URL(
				"../.local/native-hang/CommandDeck.NativeHost.exe",
				import.meta.url,
			),
		)
	: nativeExecutable;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, timeout = 5000) {
	const deadline = Date.now() + timeout;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("FIXTURE_STATE_TIMEOUT");
		await delay(50);
	}
}
async function pair() {
	const ui = new NativeClient(["--fixture"], executable);
	const game = new NativeClient(["--owned-host-fixture"], executable);
	const metadata = await ui.ready;
	assert.equal(metadata.visible, true);
	assert.equal((await game.ready).visible, true);
	await game.request("adopt", metadata);
	return { ui, game };
}
async function cleanup({ ui, game }) {
	if (!game.stopped && game.child.stdin.writable) {
		try {
			await game.request("close");
		} catch {}
	}
	// These PIDs are solely test-created simulator processes; never DSP.
	if (!ui.stopped) {
		ui.child.stdin.write("close\n");
		await once(ui.child, "exit");
	}
	if (!game.stopped) game.child.kill();
}
const proof = {
	fixtureOnly: true,
	gameCalls: 0,
	design: "game-process-owns-host",
};
let current;
try {
	current = await pair();
	let state = await current.game.request("status");
	assert.equal(state.nativeParentMatches, true);
	assert.equal(state.uiChildStyle, true);
	assert.equal(state.gameParentMatches, true);
	assert.equal(state.gameOwnerPid, current.game.child.pid);
	assert.equal(state.hostOwnerPid, current.game.child.pid);
	proof.ownership = "passed";
	proof.visibleFixtureReadiness = "passed";
	await current.game.request("rect", {
		x: 340,
		y: 85,
		width: 700,
		height: 500,
		visible: true,
	});
	const input = await current.game.request("exercise-input");
	assert.ok(
		input.clicks > 0 && input.keys > 0 && input.wheel > 0 && input.panX > 0,
		JSON.stringify(input),
	);
	proof.syntheticInputHandlers = "passed";
	current.game.child.stdout.pause();
	const burst = current.game.request("exercise-backpressure");
	await delay(1500);
	const resumedReadingAt = Date.now();
	current.game.child.stdout.resume();
	const burstReply = await burst;
	assert.ok(burstReply.processedAt < resumedReadingAt - 500);
	proof.outputBackpressure = "native_ui_not_blocked";
	await assert.rejects(
		current.game.request("rect", {
			x: -1,
			y: 0,
			width: 100,
			height: 100,
			visible: true,
		}),
		/INVALID_VIEWPORT/,
	);
	proof.resizeAndBadRect = "passed";
	await current.game.request("detach");
	await until(() => current.ui.latest?.parent === "0");
	await until(
		() =>
			current.ui.latest?.styleRestored &&
			current.ui.latest?.exStyleRestored &&
			current.ui.latest?.boundsRestored,
	);
	proof.normalDetach = "passed";
	await current.game.request("adopt", await current.ui.ready);
	const stoppedUi = once(current.ui.child, "exit");
	current.ui.child.kill();
	await stoppedUi;
	await until(
		() =>
			current.game.latest?.attached === false &&
			current.game.latest?.viewportFull === true,
	);
	state = await current.game.request("status");
	assert.equal(state.gameAlive, true);
	assert.equal(current.game.child.exitCode, null);
	proof.deckProcessExit = "game_survived";
	await cleanup(current);
	current = await pair();
	current.game.child.stdin.end();
	await until(
		() =>
			current.game.latest?.connected === false &&
			current.game.latest?.attached === false,
	);
	await until(() => current.ui.latest?.parent === "0");
	assert.equal(current.game.child.exitCode, null);
	assert.equal(current.ui.child.exitCode, null);
	proof.bridgeDisconnect = "both_survived";
	await cleanup(current);
	current = await pair();
	await current.game.request("close");
	await until(() => current.ui.latest?.parent === "0");
	assert.equal(current.ui.child.exitCode, null);
	proof.gameHostNormalExit = "deck_survived";
	proof.realDsp = "not_connected";
	proof.humanInput = "pending_manual";
	await mkdir(".local", { recursive: true });
	await writeFile(".local/native-smoke.json", JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof));
} finally {
	if (current) await cleanup(current);
}
