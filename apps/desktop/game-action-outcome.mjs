// Closed movement orders and an exhausted forge task can retain known effects.
// Uncertain or recovery-required outcomes keep their audit gate.
export function stoppedGameAction(value) {
	const closed = value?.state === "action_failed" && value.terminal === true && value.succeeded === false
		&& value.recoveryRequired === false
		&& Number.isSafeInteger(value.startedAtGameTick) && value.startedAtGameTick >= 0
		&& Number.isSafeInteger(value.completedAtGameTick) && value.completedAtGameTick >= value.startedAtGameTick
		&& /^sha256:[0-9a-f]{64}$/.test(value.afterStateHash ?? "");
	if (!closed) return false;
	if (value.actionKind === "handcraft") {
		return /^sha256:[0-9a-f]{64}$/.test(value.beforeStateHash ?? "")
			&& Number.isSafeInteger(value.requestedCount) && value.requestedCount > 0
			&& Array.isArray(value.itemDeltas) && value.itemDeltas.length > 0
			&& value.itemDeltas.every(item => Number.isSafeInteger(item.itemId) && item.itemId > 0
				&& Number.isSafeInteger(item.beforeCount) && item.beforeCount >= 0
				&& Number.isSafeInteger(item.afterCount) && item.afterCount >= 0
				&& item.delta === item.afterCount - item.beforeCount);
	}
	return ["move", "harvest"].includes(value.actionKind) && value.failureKind === "position_stalled"
		&& value.stalled === true && value.doNotRetrySameTarget === true;
}

const stateHash = value => /^sha256:[0-9a-f]{64}$/.test(value ?? "");
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const atRest = value => value && [value.x, value.y, value.z].every(Number.isFinite)
	&& Math.hypot(value.x, value.y, value.z) <= 0.1;
const exhaustedMiningMessage = "The normal mining order stopped after the mecha had no core energy, reactor energy, current reactor item, or usable fuel for 600 game ticks.";

// This is a candidate for an explicit independent audit, never automatic success.
export function energyStarvedHarvestCandidate(value) {
	if (value?.actionKind !== "harvest" || value.state !== "action_failed" || value.terminal !== true || value.succeeded !== false
		|| value.recoveryRequired !== false || value.failureKind != null || value.stalled !== false || value.doNotRetrySameTarget !== false
		|| value.message !== exhaustedMiningMessage || !stateHash(value.beforeStateHash) || !stateHash(value.afterStateHash)
		|| !nonnegative(value.startedAtGameTick) || !nonnegative(value.completedAtGameTick) || value.completedAtGameTick < value.startedAtGameTick
		|| !Number.isSafeInteger(value.targetObjectId) || value.targetObjectId <= 0
		|| !Number.isSafeInteger(value.requestedCount) || value.requestedCount <= 0 || !Array.isArray(value.itemDeltas) || !value.itemDeltas.length) return false;
	let gained = 0;
	for (const item of value.itemDeltas) {
		if (!Number.isSafeInteger(item.itemId) || item.itemId <= 0 || !nonnegative(item.beforeCount) || !nonnegative(item.afterCount)
			|| item.delta !== item.afterCount - item.beforeCount || item.delta < 0) return false;
		gained += item.delta;
	}
	return Number.isSafeInteger(gained) && gained > 0 && gained <= value.requestedCount;
}

export function energyStarvedHarvestAudit(terminal, player, context, now = Date.now()) {
	if (!energyStarvedHarvestCandidate(terminal) || !player || !context || context.loaded !== true || context.owned !== true || context.accessRestricted !== false
		|| context.writeHealth !== "healthy" || context.sessionId !== terminal.sessionId || context.planetId !== terminal.planetId
		|| !Number.isFinite(context.observedAt) || Math.abs(now - context.observedAt) > 2000
		|| player.sessionId !== terminal.sessionId || player.planetId !== terminal.planetId
		|| !nonnegative(player.capturedAtGameTick) || player.capturedAtGameTick < terminal.completedAtGameTick
		|| !nonnegative(context.capturedAtGameTick) || context.capturedAtGameTick < player.capturedAtGameTick
		|| player.stateHashVersion !== 1 || !stateHash(player.stateHash) || player.isAlive !== true || player.isOnPlanet !== true
		|| player.isFlying !== false || player.isSailing !== false || player.movementState !== "Walk"
		|| !Number.isFinite(player.speed) || player.speed < 0 || player.speed > 0.1 || !Array.isArray(player.inventory)) return false;
	const physics = player.nativePhysics;
	if (!physics || physics.state !== "observed" || physics.currentOrderPresent !== false || physics.queuedOrderCount !== 0
		|| physics.controllerMovementStateInFrame !== "Walk" || physics.groundContact?.cachedWalkIsGrounded !== true
		|| !atRest(physics.velocity) || !atRest(physics.walkManualVelocity) || !atRest(physics.walkRtsVelocity)
		|| !Number.isFinite(physics.controllerVerticalSpeed) || Math.abs(physics.controllerVerticalSpeed) > 0.1) return false;
	return terminal.itemDeltas.filter(item => item.delta > 0).every(item => {
		const matches = player.inventory.filter(value => value.itemId === item.itemId);
		return matches.length === 1 && nonnegative(matches[0].count) && matches[0].count >= item.afterCount;
	});
}

export function rejectedGameCommit(reply) {
	return reply?.success === false && reply.result == null
		&& ["STALE_STATE", "PLAN_EXPIRED", "PLAN_NOT_FOUND"].includes(reply.error?.code);
}
