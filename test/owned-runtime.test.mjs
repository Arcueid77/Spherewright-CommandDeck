import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { trackOwnedRuntimeExit } from "../apps/desktop/owned-runtime.mjs";

test("a runtime termination request cannot stand in for its observed exit", async () => {
	const runtime = new EventEmitter(); let kills = 0, settled = false;
	runtime.kill = () => { kills++; return true; };
	const owned = trackOwnedRuntimeExit(runtime), stopping = owned.stop().then(() => { settled = true; });
	await Promise.resolve(); assert.equal(kills, 1); assert.equal(settled, false); assert.equal(owned.exited, false);
	runtime.emit("exit", 0); await stopping; assert.equal(settled, true); assert.equal(owned.exited, true);
});

test("an already observed runtime exit does not send a second termination", async () => {
	const runtime = new EventEmitter(); runtime.kill = () => assert.fail("Exited runtime must not be killed again");
	const owned = trackOwnedRuntimeExit(runtime); runtime.emit("exit", 1); await owned.stop(); assert.equal(owned.exited, true);
});

test("missing runtime exit rejects the startup cleanup rather than permitting a blocked-page success", async () => {
	const runtime = new EventEmitter(); runtime.kill = () => true;
	const owned = trackOwnedRuntimeExit(runtime); await assert.rejects(owned.stop(5), /RUNTIME_EXIT_NOT_CONFIRMED/); assert.equal(owned.exited, false);
	runtime.emit("exit", 1); assert.equal(owned.exited, true);
});
