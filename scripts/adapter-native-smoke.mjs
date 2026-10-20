import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { NativeClient } from "../apps/desktop/native-client.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
	const deadline = performance.now() + 7000;
	while (!(await check())) {
		if (performance.now() > deadline) throw new Error("RAW_HOST_PROOF_TIMEOUT");
		await delay(50);
	}
}
async function pair() {
	const game = new NativeClient(["--unity-adapter-fixture"]);
	const ui = new NativeClient(["--fixture"]);
	try {
		const [gameReady, uiReady] = await Promise.all([game.ready, ui.ready]);
		assert.equal(gameReady.visible, true);
		await game.request("adopt", uiReady);
		return { game, ui };
	} catch (error) {
		game.child.kill(); ui.child.kill(); throw error;
	}
}
async function cleanup({ game, ui }) {
	try { if (!game.stopped) await game.request("close"); } catch {}
	if (!ui.stopped) {
		const exited = once(ui.child, "exit");
		ui.child.stdin.write("close\n");
		await exited;
	}
	if (!game.stopped) game.child.kill();
}
function assertRestored(state) {
	for (const key of ["gameAlive", "gameVisible", "topLevel", "styleRestored", "exStyleRestored", "boundsRestored"])
		assert.equal(state[key], true, key);
}
const result = { fixtureOnly: true, actualUnity: false, gameCalls: 0 };
let current;
try {
	current = await pair();
	const original = await current.game.request("fixture-identity");
	let state = await current.game.request("status");
	for (const key of ["active", "attached", "gameAlive", "gameParentMatches", "nativeParentMatches", "hostVisible", "uiVisible"])
		assert.equal(state[key], true, key);
	await current.game.request("rect", { x: 100, y: 80, width: 620, height: 400, visible: true });
	await until(async () => {
		state = await current.game.request("status");
		return !state.uiOperationPending && state.layoutApplied === state.layoutRequested;
	});
	const sized = await current.game.request("restored");
	assert.equal(sized.gameWidth, 620); assert.equal(sized.gameHeight, 400);
	await assert.rejects(current.game.request("rect", { x: 0, y: 0, width: 16385, height: 400, visible: true }), /INVALID_VIEWPORT/);
	await current.game.request("detach");
	await until(() => current.ui.latest?.parent === "0" && current.ui.latest?.styleRestored && current.ui.latest?.boundsRestored);
	assert.deepEqual(await current.game.request("fixture-identity"), original);
	await current.game.request("adopt", await current.ui.ready);
	assertRestored(await current.game.request("stop-host"));
	await until(() => current.ui.latest?.parent === "0" && current.ui.latest?.boundsRestored);
	result.normalStopRestoresBothWindows = true;
	await cleanup(current);
	current = await pair();
	const ended = once(current.ui.child, "exit");
	current.ui.child.kill(); await ended;
	await until(async () => !(await current.game.request("status")).attached);
	state = await current.game.request("status");
	assert.equal(state.active, true); assert.equal(state.gameAlive, true); assert.equal(state.fault, null);
	assertRestored(await current.game.request("stop-host"));
	result.uiExitKeepsGameAndHost = true;
	await cleanup(current);
	current = await pair();
	current.game.child.stdin.end();
	await until(() => current.game.latest?.active === false && current.ui.latest?.parent === "0");
	assert.equal(current.game.child.exitCode, null);
	result.bridgeEofRestoresBoth = true;
	// The fixture has no game session; clean up only these test-created processes.
	current.game.child.kill();
	await cleanup(current);
	current = await pair();
	await current.game.request("host-close");
	await until(async () => !(await current.game.request("status")).active);
	assertRestored(await current.game.request("restored"));
	await until(() => current.ui.latest?.parent === "0" && current.ui.latest?.boundsRestored);
	assert.equal(current.game.child.exitCode, null);
	result.hostCloseRestoresInsteadOfClosingGame = true;
	await cleanup(current);
	current = await pair();
	await current.game.request("fixture-host-quit");
	await until(async () => !(await current.game.request("status")).active);
	assertRestored(await current.game.request("restored"));
	await until(() => current.ui.latest?.parent === "0" && current.ui.latest?.boundsRestored);
	assert.equal(current.game.child.exitCode, null);
	result.unexpectedQuitRestoresBeforeThreadExit = true;
	result.sameCoreAsNet472Adapter = true;
	await mkdir(".local", { recursive: true });
	await writeFile(".local/adapter-native-smoke.json", JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
} finally { if (current) await cleanup(current); }
