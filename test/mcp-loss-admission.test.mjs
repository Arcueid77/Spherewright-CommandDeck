import assert from "node:assert/strict";
import test from "node:test";
import { assertBlockedMcpExecution } from "../apps/desktop/mcp-loss-smoke.mjs";

test("MCP recovery assertions wait for the owned native response check before reaching the ledger gate", async () => {
	const ui = { nativeProbePending: true }, calls = [];
	await assertBlockedMcpExecution({ getUi: () => ui, api: async (domain, args) => { assert.equal(ui.nativeProbePending, false); calls.push([domain, args.action]); throw new Error("GAME_TASK_START_BLOCKED"); } }, async predicate => {
		if (ui.nativeProbePending) { assert.equal(await predicate(), false); assert.deepEqual(calls, []); ui.nativeProbePending = false; }
		assert.equal(await predicate(), true);
	});
	assert.deepEqual(calls, [["game", "start"], ["game", "catalog"]]);
});

test("MCP recovery assertions still reject genuine runtime loss or an unexpectedly admitted action", async () => {
	const until = async predicate => { await predicate(); };
	for (const api of [async () => { throw new Error("GAME_RUNTIME_UNAVAILABLE"); }, async () => ({ admitted: true })]) await assert.rejects(assertBlockedMcpExecution({ getUi: () => ({ nativeProbePending: false }), api }, until), { code: "ERR_ASSERTION" });
});
