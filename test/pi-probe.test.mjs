import test from "node:test";
import assert from "node:assert/strict";
import { runPiProbe } from "../apps/desktop/pi-probe.mjs";

test("real Pi fork parses split streamed tool arguments and performs one bounded tool", async () => {
	const result = await runPiProbe();
	assert.deepEqual(result.active, ["deck_echo"]);
	assert.deepEqual(result.callable, ["deck_echo"]);
	assert.equal(result.executed, 1);
	assert.equal(result.requestCount, 2);
	assert.equal(result.gameCalls, 0);
	assert.ok(result.events.includes("tool_execution_end"));
	assert.ok(result.sessionFile);
	const resumed = await runPiProbe({ resumeFile: result.sessionFile });
	assert.ok(resumed.restoredMessages >= 3);
	assert.equal(resumed.executed, 0);
	assert.equal(resumed.requestCount, 0);
	assert.deepEqual(resumed.callable, ["deck_echo"]);
});
test("an unregistered MCP-style call is rejected rather than executed", async () => {
	const result = await runPiProbe({ forbidden: true });
	assert.equal(result.executed, 0);
	assert.ok(result.deniedToolResults >= 1);
	assert.equal(result.gameCalls, 0);
});
test("abort ends a stalled model request without invoking a tool", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1500);
	try {
		const result = await runPiProbe({ stall: true, signal: controller.signal });
		assert.equal(result.cancelled, true);
		assert.equal(result.executed, 0);
	} finally {
		clearTimeout(timer);
	}
});
test("invalid live selection fails before model access", async () => {
	await assert.rejects(runPiProbe({ mode: "invalid" }), /EXPLICIT_PROBE/);
});

test("a tool success followed by a model failure is not a successful roundtrip", async () => {
	await assert.rejects(
		runPiProbe({ secondLegError: true }),
		/TOOL_ROUNDTRIP_NOT_PROVEN/,
	);
});
