export const packagedMcpLossVersion = 8;
export const mcpLostAckStorageProof = Object.freeze({ fault: "sqlite-query-only", unknownWriteAttempts: 1, unknownWriteRejected: true, durableIntentRetained: true, restoredWritabilityDoesNotUnlock: true, uiReloadRetainsFreeze: true, newGameExecutionRejected: true });
export const mcpTimeoutReceiptProof = Object.freeze({ transportStopReason: "MCP_REQUEST_TIMEOUT", acceptedReplyBufferedBeforeTimeout: true, acceptedReplyDeliveredAfterClosure: true, originalIntentRemainsUnknown: true, acceptedReplyMatchesOriginalRequest: true, lateReplyDoesNotCompleteRequest: true, newTransportRequests: 0 });
const beforeIntent = stage => Object.freeze({ mode: "mcp-before-intent-" + stage, hasIntent: false, beforeIntent: stage, preIntentError: stage === "revalidation" ? "MCP_EXITED" : "MCP_READ_NOT_SUPPORTED", hasActionId: false, taskState: "cancelled", intentState: null, resultReads: 0, error: null, commits: 0, commitRequests: 0 });
const nativeOutcome = (mode, state, recoveryRequired, succeeded = false) => Object.freeze({ mode, hasActionId: true, taskState: "blocked", intentState: "unknown", resultReads: 2, error: "INDEPENDENT_GAME_AUDIT_REQUIRED", auditReason: "NATIVE_OUTCOME_REQUIRES_AUDIT", nativeOutcome: Object.freeze({ state, terminal: true, succeeded, recoveryRequired }) });
const cases = Object.freeze({
	accepted: Object.freeze({ mode: "mcp-drop-after-accept", hasActionId: true, taskState: "completed", intentState: "completed", resultReads: 2, error: null }),
	"preview-disconnect": beforeIntent("preview"),
	"confirmation-disconnect": beforeIntent("confirmation"),
	"revalidation-disconnect": beforeIntent("revalidation"),
	"duplicate-receipt": Object.freeze({ mode: "mcp-drop-after-accept-duplicate", hasActionId: true, taskState: "completed", intentState: "completed", resultReads: 2, error: null, duplicateReplies: 1, duplicateDelivery: "same-result" }),
	"late-receipt": Object.freeze({ mode: "mcp-drop-after-accept-late", hasActionId: true, taskState: "completed", intentState: "completed", resultReads: 2, error: null, duplicateReplies: 1, duplicateDelivery: "next-status" }),
	"lost-ack": Object.freeze({ mode: "mcp-lost-ack", hasActionId: false, taskState: "blocked", intentState: "unknown", resultReads: 0, error: null }),
	"lost-ack-storage": Object.freeze({ mode: "mcp-lost-ack-storage", storageFailure: true, hasActionId: false, taskState: "intent_recorded", intentState: "recorded", resultReads: 0, error: null }),
	"commit-timeout": Object.freeze({ mode: "mcp-commit-timeout", commitTimeout: true, hasActionId: false, taskState: "blocked", intentState: "unknown", resultReads: 0, error: null }),
	"unaccepted-disconnect": Object.freeze({ mode: "mcp-drop-before-accept", hasActionId: false, taskState: "blocked", intentState: "unknown", resultReads: 0, error: null, commits: 0 }),
	"world-change": Object.freeze({ mode: "mcp-drop-after-accept-world", hasActionId: true, taskState: "accepted", intentState: "accepted", resultReads: 1, error: "GAME_CONTEXT_CHANGED" }),
	"schema-change": Object.freeze({ mode: "mcp-drop-after-accept-schema", hasActionId: true, taskState: "accepted", intentState: "accepted", resultReads: 1, error: "ORIGINAL_MCP_COHORT_REQUIRED" }),
	"receipt-mismatch": Object.freeze({ mode: "mcp-drop-after-accept-key", hasActionId: true, taskState: "blocked", intentState: "unknown", resultReads: 2, error: "INDEPENDENT_GAME_AUDIT_REQUIRED", auditReason: "ORIGINAL_ACTION_BINDING_MISMATCH" }),
	"native-unknown": nativeOutcome("mcp-drop-after-accept-unknown", "outcome_unknown", false),
	"native-recovery": nativeOutcome("mcp-drop-after-accept-recovery", "recovery_required", false),
	"native-failed": nativeOutcome("mcp-drop-after-accept-failed", "action_failed", false),
	"recovery-flag": nativeOutcome("mcp-drop-after-accept-recovery-flag", "completed", true, true),
});
export const portableMcpScenarios = Object.freeze(Object.keys(cases));
export const mcpLossModes = Object.freeze(Object.values(cases).map(value => value.mode));
export function mcpLossCase(scenario) {
	if (!Object.hasOwn(cases, scenario)) throw new Error("UNKNOWN_MCP_LOSS_SCENARIO");
	return cases[scenario];
}
