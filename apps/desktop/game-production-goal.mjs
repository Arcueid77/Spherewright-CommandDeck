import { productionWindow, projectProduction } from "./telemetry.mjs";

const integer = value => Number.isSafeInteger(value) && value >= 0;

// These observations are DSP's inclusive, save-persisted 600-tick windows.
// Overlapping windows extend coverage; their item counts are never added.
export function productionGoalSample(page, context, objective) {
	const window = productionWindow(page?.window);
	if (page?.sessionId !== context.sessionId || !integer(page.capturedAtGameTick) || !Array.isArray(page.requestedItemIds) || page.requestedItemIds.length !== 1 || page.requestedItemIds[0] !== objective.itemId || !Array.isArray(page.planets)) throw new Error("GAME_GOAL_PRODUCTION_SCOPE_CHANGED");
	const planet = page.planets.find(value => value.planetId === context.planetId);
	if (!planet || planet.capturedAtGameTick !== page.capturedAtGameTick) return null;
	const item = projectProduction(planet, [objective.itemId], window, page.capturedAtGameTick).find(value => value.itemId === objective.itemId);
	if (!item || item.rateState !== "observed" || Math.abs(item.actualProductionPerMinute - item.producedCount * 6) > 0.000001) return null;
	return { startTick: window.startGameTick, endTick: window.endGameTick, rate: item.actualProductionPerMinute, itemName: item.itemName, planetId: planet.planetId, source: item.rateSource };
}

export function extendProductionGoal(previous, sample, objective, minimumTick, observedAt) {
	if (!sample || sample.startTick < minimumTick) return { state: "unavailable", reason: "GAME_GOAL_PRODUCTION_WARMING", observedAt, startTick: null, endTick: null, seconds: 0, minimumRate: null, latestRate: sample?.rate ?? null, samples: 0 };
	const sameTick = previous?.endTick === sample.endTick;
	if (sameTick) return { ...previous, observedAt };
	if (sample.rate < objective.minimumPerMinute) return { state: "measuring", reason: "GAME_GOAL_RATE_BELOW_TARGET", observedAt, startTick: null, endTick: sample.endTick, seconds: 0, minimumRate: sample.rate, latestRate: sample.rate, samples: 1 };
	const contiguous = integer(previous?.startTick) && sample.endTick > previous.endTick && sample.startTick <= previous.endTick + 1;
	const startTick = contiguous ? previous.startTick : sample.startTick;
	const seconds = (sample.endTick - startTick + 1) / 60;
	return { state: seconds >= objective.windowSeconds ? "verified" : "measuring", reason: contiguous || !previous?.samples ? null : "GAME_GOAL_MEASUREMENT_RESTARTED", observedAt, startTick, endTick: sample.endTick, seconds, minimumRate: contiguous ? Math.min(previous.minimumRate, sample.rate) : sample.rate, latestRate: sample.rate, samples: contiguous ? previous.samples + 1 : 1 };
}
