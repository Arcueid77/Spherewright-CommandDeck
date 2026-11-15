import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSupplyPlan } from "../apps/desktop/game-supply-plan.mjs";

test("a native supply draft is scoped, bounded and never presented as executable", () => {
	const context = { sessionId: "world", planetId: 1, capturedAtGameTick: 100 }, objective = { itemId: 6001, minimumPerMinute: 60 };
	const plan = { sessionId: "world", planetId: 1, capturedAtGameTick: 101, targetItemId: 6001, targetRatePerMinute: 72, executable: false, machineCount: 4, machineWorkPowerWatts: 100, stages: [{ itemId: 6001, recipeId: 9, buildingItemId: 2901, machineCount: 4, requiredRatePerMinute: 72 }], externalInputs: [], machineCost: [] };
	assert.equal(summarizeSupplyPlan(plan, null, context, objective, 72, 1000).executable, false);
	const overflow = { sessionId: "world", planetId: 1, capturedAtGameTick: 101, totalEnergyCapacity: 1e308, totalEnergyRequired: 10, totalEnergyServed: 10 };
	assert.equal(summarizeSupplyPlan(plan, overflow, context, objective, 72, 1000).power, null);
	for (const change of [{ sessionId: "other" }, { planetId: 2 }, { capturedAtGameTick: 99 }, { executable: true }, { targetRatePerMinute: 60 }])
		assert.throws(() => summarizeSupplyPlan({ ...plan, ...change }, null, context, objective, 72, 1000), /GAME_SUPPLY_PLAN_SCOPE_CHANGED/);
});
