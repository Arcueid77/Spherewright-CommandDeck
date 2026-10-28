const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const scalar = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const amount = value => scalar(value) !== null && value >= 0 ? value : null;
const flag = value => typeof value === "boolean" ? value : null;
const name = value => typeof value === "string" && value.length <= 200 ? value : null;

export function projectMechaState(value, { sessionId, planetId }) {
	if (!value || value.sessionId !== sessionId || value.planetId !== planetId) throw new Error("READ_CONTEXT_CHANGED");
	if (count(value.capturedAtGameTick) === null) throw new Error("READ_MECHA_SCHEMA_CHANGED");
	if (value.fuelStorage !== undefined && (!Array.isArray(value.fuelStorage) || value.fuelStorage.length > 64) || value.handcraftQueue !== undefined && (!Array.isArray(value.handcraftQueue) || value.handcraftQueue.length > 32)) throw new Error("READ_MECHA_SCHEMA_CHANGED");
	const core = amount(value.coreEnergy), capacity = amount(value.coreEnergyCapacity), drones = value.constructionDrones;
	return {
		source: "spherewright_get_player_state", scope: "local-planet", planetId, capturedAtGameTick: value.capturedAtGameTick,
		position: Object.fromEntries(["x", "y", "z"].map(key => [key, scalar(value.position?.[key])])),
		movementState: name(value.movementState), isAlive: flag(value.isAlive), isOnPlanet: flag(value.isOnPlanet), isFlying: flag(value.isFlying), isSailing: flag(value.isSailing), speedMetresPerSecond: amount(value.speed),
		coreEnergyFraction: core !== null && capacity !== null && capacity > 0 && Number.isFinite(core / capacity) ? core / capacity : null,
		reactorItemId: count(value.reactorItemId), reactorItemName: name(value.reactorItemName), autoReplenishFuel: flag(value.autoReplenishFuel),
		fuelStorage: value.fuelStorage?.map(item => ({ itemId: count(item?.itemId), name: name(item?.name), count: count(item?.count), slotCount: count(item?.slotCount) })) ?? null,
		constructionDrones: { enabled: flag(drones?.enabled), constructionEnabled: flag(drones?.constructionEnabled), ...Object.fromEntries(["total", "alive", "idle", "working", "pendingBuildTargets", "pendingRepairTargets"].map(key => [key, count(drones?.[key])])) },
		handcraftQueue: value.handcraftQueue?.map(task => ({ queueIndex: count(task?.queueIndex), recipeId: count(task?.recipeId), recipeName: name(task?.recipeName), remainingCraftCount: count(task?.remainingCraftCount), progress: count(task?.progress), progressRequired: count(task?.progressRequired) })) ?? null,
	};
}
