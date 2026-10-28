export const packagedMcpLossVersion = 2;
const cases = Object.freeze({
	accepted: Object.freeze({ mode: "mcp-drop-after-accept", hasActionId: true, taskState: "completed", intentState: "completed", resultReads: 2, error: null }),
	"lost-ack": Object.freeze({ mode: "mcp-lost-ack", hasActionId: false, taskState: "blocked", intentState: "unknown", resultReads: 0, error: null }),
	"world-change": Object.freeze({ mode: "mcp-drop-after-accept-world", hasActionId: true, taskState: "accepted", intentState: "accepted", resultReads: 1, error: "GAME_CONTEXT_CHANGED" }),
	"schema-change": Object.freeze({ mode: "mcp-drop-after-accept-schema", hasActionId: true, taskState: "accepted", intentState: "accepted", resultReads: 1, error: "ORIGINAL_MCP_COHORT_REQUIRED" }),
	"receipt-mismatch": Object.freeze({ mode: "mcp-drop-after-accept-key", hasActionId: true, taskState: "blocked", intentState: "unknown", resultReads: 2, error: "INDEPENDENT_GAME_AUDIT_REQUIRED" }),
});
export const portableMcpScenarios = Object.freeze(Object.keys(cases));
export const mcpLossModes = Object.freeze(Object.values(cases).map(value => value.mode));
export function mcpLossCase(scenario) {
	if (!Object.hasOwn(cases, scenario)) throw new Error("UNKNOWN_MCP_LOSS_SCENARIO");
	return cases[scenario];
}
