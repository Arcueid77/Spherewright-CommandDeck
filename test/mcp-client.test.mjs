import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
