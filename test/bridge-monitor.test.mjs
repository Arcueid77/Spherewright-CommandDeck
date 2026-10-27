import test from "node:test";
import assert from "node:assert/strict";
import { BridgeMonitor } from "../apps/desktop/bridge-monitor.mjs";
const selection = { path: "owned-fixture/Spherewright.Mcp.exe", cohortHash: "a".repeat(64), fileCount: 4 };

test("power pause retains the exact client and generation while rejecting reconnect and new research", async () => {
	const f = fixture(); await f.monitor.select(selection.path);
	const client = f.monitor.telemetry.client, generation = f.monitor.snapshot().connectionGeneration;
	f.monitor.setSystemPaused(true); assert.equal(f.monitor.snapshot().observation.connected, false);
	await assert.rejects(f.monitor.connect(), /SYSTEM_POWER_PAUSED/); assert.throws(() => f.monitor.acquireResearch({}), /SYSTEM_POWER_PAUSED/);
	f.monitor.poll(); f.monitor.refresh(); assert.equal(f.starts(), 1);
	f.monitor.setSystemPaused(false); assert.equal(f.monitor.telemetry.client, client); assert.equal(f.monitor.snapshot().connectionGeneration, generation);
	assert.equal(f.starts(), 1); await f.monitor.close();
});
function fixture() {
	let hash = selection.cohortHash, starts = 0, failClose = false;
	const monitor = new BridgeMonitor({ fingerprint: async () => ({ ...selection, cohortHash: hash }), launch() {
		starts++; return { closed: false, stats: { toolCalls: 0 }, async discover() { return { serverVersion: "fixture", toolCount: 0, resourceCount: 0, readTools: [] }; }, supports: () => false, async close() { if (failClose) throw new Error("MCP_EXIT_NOT_CONFIRMED"); this.closed = true; } };
	} });
	return { monitor, starts: () => starts, change: () => { hash = "b".repeat(64); }, blockClose: () => { failClose = true; } };
}
test("a selected observer survives UI snapshots but reconnect checks its exact cohort", async () => {
	const f = fixture(); assert.equal(f.starts(), 0); assert.equal(f.monitor.snapshot().connectionGeneration, 0); await f.monitor.select(selection.path); assert.equal(f.starts(), 1); assert.equal(f.monitor.snapshot().connectionGeneration, 1);
	for (let index = 0; index < 5; index++) f.monitor.snapshot(); assert.equal(f.starts(), 1);
	await f.monitor.disconnect(); assert.equal(f.monitor.snapshot().observation.connected, false); f.change();
	await assert.rejects(f.monitor.connect(), /COHORT_CHANGED_RESELECT/); assert.equal(f.starts(), 1); assert.equal(f.monitor.snapshot().connectionGeneration, 1);
	await f.monitor.select(selection.path); assert.equal(f.starts(), 2); assert.equal(f.monitor.snapshot().connectionGeneration, 2); await f.monitor.close();
});
test("an unconfirmed old MCP exit blocks replacement rather than starting a second process", async () => {
	const f = fixture(); await f.monitor.select(selection.path); f.blockClose();
	await assert.rejects(f.monitor.select(selection.path), /MCP_EXIT_NOT_CONFIRMED/); assert.equal(f.starts(), 1); assert.equal(f.monitor.snapshot().error, "MCP_EXIT_NOT_CONFIRMED");
});
test("close waits for an in-flight discovery and prevents it from becoming an active observer", async () => {
	let entered, release, closed = 0; const barrier = new Promise((done) => { entered = done; });
	const monitor = new BridgeMonitor({ fingerprint: async () => selection, launch: () => ({ async discover() { entered(); await new Promise((done) => { release = done; }); return {}; }, async close() { closed++; } }) });
	const selecting = monitor.select(selection.path); const rejected = assert.rejects(selecting, /BRIDGE_MONITOR_CLOSING/); await barrier;
	await assert.rejects(monitor.connect(), /BRIDGE_CONNECTION_BUSY/); const closing = monitor.close(); release(); await rejected; await closing;
	assert.equal(closed, 1); assert.equal(monitor.snapshot().observation, null);
});
test("a failed startup retains the original client until its exit is confirmed", async () => {
	let starts = 0;
	const monitor = new BridgeMonitor({ fingerprint: async () => selection, launch: () => { starts++; return { async discover() { throw new Error("MCP_DISCOVERY_FAILED"); }, async close() { throw new Error("MCP_EXIT_NOT_CONFIRMED"); } }; } });
	await assert.rejects(monitor.select(selection.path), /MCP_EXIT_NOT_CONFIRMED/);
	await assert.rejects(monitor.select(selection.path), /MCP_EXIT_NOT_CONFIRMED/);
	assert.equal(starts, 1); assert.ok(monitor.pendingClient);
});
