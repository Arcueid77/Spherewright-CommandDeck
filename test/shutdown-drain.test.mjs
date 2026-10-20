import test from "node:test";
import assert from "node:assert/strict";
import { settleShutdown } from "../apps/desktop/shutdown-drain.mjs";
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
