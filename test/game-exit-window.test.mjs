import test from "node:test";
import assert from "node:assert/strict";
import { captureStableGameWindow, closeRestoredGameWindow } from "../apps/desktop/game-exit-window.mjs";

const identity = () => ({ sourceId: "window:12345:0", windowBinding: "a".repeat(32), gamePid: 12, gameStartedTicks: "638900000000000000", kind: "dsp", targetId: "adapter:synthetic" });

test("a verified menu exit restores the exact window before one normal close", async () => {
	const events = [], target = identity();
	const native = { captureSource: async () => { events.push("capture"); return { ...target }; }, request: async method => { events.push(method); return { attached: false, fault: null }; } };
	const run = async (_exe, _args, options) => { events.push("close"); assert.equal(options.windowsHide, true); assert.equal(options.env.COMMANDDECK_EXIT_HWND, "12345"); return { stdout: "GAME_EXIT_CONFIRMED\n" }; };
	assert.deepEqual(await closeRestoredGameWindow(native, target, run, { SystemRoot: "C:\\Windows" }), { gameExited: true, normalClose: true });
	assert.deepEqual(events, ["capture", "detach", "close"]);
});

test("a changed identity or unproved restoration never sends a close", async () => {
	let closes = 0, detaches = 0;
	const run = async () => { closes++; return { stdout: "GAME_EXIT_CONFIRMED" }; };
	const target = identity();
	await assert.rejects(closeRestoredGameWindow({ captureSource: async () => ({ ...target, gameStartedTicks: "638900000000000001" }), request: async () => { detaches++; } }, target, run, { SystemRoot: "C:\\Windows" }), /GAME_EXIT_WINDOW_CHANGED/);
	await assert.rejects(closeRestoredGameWindow({ captureSource: async () => target, request: async () => ({ attached: true }) }, target, run, { SystemRoot: "C:\\Windows" }), /GAME_EXIT_WINDOW_RESTORATION_UNPROVED/);
	assert.equal(closes, 0); assert.equal(detaches, 0);
});

test("only transient layout readiness is retried, never an identity failure", async () => {
	let reads = 0;
	const result = await captureStableGameWindow({ captureSource: async () => { if (++reads < 3) throw new Error("WINDOW_CAPTURE_NOT_READY"); return identity(); } }, 1000);
	assert.equal(result.gamePid, 12); assert.equal(reads, 3);
	reads = 0;
	await assert.rejects(captureStableGameWindow({ captureSource: async () => { reads++; throw new Error("WINDOW_CAPTURE_SELECTION_CHANGED"); } }, 1000), /WINDOW_CAPTURE_SELECTION_CHANGED/);
	assert.equal(reads, 1);
});
