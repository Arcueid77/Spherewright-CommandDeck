import test from "node:test";
import assert from "node:assert/strict";
import { GameTransportBudget } from "../apps/desktop/game-transport-budget.mjs";

test("all task ports share a bounded, persisted-before-dispatch transport count", async () => {
	const persisted = [], dispatched = [];
	const budget = new GameTransportBudget(1, value => persisted.push(value));
	const raw = { call: async name => { dispatched.push(name); return name; } };
	const first = budget.wrap(raw), second = budget.wrap(raw);
	for (let index = 0; index < budget.workLimit; index++) await (index % 2 ? first : second).call("spherewright_get_status", {});
	assert.equal(persisted.length, budget.workLimit);
	assert.equal(dispatched.length, budget.workLimit);
	assert.throws(() => first.call("spherewright_get_status", {}), /GAME_MCP_TRANSPORT_BUDGET_EXHAUSTED/);
	assert.equal(dispatched.length, budget.workLimit);
	assert.equal(persisted.at(-1).workUsed, budget.workLimit);
	const recovery = budget.wrap(raw, "reconciliation");
	await recovery.call("spherewright_get_action_result", { actionId: "original" });
	assert.equal(budget.snapshot().reconciliationUsed, 1);
	assert.throws(() => recovery.call("spherewright_commit_save", {}), /GAME_MCP_RECOVERY_READ_REQUIRED/);
});

test("a ledger failure refuses dispatch and retains conservative accounting", () => {
	let dispatched = false;
	const budget = new GameTransportBudget(1, () => { throw new Error("LEDGER_UNAVAILABLE"); });
	const port = budget.wrap({ call: () => { dispatched = true; } });
	assert.throws(() => port.call("spherewright_get_status", {}), /LEDGER_UNAVAILABLE/);
	assert.equal(dispatched, false);
	assert.equal(budget.snapshot().workUsed, 1);
});
