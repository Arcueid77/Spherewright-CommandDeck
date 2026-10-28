import test from "node:test";
import assert from "node:assert/strict";
import { settleShutdown, closeUiAndWait } from "../apps/desktop/shutdown-drain.mjs";
test("a blocked observer close cannot delay delivery of development cancellation", async () => {
	let enter, release, drained = false, cancelled = false, settled = false; const entered = new Promise((done) => { enter = done; });
	const operation = settleShutdown([async () => { enter(); await new Promise((done) => { release = done; }); }, async () => { drained = true; cancelled = true; }]).then(() => { settled = true; });
	await entered; assert.equal(drained, true); assert.equal(cancelled, true); assert.equal(settled, false); release(); await operation; assert.equal(settled, true);
});
test("one failed participant cannot reopen the UI while the other is still draining", async () => {
	let release, enter, settled = false; const entered = new Promise((done) => { enter = done; });
	const operation = settleShutdown([async () => { throw new Error("MCP_EXIT_NOT_CONFIRMED"); }, async () => { enter(); await new Promise((done) => { release = done; }); }]);
	const rejected = assert.rejects(operation, /MCP_EXIT_NOT_CONFIRMED/).then(() => { settled = true; });
	await entered; assert.equal(settled, false); release(); await rejected; assert.equal(settled, true);
});

test("graceful UI exit finishes shutdown without a termination request", async () => {
	let exit, closes = 0; const facts = [], exited = new Promise(resolve => { exit = resolve; });
	const operation = closeUiAndWait({ exited, requestClose: () => { closes++; exit({ code: 0, signal: null }); }, terminate: () => assert.fail("Graceful exit must not be terminated"), report: value => facts.push(value) });
	assert.deepEqual(await operation, { code: 0, signal: null }); assert.equal(closes, 1);
	assert.deepEqual(facts.map(value => value.phase), ["close-requested", "exit-observed"]);
});

test("a UI that exits after both observation intervals still completes the original shutdown", async t => {
	let exit, pending, closes = 0, kills = 0, settled = false;
	const facts = [], exited = new Promise(resolve => { exit = resolve; }), waiting = new Promise(resolve => { pending = resolve; });
	t.after(() => exit({ code: 1, signal: null }));
	const operation = closeUiAndWait({ exited, requestClose: () => { closes++; }, terminate: () => { kills++; return false; }, gracefulMs: 5, terminationMs: 5,
		report: value => { facts.push(value); if (value.phase === "exit-pending") pending(); },
	}).then(value => { settled = true; return value; });
	await waiting; assert.equal(settled, false); assert.equal(closes, 1); assert.equal(kills, 1);
	assert.deepEqual(facts.at(-2), { phase: "termination-requested", submitted: false });
	exit({ code: null, signal: "SIGTERM" }); assert.deepEqual(await operation, { code: null, signal: "SIGTERM" });
	assert.equal(settled, true); assert.equal(kills, 1); assert.equal(facts.at(-1).phase, "exit-observed");
});

test("close and termination send errors cannot replace the UI's exit evidence", async t => {
	let exit, pending, settled = false; const facts = [], exited = new Promise(resolve => { exit = resolve; }), waiting = new Promise(resolve => { pending = resolve; });
	t.after(() => exit({ code: 1, signal: null }));
	const operation = closeUiAndWait({ exited, requestClose: () => { throw new Error("DISCONNECTED"); }, terminate: () => { throw new Error("SIGNAL_FAILED"); }, gracefulMs: 5, terminationMs: 5,
		report: value => { facts.push(value); if (value.phase === "exit-pending") pending(); },
	}).then(() => { settled = true; });
	await waiting; assert.equal(settled, false); assert.ok(facts.some(value => value.phase === "close-send-failed")); assert.ok(facts.some(value => value.phase === "termination-send-failed"));
	exit({ code: 1, signal: null }); await operation; assert.equal(settled, true); assert.equal(facts.at(-1).phase, "exit-observed");
});
