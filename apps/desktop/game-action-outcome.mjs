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

export function rejectedGameCommit(reply) {
	return reply?.success === false && reply.result == null
		&& ["STALE_STATE", "PLAN_EXPIRED", "PLAN_NOT_FOUND"].includes(reply.error?.code);
}
