import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";

function client(t, mode = "normal", timeoutMs = 1000) {
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), mode], { windowsHide: true, stdio: "pipe" });
	const value = new ReadOnlyMcpClient(child, { timeoutMs }); t.after(() => value.close()); return value;
}
test("MCP discovery follows cursors and only enables explicitly supported read schemas", async (t) => {
	const c = client(t), metadata = await c.discover();
	assert.equal(metadata.toolCount, 5); assert.equal(metadata.resourceCount, 1); assert.equal(metadata.readTools.length, 4);
	assert.equal(c.supports("spherewright_commit_select_research"), false);
	await assert.rejects(c.read("spherewright_commit_select_research", {}), /READ_NOT_SUPPORTED/);
	await assert.rejects(c.read("spherewright_get_status", { execute: true }), /READ_NOT_SUPPORTED/);
	await assert.rejects(c.read("spherewright_get_overseer_production", { sessionId: "fixture", itemIds: [1, 1] }), /READ_NOT_SUPPORTED/);
	assert.equal(c.stats.toolCalls, 0);
	assert.equal((await c.read("spherewright_get_status")).success, true); assert.equal(c.stats.toolCalls, 1);
});
test("read-only annotations and required schema changes fail closed", async (t) => {
	for (const mode of ["bad-hint", "bad-schema"]) { const c = client(t, mode); await c.discover(); assert.equal(c.supports("spherewright_get_status"), false); await assert.rejects(c.read("spherewright_get_status"), /READ_NOT_SUPPORTED/); assert.equal(c.stats.toolCalls, 0); }
});
test("failed or repeated discovery cannot retain a partially authorized tool table", async (t) => {
	const bad = client(t, "invalid-suffix"); await assert.rejects(bad.discover(), /MCP_DUPLICATE_OR_INVALID_TOOL/);
	assert.equal(bad.supports("spherewright_get_status"), false); await assert.rejects(bad.read("spherewright_get_status"), /READ_NOT_SUPPORTED/); assert.equal(bad.stats.toolCalls, 0);
	const good = client(t), discovering = good.discover();
	assert.equal(good.supports("spherewright_get_status"), false); await assert.rejects(good.discover(), /ALREADY_STARTED/); await discovering;
	const requests = good.stats.requests; await assert.rejects(good.discover(), /ALREADY_STARTED/); assert.equal(good.stats.requests, requests);
});
test("a server capability-change notification invalidates the existing read table", async (t) => {
	const c = client(t, "revoke"); await c.discover(); await c.read("spherewright_get_status");
	const deadline = Date.now() + 1000; while (!c.closed && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
	assert.equal(c.supports("spherewright_get_status"), false); await assert.rejects(c.read("spherewright_get_status"), /READ_NOT_SUPPORTED/); assert.equal(c.stats.toolCalls, 1);
});
test("MCP timeouts and malformed frames end only the owned server and never retry a read", async (t) => {
	for (const mode of ["stall", "malformed", "repeat-cursor"]) {
		const c = client(t, mode, 200);
		await assert.rejects(c.discover(), /MCP_REQUEST_TIMEOUT|MCP_INVALID_MESSAGE|MCP_DISCOVERY_CURSOR_INVALID/);
		await c.close(); assert.equal(c.exitConfirmed, true);
	}
});
test("a real buffered pipe reply delivered after timeout cannot complete or revive the original request", async t => {
	const c = client(t, "normal", 2000); await c.discover(); const stream = c.child.stdout, delivered = [];
	stream.pause(); stream.on("data", bytes => delivered.push({ closed: c.closed, bytes: bytes.toString() }));
	const requests = c.stats.requests, pending = c.read("spherewright_get_status"), refused = assert.rejects(pending, { message: "MCP_REQUEST_TIMEOUT" });
	while (!stream.readableLength && !c.closed) await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(stream.readableLength > 0, "LATE_REPLY_NOT_BUFFERED_BEFORE_TIMEOUT");
	assert.equal(c.closed, false); assert.equal(c.requestPerformance().pending, 1);
	await refused; assert.equal(c.closed, true); assert.equal(c.requestPerformance().transportStopReason, "MCP_REQUEST_TIMEOUT"); stream.resume();
	const deliveryDeadline = performance.now() + 1000;
	while (!delivered.length) { assert.ok(performance.now() < deliveryDeadline, "BUFFERED_REPLY_NOT_DELIVERED"); await new Promise(resolve => setTimeout(resolve, 5)); }
	assert.ok(delivered.every(part => part.closed));
	const replies = delivered.map(part => part.bytes).join("").trim().split(/\r?\n/).map(line => JSON.parse(line));
	assert.equal(replies.length, 1); assert.equal(replies[0].result.structuredContent.success, true);
	assert.equal(c.requestPerformance().byKind.tool.responses, 0); assert.equal(c.requestPerformance().byKind.tool.aborted, 1); assert.equal(c.requestPerformance().pending, 0);
	await assert.rejects(c.read("spherewright_get_status"), { message: "MCP_READ_NOT_SUPPORTED" }); assert.equal(c.stats.requests, requests + 1);
	await c.close(); assert.equal(c.exitConfirmed, true); assert.equal(c.requestPerformance().transportStopReason, "MCP_REQUEST_TIMEOUT");
});

test("the discovery budget bounds the whole metadata sequence rather than each page separately", async (t) => {
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), "slow-metadata"], { windowsHide: true, stdio: "pipe" });
	const c = new ReadOnlyMcpClient(child, { timeoutMs: 5000, discoveryTimeoutMs: 2000 }); t.after(() => c.close());
	await assert.rejects(c.discover(), /MCP_DISCOVERY_TIMEOUT/); assert.equal(c.closed, true); assert.equal(c.supports("spherewright_get_status"), false); assert.ok(c.stats.requests <= 3); assert.equal(c.stats.toolCalls, 0);
});
test("duplicate replies are ignored and raw MCP errors are not forwarded", async (t) => {
	const c = client(t, "duplicate"); await c.discover(); await c.read("spherewright_get_status");
	assert.equal(c.stats.toolCalls, 1);
	await c.read("spherewright_get_session_state"); // A later response is a stream-order barrier for the first duplicate.
	assert.ok(c.stats.duplicateReplies >= 1); assert.equal(c.stats.toolCalls, 2); assert.equal(c.stats.requests, 6);
	const bad = client(t, "error"); await bad.discover(); await assert.rejects(bad.read("spherewright_get_status"), (error) => error.message === "MCP_REQUEST_REJECTED" && error.cause === undefined);
});
test("MCP tool-level errors and malformed error flags cannot become successful structured reads", async (t) => {
	for (const mode of ["tool-error", "bad-error-flag"]) {
		const c = client(t, mode); await c.discover();
		await assert.rejects(c.read("spherewright_get_status"), (error) => ["MCP_TOOL_REJECTED", "MCP_TOOL_ERROR_FLAG_INVALID"].includes(error.message) && error.cause === undefined && !JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("SYNTHETIC_RAW_TOOL_ERROR"));
		assert.equal(c.stats.toolCalls, 1);
	}
});

test("client measurements count admitted requests independently of snapshots, duplicates and local rejections", async t => {
	const c=client(t,'duplicate');await c.discover();
	assert.equal(c.requestPerformance().byKind.metadata.started,4);assert.equal(c.requestPerformance().byKind.tool.durationMs,null);
	await assert.rejects(c.read('spherewright_get_status',{unexpected:true}),/READ_NOT_SUPPORTED/);
	const reads=Array.from({length:8},()=>c.read('spherewright_get_status'));
	const rejected=assert.rejects(c.read('spherewright_get_status'),/UNAVAILABLE_OR_BUSY/);
	assert.equal(c.requestPerformance().pending,8);assert.equal(c.requestPerformance().byKind.tool.started,8);
	await Promise.all(reads);await rejected;await c.read('spherewright_get_session_state');
	const before=c.stats.requests;for(let index=0;index<50;index++)c.requestPerformance();assert.equal(c.stats.requests,before);
	const value=c.requestPerformance();assert.equal(value.started,c.stats.requests);assert.equal(value.byKind.tool.started,9);assert.equal(value.responses,value.started);assert.equal(value.pending,0);assert.equal(value.peakPending,8);
	assert.equal(value.rejectedBeforeAdmission,1);assert.ok(value.duplicateReplies>=8);assert.ok(value.byKind.tool.durationMs.meanMs>=0);
	assert.equal(value.source,'mcp_client_monotonic_v1');assert.ok(!JSON.stringify(value).includes('spherewright_get_status'));
	await c.close();const duration=c.requestPerformance().lifetime.durationMs;await new Promise(done=>setTimeout(done,20));
	assert.equal(c.requestPerformance().lifetime.state,'exit_observed');assert.equal(c.requestPerformance().lifetime.durationMs,duration);
});
test("RPC responses, RPC errors and aborted transport remain distinct from tool success", async t => {
	const bad=client(t,'error');await bad.discover();await assert.rejects(bad.read('spherewright_get_status'),/REQUEST_REJECTED/);
	assert.equal(bad.requestPerformance().byKind.tool.rpcErrors,1);assert.equal(bad.requestPerformance().byKind.tool.responses,0);
	const tool=client(t,'tool-error');await tool.discover();await assert.rejects(tool.read('spherewright_get_status'),/TOOL_REJECTED/);
	assert.equal(tool.requestPerformance().byKind.tool.responses,1);assert.equal(tool.requestPerformance().byKind.tool.rpcErrors,0);
	const stalled=client(t,'stall',200);await assert.rejects(stalled.discover(),/REQUEST_TIMEOUT/);await stalled.close();
	const value=stalled.requestPerformance();assert.equal(value.started,1);assert.equal(value.aborted,1);assert.equal(value.pending,0);assert.equal(value.lifetime.state,'exit_observed');assert.equal(value.roundTripSampleCount,0);assert.equal(value.durationMs,null);
});
test('an unconfirmed child exit cannot become a completed lifetime measurement',async()=>{
	const child=Object.assign(new EventEmitter(),{pid:12345,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){}});
	const c=new ReadOnlyMcpClient(child);await assert.rejects(c.close(),/MCP_EXIT_NOT_CONFIRMED/);
	const value=c.requestPerformance();assert.equal(value.transportClosed,true);assert.equal(value.lifetime.state,'running');assert.equal(value.lifetime.endedAgeMs,null);
	child.emit('exit',0);await c.close();assert.equal(c.requestPerformance().lifetime.state,'exit_observed');
});
