import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { NativeClient } from "../apps/desktop/native-client.mjs";
import { WindowHost } from "../apps/desktop/window-host.mjs";
import { registerOwnedUi } from "../apps/desktop/owned-ui-process.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
	const deadline = performance.now() + 10000;
	while (!(await check())) { if (performance.now() > deadline) throw new Error("ROUTE_PROOF_TIMEOUT"); await delay(50); }
}
function restored(state) {
	for (const key of ["gameAlive", "gameVisible", "topLevel", "styleRestored", "exStyleRestored", "boundsRestored"])
		assert.equal(state[key], true, key);
}
const game = new NativeClient(["--adapter-pipe-fixture"]);
const ui = new NativeClient(["--fixture"]);
let uiLease;
const router = new WindowHost();
let descriptorPath;
const proof = { fixtureOnly: true, actualUnity: false, gameCalls: 0 };
try {
	const [gameReady, uiReady] = await Promise.all([game.ready, ui.ready]);
	uiLease = registerOwnedUi(ui.child);
	descriptorPath = gameReady.descriptor;
	router.bindUi({ pid: uiReady.pid, hwnd: uiReady.hwnd });
	const target = (await router.request("list")).find((item) => item.id.startsWith("adapter:") && item.pid === game.child.pid);
	assert.ok(target);
	await router.request("attach", { targetId: target.id });
	const captureSource = await router.captureSource(), captureIdentity = await game.request("fixture-identity");
	assert.equal(captureSource.sourceId, `window:${captureIdentity.gameHwnd}:0`); assert.equal(captureSource.targetId, target.id);
	const capturePublicState = await router.request("status"); assert.equal("captureSource" in capturePublicState, false); assert.equal("sourceId" in capturePublicState, false);
	proof.privateCaptureSourceBindsSelectedWindow = true;
	await game.request("fixture-break-marker");
	await assert.rejects(router.captureSource(), /WINDOW_CAPTURE_GAME_CHANGED/);
	const original = router.adapter;
	assert.ok(original.transport.spawnargs.includes("--adapter-client"));
	const helperExited = once(original.transport, "exit");
	original.transport.kill(); await helperExited;
	const unknown = await router.request("status");
	assert.equal(unknown.uiOperationPending, true);
	assert.equal(unknown.fault, "ADAPTER_DISCONNECTED_UNRECONCILED");
	assert.equal(router.adapterId, target.id);
	assert.equal(router.adapter.latest.quarantined, true);
	assert.equal(router.adapter.latest.window.active, true);
	assert.equal(router.adapter.sequence, 0, "Reconnect must stop at read-only hello/status before reconciliation");
	await assert.rejects(router.request("detach"), /ADAPTER_REQUEST_REJECTED/);
	assert.equal(router.adapterId, target.id);
	await assert.rejects(router.request("attach", { targetId: target.id }), /RECONCILE_CURRENT_WINDOW_FIRST/);
	await assert.rejects(router.request("start-fixture"), /DETACH_CURRENT_WINDOW_FIRST/);
	proof.helperExitWithRestorationFailureStaysUnknown = true;
	proof.exactEndpointRetained = true;
	proof.noNewAttachmentOrFixtureWhileUnknown = true;
	await game.request("fixture-restore-marker");
	await router.request("detach");
	assert.equal(router.adapter, undefined);
	restored(await game.request("restored"));
	proof.explicitSamePeerReconciliationClearsBinding = true;
	await router.request("attach", { targetId: target.id });
	const cleanHelper = router.adapter;
	const cleanExited = once(cleanHelper.transport, "exit");
	cleanHelper.transport.kill(); await cleanExited;
	const clean = await router.request("status");
	assert.equal(clean.active, false); assert.equal(clean.attached, false); assert.equal(clean.uiOperationPending, false);
	assert.equal(router.adapter.latest.restorationProven, true);
	assert.equal(router.adapterId, target.id);
	restored(await game.request("restored"));
	await router.request("detach");
	proof.cleanEofRequiresFreshSamePeerProof = true;
	await router.request("attach", { targetId: target.id });
	let provenExits = 0;
	router.on("stopped", () => provenExits++);
	assert.ok(game.child.spawnargs.includes("--adapter-pipe-fixture"));
	const gameExited = once(game.child, "exit"); game.child.kill(); await gameExited;
	await until(() => router.adapter.stopped);
	await router.request("status");
	assert.equal(router.adapter, undefined); assert.equal(provenExits, 1);
	proof.originalProcessExitIndependentlyProven = true;
	await mkdir(".local", { recursive: true });
	await writeFile(".local/adapter-route-smoke.json", JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof));
} finally {
	try { await router.request("detach"); } catch {}
	if (!game.stopped) { try { await game.request("close"); } catch { game.child.kill(); } }
	if (game.stopped && descriptorPath) { try { await unlink(descriptorPath); } catch (error) { if (error.code !== "ENOENT") throw error; } }
	if (!ui.stopped) {
		const exited = once(ui.child, "exit");
		ui.child.stdin.write("close\n");
		// Parent death may invalidate the fixture's HWND without ending its message loop.
		// Cleanup only this registered, test-created UI; never wait indefinitely for its dead HWND.
		if (!(await Promise.race([exited.then(() => true), delay(2000).then(() => false)]))) {
			uiLease ??= registerOwnedUi(ui.child);
			assert.equal(uiLease.terminate(), true);
			assert.equal(await Promise.race([exited.then(() => true), delay(3000).then(() => false)]), true, "Owned UI cleanup exit not confirmed");
		}
	}
}
