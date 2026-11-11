// These native failures stop the exact owned order and permit a fresh route.
// Other failed, uncertain or recovery-required outcomes keep their audit gate.
export function stoppedGameAction(value) {
	return ["move", "harvest"].includes(value?.actionKind)
		&& value.state === "action_failed" && value.terminal === true && value.succeeded === false
		&& value.recoveryRequired === false && value.failureKind === "position_stalled"
		&& value.stalled === true && value.doNotRetrySameTarget === true
		&& Number.isSafeInteger(value.startedAtGameTick) && value.startedAtGameTick >= 0
		&& Number.isSafeInteger(value.completedAtGameTick) && value.completedAtGameTick >= value.startedAtGameTick
		&& /^sha256:[0-9a-f]{64}$/.test(value.afterStateHash ?? "");
}
