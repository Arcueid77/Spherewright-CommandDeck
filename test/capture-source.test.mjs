import test from "node:test";
import assert from "node:assert/strict";
import { boundCaptureSource } from "../apps/desktop/capture-source.mjs";
import { WindowHost } from "../apps/desktop/window-host.mjs";

function fixture() {
	const descriptor = { gamePid: 1234, gameStartedTicks: "639288000000000000", adapterVersion: "0.0.1", kind: "fixture" };
	const reply = { ...descriptor, ready: true, quarantined: false, windowCaptureSource: 1, window: { active: true, attached: true, gameAlive: true, gameParentMatches: true, nativeParentMatches: true, hostVisible: true, uiVisible: true, layoutRequested: 3, layoutApplied: 3, uiOperationPending: false }, captureSource: { version: 1, hwnd: "87654", sourceId: "window:87654:0", windowBinding: "a".repeat(32), width: 620, height: 410, layoutRevision: 3 } };
	const calls = [], router = new WindowHost(); router.adapterId = "adapter:owned-fixture"; router.bindUi({ pid: 2345, hwnd: "111" });
	router.adapter = { descriptor, latest: reply, request: async method => { calls.push(method); return reply; } };
	return { descriptor, reply, router, calls };
}
test("capture identity is private, fixed to the selected adapter and read-only", async () => {
	const f = fixture(), source = await f.router.captureSource();
	assert.equal(Object.isFrozen(source), true); assert.equal(source.sourceId, "window:87654:0"); assert.equal(source.targetId, f.router.adapterId); assert.deepEqual(f.calls, ["capture-source"]);
	const publicState = await f.router.request("status");
	for (const name of ["captureSource", "sourceId", "hwnd", "windowBinding", "gameStartedTicks"]) assert.equal(name in publicState, false);
});
test("capture metadata refuses wrong identity, foreign sources, stale geometry and unsafe states", () => {
	const f = fixture();
	for (const change of [value => value.gamePid++, value => value.kind = "dsp", value => value.gameStartedTicks += "0"]) {
		const value = structuredClone(f.reply); change(value); assert.throws(() => boundCaptureSource(value, f.descriptor), /WINDOW_CAPTURE_IDENTITY_CHANGED/);
	}
	for (const change of [value => value.captureSource.sourceId = "screen:0:0", value => value.captureSource.hwnd = "087654", value => value.captureSource.windowBinding = "bad", value => value.captureSource.windowBinding = ["a".repeat(32)], value => value.captureSource.width = 0, value => value.captureSource.height = 32769, value => value.captureSource.layoutRevision--]) {
		const value = structuredClone(f.reply); change(value); assert.throws(() => boundCaptureSource(value, f.descriptor), /WINDOW_CAPTURE_SOURCE_UNCONFIRMED/);
	}
	for (const change of [value => value.quarantined = true, value => value.quarantined = undefined, value => value.ready = "true", value => value.window.gameAlive = false, value => value.window.uiOperationPending = 0, value => value.window.uiOperationPending = true, value => value.window.layoutRequested++, value => value.window.gameParentMatches = false, value => value.window.uiVisible = false]) {
		const value = structuredClone(f.reply); change(value); assert.throws(() => boundCaptureSource(value, f.descriptor), /WINDOW_CAPTURE_NOT_READY/);
	}
});
test("capture queries refuse unsupported, disconnected or unresolved selections before sending", async () => {
	for (const change of [f => f.router.adapter = null, f => f.router.adapterId = null, f => f.router.binding = null, f => f.router.adapterUnknown = true, f => f.router.transitions = 1, f => f.router.adapter.stopped = true]) {
		const f = fixture(); change(f); await assert.rejects(f.router.captureSource(), /WINDOW_CAPTURE_SELECTION_REQUIRED/); assert.equal(f.calls.length, 0);
	}
	const f = fixture(); delete f.reply.windowCaptureSource; await assert.rejects(f.router.captureSource(), /WINDOW_CAPTURE_UNSUPPORTED/); assert.equal(f.calls.length, 0);
});
test("a late capture response cannot cross UI binding or adapter replacement", async () => {
	for (const change of [f => f.router.bindUi({ pid: 3456, hwnd: "222" }), f => f.router.adapter = { ...f.router.adapter }, f => f.router.adapterUnknown = true]) {
		const f = fixture(); let resolve; const pending = new Promise(done => { resolve = done; }); f.router.adapter.request = () => pending;
		const operation = f.router.captureSource(); change(f); resolve(f.reply); await assert.rejects(operation, /WINDOW_CAPTURE_SELECTION_CHANGED/);
	}
});
