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
	return { latencyMs, responsiveDuringHang: latencyMs < 750 };
}
try {
	const metadata = await ui.ready;
	await game.ready;
	await game.request("adopt", metadata);
	const status = await measureDuringUiHang("status");
	const resize = await measureDuringUiHang("exercise-host-resize");
	assert.equal((await game.request("status")).gameAlive, true);
	const proof = {
		fixtureOnly: true,
		gameCalls: 0,
		injectedUiHangMs: 2000,
		status,
		resize,
		bothSurvived: !ui.stopped && !game.stopped,
		conclusion:
			status.responsiveDuringHang && resize.responsiveDuringHang
				? "bounded_fixture_probe_only"
				: "cross_process_ui_coupling_blocks_qualification",
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
