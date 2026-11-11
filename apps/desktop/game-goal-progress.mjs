import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function observeGameProgress(goal, name, args, reply) {
	if (reply?.success !== true || !reply.result) return;
	const value = reply.result;
	let facts;
	if (name === "spherewright_get_player_state") facts = (value.inventory ?? []).map(item => [item.itemId, item.count, item.inc ?? 0]).sort((a, b) => a[0] - b[0]);
	if (name === "spherewright_get_progression_state") facts = { queue: value.techQueue, tech: (value.technologies ?? []).map(tech => [tech.techId, tech.unlocked, tech.currentLevel, tech.hashUploaded]) };
	if (facts === undefined) return;
	const previous = goal.progressFacts ?? {}, next = hash(facts), key = name;
	if (previous[key] && previous[key] !== next) goal.observedEffects = (goal.observedEffects ?? 0) + 1;
	goal.progressFacts = { ...previous, [key]: next };
}

export function gameProgressKey(goal, actions) {
	const completed = actions.filter(action => action.intent?.terminal?.succeeded === true && !["save", "new-game", "move"].includes(action.scope.actionKind)).map(action => action.intent.actionId).sort();
	const observations = goal.observations.filter(value => value.available && !/(?:tick|timestamp|observedAt|revision|runtimePerformance|Hash)(?:\/|$)/i.test(value.path)).map(({ tool, path, actual, passed }) => ({ tool, path, actual, passed }));
	return hash({ completed, observedEffects: goal.observedEffects ?? 0, movement: goal.motionActionIds ?? [], observations, coverage: goal.verification?.seconds ?? null });
}

export function recordGameMotion(goal, actionId, before, after, target) {
	if (!before || !after || !target || ![before, after, target].every(point => [point.x, point.y, point.z].every(Number.isFinite))) return null;
	const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
	const requested = distance(before, target), displacement = distance(before, after), advance = requested - distance(after, target);
	const effective = displacement >= Math.max(0.01, Math.min(0.5, requested * 0.1)) && advance > 0;
	if (effective && !goal.motionActionIds?.includes(actionId)) goal.motionActionIds = [...(goal.motionActionIds ?? []), actionId].slice(-256);
	return { requestedDistance: requested, displacement, advance, effectObserved: effective };
}
