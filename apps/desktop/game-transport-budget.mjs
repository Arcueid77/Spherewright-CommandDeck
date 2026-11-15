// One task-wide budget shared by all of its MCP tool requests. Original-action
// reconciliation has a separate bounded reserve so a spent work budget cannot
// silently trigger a replay or make a received action disappear.
const recoveryTools = new Set(["spherewright_get_status", "spherewright_get_session_state", "spherewright_get_action_result", "spherewright_get_player_state"]);

export class GameTransportBudget {
	constructor(toolLimit, changed = () => {}) {
		if (!Number.isSafeInteger(toolLimit) || toolLimit < 1 || toolLimit > 2048) throw new Error("INVALID_GAME_MCP_LIMITS");
		this.workLimit = Math.min(20000, 32 + toolLimit * 8);
		this.reconciliationLimit = Math.min(4096, 32 + toolLimit * 4);
		this.workUsed = 0;
		this.reconciliationUsed = 0;
		this.changed = changed;
	}
	snapshot() { return { workUsed: this.workUsed, workLimit: this.workLimit, reconciliationUsed: this.reconciliationUsed, reconciliationLimit: this.reconciliationLimit }; }
	claim(kind, name) {
		if (kind === "reconciliation") {
			if (!recoveryTools.has(name)) throw new Error("GAME_MCP_RECOVERY_READ_REQUIRED");
			if (this.reconciliationUsed >= this.reconciliationLimit) throw new Error("GAME_MCP_RECOVERY_BUDGET_EXHAUSTED");
			this.reconciliationUsed++;
		} else {
			if (kind !== "work") throw new Error("INVALID_GAME_MCP_BUDGET_KIND");
			if (this.workUsed >= this.workLimit) throw new Error("GAME_MCP_TRANSPORT_BUDGET_EXHAUSTED");
			this.workUsed++;
		}
		// The persisted accounting is advanced before a request can be sent.
		this.changed(this.snapshot());
	}
	wrap(port, kind = "work") {
		return Object.freeze({ ...port, call: (name, args) => { this.claim(kind, name); return port.call(name, args); },
			...(typeof port.playbook === "function" ? { playbook: () => { this.claim(kind, "resources/read"); return port.playbook(); } } : {}) });
	}
}
