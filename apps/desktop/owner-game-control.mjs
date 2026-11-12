// Explicit owner-side entry point for a local launcher. The model receives only
// the ordinary GameTasks tools and never receives this control object.
export function createOwnerGameControl({ enabled, ready, native, game, api, approvalAuthority, openPanel }) {
	if (!enabled) throw new Error("EXPLICIT_OWNER_GAME_CONTROL_REQUIRED");
	const approvalEpoch = 2147483647;
	async function embedded() {
		const value = await native.request("status");
		if (value.kind !== "dsp" || !value.attached || !value.gameParentMatches || !value.nativeParentMatches || !(value.clientWidth > 0 && value.clientHeight > 0)) throw new Error("EMBEDDED_GAME_REQUIRED");
		return value;
	}
	return Object.freeze({
		ready,
		targets: () => api("targets"),
		attach: target => api("attach", target),
		window: () => native.request("status"),
		selectMcp: path => api("bridge-select", path),
		bridge: () => api("bridge", { action: "snapshot" }),
		snapshot: () => game.snapshot(),
		async start(args) {
			await embedded();
			if (args?.kind !== "mcp" || args.mode !== "autonomous") throw new Error("OWNER_AUTONOMOUS_MCP_TASK_REQUIRED");
			const result = await api("game", { action: "start", args });
			openPanel();
			return result;
		},
		confirmation: () => game.confirmation(game.currentTaskId, approvalEpoch),
		async confirm(nonce) {
			await embedded();
			return game.confirm(approvalAuthority, nonce, approvalEpoch);
		},
		stop: () => game.stop(),
	});
}
