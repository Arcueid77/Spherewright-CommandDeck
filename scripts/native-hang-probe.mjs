import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	NativeClient,
	nativeExecutable,
} from "../apps/desktop/native-client.mjs";

// This alternate output lets the running preview stay open during a fixture-only experiment.
const executable = process.argv.includes("--isolated-build")
	? fileURLToPath(
			new URL(
				"../.local/native-hang/CommandDeck.NativeHost.exe",
				import.meta.url,
			),
		)
	: nativeExecutable;
const ui = new NativeClient(["--fixture"], executable);
const game = new NativeClient(["--owned-host-fixture"], executable);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function settledLayout() {
	const deadline = Date.now() + 5000;
	while (true) {
		const state = await game.request("status");
		assert.equal(state.layoutError, null);
		if (!state.uiOperationPending && !state.layoutPending) {
			assert.equal(state.layoutApplied, state.layoutRequested);
			return;
		}
		if (Date.now() > deadline) throw new Error("LAYOUT_DID_NOT_SETTLE");
		await delay(25);
	}
}
async function bounded(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("HANG_PROBE_TIMEOUT")), 6000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function measureDuringUiHang(method) {
	const started = once(ui, "diagnostic");
	ui.child.stdin.write("hang-ui\n");
	assert.equal((await bounded(started))[0].phase, "ui-hang-start");
	const recovered = once(ui, "diagnostic");
	const start = performance.now();
	await game.request(method);
	const latencyMs = Math.round(performance.now() - start);
	assert.equal((await bounded(recovered))[0].phase, "ui-hang-end");
	await settledLayout();
	return { latencyMs, responsiveDuringHang: latencyMs < 750 };
}
try {
	const metadata = await ui.ready;
	assert.equal(metadata.visible, true);
	assert.equal((await game.ready).visible, true);
	await game.request("adopt", metadata);
	const status = await measureDuringUiHang("status");
	const resize = await measureDuringUiHang("exercise-host-resize");
	assert.equal(
		status.responsiveDuringHang,
		true,
		"Host UI blocked during a foreign UI hang",
	);
	assert.equal(
		resize.responsiveDuringHang,
		true,
		"Host resize blocked during a foreign UI hang",
	);
	// Restore must drain the pending geometry, not race it or replay it after detachment.
	const started = once(ui, "diagnostic");
	ui.child.stdin.write("hang-ui\n");
	await bounded(started);
	const recovered = once(ui, "diagnostic");
	await game.request("exercise-host-resize");
	const detached = game.request("detach");
	const pingAt = performance.now();
	await game.request("status");
	assert.ok(performance.now() - pingAt < 750);
	await detached;
	await bounded(recovered);
	await delay(400);
	assert.equal(ui.latest?.parent, "0");
	assert.equal(ui.latest?.styleRestored, true);
	assert.equal(ui.latest?.exStyleRestored, true);
	assert.equal(ui.latest?.boundsRestored, true);
	assert.equal((await game.request("status")).attached, false);
	assert.equal((await game.request("status")).gameAlive, true);
	const proof = {
		fixtureOnly: true,
		gameCalls: 0,
		injectedUiHangMs: 2000,
		status,
		resize,
		pendingLayoutBeforeDetach: "drained_and_restored",
		bothSurvived: !ui.stopped && !game.stopped,
		conclusion: "bounded_fixture_regression_passed",
		realDsp: "not_connected",
	};
	await mkdir(".local", { recursive: true });
	await writeFile(
		".local/native-hang-probe.json",
		JSON.stringify(proof, null, 2),
	);
	console.log(JSON.stringify(proof));
} finally {
	try {
		if (!game.stopped) await game.request("close");
	} catch {}
	if (!ui.stopped) {
		const exited = once(ui.child, "exit");
		ui.child.stdin.write("close\n");
		try {
			await bounded(exited);
		} catch {
			ui.child.kill();
		}
	}
	if (!game.stopped) game.child.kill();
}
