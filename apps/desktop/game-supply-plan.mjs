const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const items = (value, keys) => Array.isArray(value) ? value.slice(0, 32).map(row => Object.fromEntries(keys.map(key => [key, row?.[key]]))) : [];

// Native Foundry output is a theoretical material draft. It is not a site,
// transport, power-supply, action authorization or actual-production proof.
export function summarizeSupplyPlan(plan, power, context, objective, plannedRate, observedAt) {
	if (!plan || plan.sessionId !== context.sessionId || plan.planetId !== context.planetId || plan.targetItemId !== objective.itemId
		|| plan.targetRatePerMinute !== plannedRate || plan.executable !== false || !integer(plan.capturedAtGameTick)
		|| integer(context.capturedAtGameTick) && plan.capturedAtGameTick < context.capturedAtGameTick
		|| !integer(plan.machineCount) || plan.machineCount < 1 || !integer(plan.machineWorkPowerWatts) || !Array.isArray(plan.stages)
		|| plan.stages.length > 32 || plan.stages.some(row => !integer(row.itemId) || row.itemId < 1 || !integer(row.recipeId) || row.recipeId < 1 || !integer(row.buildingItemId) || row.buildingItemId < 1 || !integer(row.machineCount) || row.machineCount < 1 || !finite(row.requiredRatePerMinute))
		|| !Array.isArray(plan.externalInputs) || plan.externalInputs.length > 32 || plan.externalInputs.some(row => !integer(row.itemId) || row.itemId < 1 || !finite(row.ratePerMinute))
		|| !Array.isArray(plan.machineCost) || plan.machineCost.length > 32 || plan.machineCost.some(row => !integer(row.itemId) || row.itemId < 1 || !integer(row.count))) throw new Error("GAME_SUPPLY_PLAN_SCOPE_CHANGED");
	let supplyPower = null;
	if (power?.sessionId === context.sessionId && power.planetId === context.planetId && integer(power.capturedAtGameTick)
		&& [power.totalEnergyCapacity, power.totalEnergyRequired, power.totalEnergyServed].every(value => integer(value) && Number.isSafeInteger(value * 60))) {
		supplyPower = { capturedAtGameTick: power.capturedAtGameTick, capacityWatts: power.totalEnergyCapacity * 60, requiredWatts: power.totalEnergyRequired * 60, servedWatts: power.totalEnergyServed * 60 };
	}
	return { state: "observed", observedAt, capturedAtGameTick: plan.capturedAtGameTick, itemId: objective.itemId,
		goalRatePerMinute: objective.minimumPerMinute, plannedRatePerMinute: plannedRate, machineCount: plan.machineCount,
		machineWorkPowerWatts: plan.machineWorkPowerWatts, stages: items(plan.stages, ["itemId", "recipeId", "buildingItemId", "machineCount", "requiredRatePerMinute"]),
		externalInputs: items(plan.externalInputs, ["itemId", "ratePerMinute"]), machineCost: items(plan.machineCost, ["itemId", "count"]),
		remainingChecks: Array.isArray(plan.remainingChecks) ? plan.remainingChecks.filter(value => typeof value === "string").slice(0, 16).map(value => value.slice(0, 240)) : [], remainingChecksTruncated: Array.isArray(plan.remainingChecks) && plan.remainingChecks.length > 16,
		power: supplyPower, executable: false };
}
