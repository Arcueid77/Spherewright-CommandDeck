import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { NativeClient, nativeExecutable } from "../apps/desktop/native-client.mjs";
import { inspectOwnedUi } from "../apps/desktop/inspect-ui.mjs";
import { registerOwnedUi } from "../apps/desktop/owned-ui-process.mjs";

const execute = promisify(execFile), ui = new NativeClient(["--fixture"]), lease = registerOwnedUi(ui.child);
async function bounded(value) {
	let timer; try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("UI_PROBE_FIXTURE_TIMEOUT")), 6000); })]); }
	finally { clearTimeout(timer); }
}
try {
	const metadata = await ui.ready, record = { child: ui.child, hwnd: metadata.hwnd };
	const healthy = await inspectOwnedUi(record, { responsiveness: true });
	assert.equal(healthy.probeStatus, "responsive"); assert.equal(healthy.responding, true);
	const started = once(ui, "diagnostic"); ui.child.stdin.write("pump-ui\n");
	assert.equal((await bounded(started))[0].phase, "native-pump-start");
	const ended = once(ui, "diagnostic");
	const pumping = await inspectOwnedUi(record, { responsiveness: true });
	assert.equal(pumping.probeStatus, "responsive");
	assert.equal((await bounded(ended))[0].phase, "native-pump-end");
	const hangStart = once(ui, "diagnostic"); ui.child.stdin.write("hang-ui\n");
	assert.equal((await bounded(hangStart))[0].phase, "ui-hang-start");
	const hangEnd = once(ui, "diagnostic");
	const blocked = await inspectOwnedUi(record, { responsiveness: true });
	assert.equal(blocked.probeStatus, "timeout"); assert.equal(blocked.responding, false);
	assert.ok(blocked.probeElapsedMs < 1000);
	await bounded(hangEnd);
	const { stdout } = await execute(nativeExecutable, ["--probe-ui", metadata.hwnd, String(process.pid)], { windowsHide: true, timeout: 3000 });
	const wrong = JSON.parse(stdout); assert.equal(wrong.pidMatches, false); assert.equal(wrong.probeStatus, "identity_changed");
	await mkdir(".local", { recursive: true });
	await writeFile(".local/ui-watchdog-native.json", JSON.stringify({ healthy: true, nestedNativePump: true, hang: blocked.probeStatus, boundedNativeTimeoutMs: 120, observedProbeElapsedMs: blocked.probeElapsedMs, totalProbeMs: blocked.totalProbeMs, wrongIdentityRejected: true, gameCalls: 0 }, null, 2));
	console.log(JSON.stringify({ watchdogNative: "passed", gameCalls: 0 }));
} finally {
	if (ui.child.exitCode === null && ui.child.signalCode === null) {
		const exited = once(ui.child, "exit"); ui.child.stdin.write("close\n");
		try { await bounded(exited); } catch { lease.terminate(); await bounded(exited); }
	}
}
