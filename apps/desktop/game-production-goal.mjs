import { productionWindow, projectProduction } from "./telemetry.mjs";

const integer = value => Number.isSafeInteger(value) && value >= 0;
// An observed 10-second rate does not prove every intervening rolling window.
// Bound the distance between samples and retain the largest observed gap so the
// user can distinguish sampled coverage from uninterrupted raw evidence.
export const productionSampleMaxGapTicks = 300;
const evidence = { evidenceKind: "sampled-native-10s", sampleWindowTicks: 600, maximumAllowedGapTicks: productionSampleMaxGapTicks };
export function productionGoalVerified(value, now) {
	const age = now - value?.observedAt;
	return value?.state === "verified" && value.evidenceKind === evidence.evidenceKind && Number.isFinite(age) && age >= 0 && age <= 15000;
}

// These observations are DSP's inclusive, save-persisted 600-tick windows.
// Overlapping windows extend coverage; their item counts are never added.
export function productionGoalSample(page, context, objective) {
	const window = productionWindow(page?.window);
	if (page?.sessionId !== context.sessionId || !integer(page.capturedAtGameTick) || !Array.isArray(page.requestedItemIds) || page.requestedItemIds.length !== 1 || page.requestedItemIds[0] !== objective.itemId || !Array.isArray(page.planets)) throw new Error("GAME_GOAL_PRODUCTION_SCOPE_CHANGED");
	const planet = page.planets.find(value => value.planetId === context.planetId);
	if (!planet || planet.capturedAtGameTick !== page.capturedAtGameTick) return null;
	const item = projectProduction(planet, [objective.itemId], window, page.capturedAtGameTick).find(value => value.itemId === objective.itemId);
	if (!item || item.rateState !== "observed" || Math.abs(item.actualProductionPerMinute - item.producedCount * 6) > 0.000001) return null;
	return { startTick: window.startGameTick, endTick: window.endGameTick, rate: item.actualProductionPerMinute, producedCount: item.producedCount, itemName: item.itemName, planetId: planet.planetId, source: item.rateSource };
}

// An exact 60-second average is available only when six 600-tick windows
// touch without overlap or gaps. A missed boundary restarts the interval;
// overlapping samples are never summed or treated as new time.
export function extendProductionAverage(previous, sample, minimumTick, observedAt) {
	if (!sample || !integer(sample.producedCount) || sample.startTick < minimumTick || sample.endTick - sample.startTick + 1 !== 600)
		return { state: "unavailable", reason: "GAME_GOAL_PRODUCTION_WARMING", seconds: 0, producedCount: 0, observedAt };
	const first = () => ({ state: "measuring", reason: null, startTick: sample.startTick, endTick: sample.endTick, seconds: 10, producedCount: sample.producedCount, observedAt });
	if (!previous || !integer(previous.startTick) || !integer(previous.endTick) || !integer(previous.producedCount)) return first();
	if (sample.endTick <= previous.endTick || sample.startTick <= previous.endTick) return previous;
	if (previous.state === "ready") return first();
	if (sample.startTick !== previous.endTick + 1) return { ...first(), reason: "GAME_GOAL_AVERAGE_GAP" };
	const count = previous.producedCount + sample.producedCount, ticks = sample.endTick - previous.startTick + 1;
	if (!Number.isSafeInteger(count) || ticks > 3600) return first();
	return { state: ticks === 3600 ? "ready" : "measuring", reason: null, startTick: previous.startTick, endTick: sample.endTick, seconds: ticks / 60, producedCount: count, ...(ticks === 3600 ? { ratePerMinute: count } : {}), observedAt };
}

// A new terminal effect establishes a fresh measurement boundary. A repeated
// read of the same or an older receipt cannot keep restarting the window.
export function resetProductionAfterTerminal(goal, name, reply) {
	const terminal = name === "spherewright_get_action_result" && reply?.success === true ? reply.result : null;
	if (goal?.objective?.kind !== "production" || terminal?.terminal !== true || terminal.actionKind === "save"
		|| !integer(terminal.completedAtGameTick) || terminal.completedAtGameTick >= Number.MAX_SAFE_INTEGER) return false;
	const minimum = terminal.completedAtGameTick + 1;
	if (integer(goal.measurementStartTick) && minimum <= goal.measurementStartTick) return false;
	goal.measurementStartTick = minimum; goal.verification = null; goal.productionAverage = null;
	if (goal.supplyPlan?.state === "observed") goal.supplyPlan = { ...goal.supplyPlan, state: "stale", invalidatedAtGameTick: terminal.completedAtGameTick };
	return true;
}

export function extendProductionGoal(previous, sample, objective, minimumTick, observedAt) {
	if (!sample || sample.startTick < minimumTick) return { ...evidence, state: "unavailable", reason: "GAME_GOAL_PRODUCTION_WARMING", observedAt, startTick: null, endTick: null, seconds: 0, minimumRate: null, latestRate: sample?.rate ?? null, samples: 0, maximumObservedGapTicks: 0 };
	const sameTick = previous?.endTick === sample.endTick;
	// Re-reading an unchanged game tick does not make its evidence newer.
	if (sameTick) return previous;
	if (sample.rate < objective.minimumPerMinute) return { ...evidence, state: "measuring", reason: "GAME_GOAL_RATE_BELOW_TARGET", observedAt, startTick: null, endTick: sample.endTick, seconds: 0, minimumRate: sample.rate, latestRate: sample.rate, samples: 1, maximumObservedGapTicks: 0 };
	const gap = integer(previous?.endTick) ? sample.endTick - previous.endTick : 0;
	const contiguous = previous?.evidenceKind === evidence.evidenceKind && integer(previous?.startTick) && gap > 0 && gap <= productionSampleMaxGapTicks && sample.startTick <= previous.endTick + 1;
	const startTick = contiguous ? previous.startTick : sample.startTick;
	const seconds = (sample.endTick - startTick + 1) / 60;
	return { ...evidence, state: seconds >= objective.windowSeconds ? "verified" : "measuring", reason: contiguous || !previous?.samples ? null : gap > productionSampleMaxGapTicks ? "GAME_GOAL_SAMPLE_GAP" : "GAME_GOAL_MEASUREMENT_RESTARTED", observedAt, startTick, endTick: sample.endTick, seconds, minimumRate: contiguous ? Math.min(previous.minimumRate, sample.rate) : sample.rate, latestRate: sample.rate, samples: contiguous ? previous.samples + 1 : 1, maximumObservedGapTicks: contiguous ? Math.max(previous.maximumObservedGapTicks ?? 0, gap) : 0 };
}
