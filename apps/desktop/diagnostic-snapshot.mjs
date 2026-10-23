// Public diagnostic schema: construct every field, never copy raw records.
export const diagnosticLimits = Object.freeze({ tasks: 8, eventsPerTask: 32, invocationsPerTask: 8, gameEvents: 64, bytes: 131072 });
const states = ["queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "prepared", "completed", "unknown", "created", "preparing", "awaiting_approval", "approved", "intent_recorded", "accepted", "blocked", "reconciling", "advised"];
const phases = ["idle", "reading_catalog", "catalog_ready", "observing", "planning", "preparing", "awaiting_approval", "confirming", "accepted", "reconciling", "completed", "advised", "blocked", "failed", "cancelled", "runtime_unavailable"];
const eventKinds = ["task", "tool", "assistant", "usage", "command-output", "check-result", "change", "reference", "stage", "error", "result"];
const tools = ["workspace_read", "workspace_search", "workspace_diff", "workspace_write", "workspace_check", "workspace_list", "workspace_status", "observe_research", "propose_research"];
const codes = new Set([
	"UNRECOGNIZED_ERROR_CODE", "COMPONENT_SNAPSHOT_UNAVAILABLE", "RUNTIME_UNAVAILABLE", "WORKBENCH_RESPONSE_TIMEOUT", "WORKBENCH_NOT_INITIALIZED", "WORKBENCH_CLOSING", "WORKBENCH_SCHEMA_TOO_NEW", "WORKBENCH_SCHEMA_UNKNOWN",
	"DEVELOPMENT_EXECUTION_BLOCKED", "DEVELOPMENT_RUNTIME_BUSY", "DEVELOPMENT_OPERATION_FAILED", "DEVELOPMENT_TASK_CANCELLED", "INTERRUPTED_COMMAND_REQUIRES_RECONCILIATION", "CHECK_DID_NOT_PASS", "CHECK_TIMED_OUT", "COMMAND_CANCELLED_BEFORE_START", "WORKSPACE_EXECUTION_NOT_GRANTED", "WORKSPACE_WRITE_NOT_GRANTED",
	"GAME_RUNTIME_UNAVAILABLE", "GAME_RUNTIME_RESPONSE_TIMEOUT", "GAME_EXECUTION_OWNS_RUNTIME", "GAME_TASK_STOPPED", "GAME_TASK_FAILED", "GAME_TASK_START_BLOCKED", "GAME_LEDGER_STORAGE_UNAVAILABLE", "GAME_LEDGER_SCHEMA_UNSUPPORTED", "GAME_LEDGER_SCHEMA_UNKNOWN", "GAME_CONTEXT_CHANGED",
	"COMMIT_RECEIPT_UNAVAILABLE", "UNKNOWN_COMMIT_HAS_NO_ACTION_ID", "INDEPENDENT_GAME_AUDIT_REQUIRED", "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES", "ORIGINAL_ACTION_PENDING", "ORIGINAL_ACTION_READ_FAILED", "ORIGINAL_ACTION_BINDING_MISMATCH", "RESEARCH_TERMINAL_PROOF_INCOMPLETE",
	"ORIGINAL_MCP_DISCONNECTED", "ORIGINAL_MCP_COHORT_REQUIRED", "ORIGINAL_MCP_RECONNECT_UNAVAILABLE", "MCP_COHORT_CHANGED_RESELECT_REQUIRED", "MCP_COHORT_CHANGED_DURING_START", "MCP_EXITED", "MCP_EXIT_NOT_CONFIRMED", "MCP_REQUEST_TIMEOUT", "MCP_DISCONNECTED", "MCP_TOOL_REJECTED", "MCP_UNAVAILABLE_OR_BUSY", "MCP_CAPABILITIES_CHANGED",
	"OWNED_RESEARCH_WORLD_REQUIRED", "HEALTHY_RESEARCH_WRITES_REQUIRED", "RESEARCH_READBACK_NOT_SUPPORTED", "RESEARCH_BUDGET_INVALID", "RESEARCH_BUDGET_MISMATCH", "RESEARCH_SELECTION_CHANGED", "GAME_MODEL_OUTPUT_LIMIT", "GAME_MODEL_DID_NOT_FINISH", "MODEL_DID_NOT_PROPOSE_SCOPED_RESEARCH", "PROTECTED_PROFILE_UNAVAILABLE",
	"DEVELOPMENT_GATE_RELEASE_UNCONFIRMED", "STARTUP_STORAGE_UNAVAILABLE", "RUNTIME_STARTUP_FAILED", "EACCES", "EPERM", "ENOSPC", "EIO",
]);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const boolean = value => typeof value === "boolean" ? value : null;
const choice = (value, allowed) => allowed.includes(value) ? value : "unknown";
const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const version = value => typeof value === "string" && /^\d{1,5}(?:\.\d{1,5}){1,3}(?:[-+][a-zA-Z0-9.-]{1,32})?$/.test(value) ? value : null;
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
const list = value => Array.isArray(value) ? value : [];
export const diagnosticCode = value => value == null || value === "" ? null : codes.has(value) ? value : "UNRECOGNIZED_ERROR_CODE";
function event(value) {
	return { sequence: count(value?.sequence), kind: choice(value?.kind, eventKinds), at: date(value?.at ?? value?.createdAt), state: choice(value?.state, states), stage: choice(value?.stage, phases), tool: tools.includes(value?.tool) ? value.tool : null, code: diagnosticCode(value?.code), contentOmitted: true };
}
function invocation(value) {
	const tool = value?.name ?? value?.tool;
	return { tool: tools.includes(tool) ? tool : null, state: choice(value?.state, states), startedAt: date(value?.createdAt ?? value?.startedAt), finishedAt: date(value?.finishedAt), code: diagnosticCode(value?.error ?? value?.code), exitCode: Number.isSafeInteger(value?.exitCode) && Math.abs(value.exitCode) <= 4294967295 ? value.exitCode : null, treeConfirmed: boolean(value?.treeConfirmed), streamsDrained: boolean(value?.streamsDrained), outputOmitted: true };
}
export function workbenchDiagnostics(value) {
	if (value?.version !== 1) return { state: "unavailable", code: diagnosticCode(value?.unavailableCode ?? value?.code) ?? "COMPONENT_SNAPSHOT_UNAVAILABLE" };
	const tasks = list(value.tasks).slice(0, diagnosticLimits.tasks).map((task, index) => ({
		label: "development-" + (index + 1), kind: choice(task?.kind, ["edit", "revert", "check", "agent"]), state: choice(task?.state, states), code: diagnosticCode(task?.error ?? task?.code),
		createdAt: date(task?.createdAt), startedAt: date(task?.startedAt), finishedAt: date(task?.finishedAt), eventCount: count(task?.eventCount), invocationCount: count(task?.invocationCount),
		eventsTruncated: count(task?.eventCount) === null ? null : task.eventCount > diagnosticLimits.eventsPerTask,
		invocationsTruncated: count(task?.invocationCount) === null ? null : task.invocationCount > diagnosticLimits.invocationsPerTask,
		events: list(task?.events).slice(0, diagnosticLimits.eventsPerTask).map(event), invocations: list(task?.invocations).slice(0, diagnosticLimits.invocationsPerTask).map(invocation),
	}));
	return { state: "available", version: 1, schemaVersion: count(value.schemaVersion), rootCount: count(value.rootCount), taskCount: count(value.taskCount), active: boolean(value.active), executionBlocked: boolean(value.executionBlocked), configurationBlocked: boolean(value.configurationBlocked), tasksTruncated: count(value.taskCount) === null ? null : value.taskCount > diagnosticLimits.tasks, order: "latest-first", tasks };
}
export function captureWorkbenchDiagnostics(store, flags) {
	const db = store.db, tasks = db.prepare("SELECT id,kind,state,error,created_at,started_at,finished_at FROM tasks ORDER BY created_at DESC,id DESC LIMIT ?").all(diagnosticLimits.tasks);
	const rows = tasks.map(task => ({
		kind: task.kind, state: task.state, error: task.error, createdAt: task.created_at, startedAt: task.started_at, finishedAt: task.finished_at,
		eventCount: db.prepare("SELECT count(*) AS n FROM events WHERE task_id=?").get(task.id).n,
		invocationCount: db.prepare("SELECT count(*) AS n FROM invocations WHERE task_id=?").get(task.id).n,
		events: db.prepare("SELECT sequence,kind,created_at,CASE WHEN json_valid(value) THEN json_extract(value,'$.state') END AS state,CASE WHEN json_valid(value) THEN json_extract(value,'$.code') END AS code,CASE WHEN json_valid(value) THEN json_extract(value,'$.error') END AS error,CASE WHEN json_valid(value) THEN json_extract(value,'$.name') END AS tool FROM events WHERE task_id=? ORDER BY sequence DESC LIMIT ?").all(task.id, diagnosticLimits.eventsPerTask).map(row => ({ sequence: row.sequence, kind: row.kind, createdAt: row.created_at, state: row.state, code: row.code ?? row.error, tool: row.tool })),
		invocations: db.prepare("SELECT name,state,error,created_at,finished_at,CASE WHEN json_valid(result) THEN json_extract(result,'$.exitCode') END AS exit_code,CASE WHEN json_valid(result) THEN json_extract(result,'$.treeConfirmed') END AS tree_confirmed,CASE WHEN json_valid(result) THEN json_extract(result,'$.streamsDrained') END AS streams_drained FROM invocations WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ?").all(task.id, diagnosticLimits.invocationsPerTask).map(row => ({ name: row.name, state: row.state, error: row.error, createdAt: row.created_at, finishedAt: row.finished_at, exitCode: row.exit_code, treeConfirmed: row.tree_confirmed === 1 ? true : row.tree_confirmed === 0 ? false : null, streamsDrained: row.streams_drained === 1 ? true : row.streams_drained === 0 ? false : null })),
	}));
	return workbenchDiagnostics({ version: 1, schemaVersion: db.prepare("PRAGMA user_version").get().user_version, rootCount: db.prepare("SELECT count(*) AS n FROM roots").get().n, taskCount: db.prepare("SELECT count(*) AS n FROM tasks").get().n, ...flags, tasks: rows });
}
function gameDiagnostics(value) {
	if (!value || value.unavailableCode) return { state: "unavailable", code: diagnosticCode(value?.unavailableCode) ?? "COMPONENT_SNAPSHOT_UNAVAILABLE" };
	return {
		state: "available", phase: choice(value.phase, phases), busy: boolean(value.busy), runtimeAvailable: boolean(value.runtimeAvailable), developmentFrozen: boolean(value.developmentFrozen), nativeInputExclusion: boolean(value.nativeInputExclusion), code: diagnosticCode(value.error),
		pendingCount: Array.isArray(value.unresolved) ? value.unresolved.length : null, visibleTaskCount: Array.isArray(value.tasks) ? value.tasks.length : null, tasksTruncated: Array.isArray(value.tasks) ? value.tasks.length > diagnosticLimits.tasks : null,
		tasks: list(value.tasks).slice(0, diagnosticLimits.tasks).map((task, index) => ({ label: "game-" + (index + 1), state: choice(task?.state, states), intent: task?.intent ? { state: choice(task.intent.state, states), hasActionId: typeof task.intent.actionId === "string" && task.intent.actionId.length > 0, hasAcceptance: task.intent.acceptance != null, hasTerminal: task.intent.terminal != null } : null })),
		eventCount: Array.isArray(value.events) ? value.events.length : null, eventsTruncated: Array.isArray(value.events) ? value.events.length > diagnosticLimits.gameEvents : null,
		events: list(value.events).slice(-diagnosticLimits.gameEvents).map(row => event({ sequence: row?.sequence, kind: row?.kind, at: Number.isFinite(row?.at) && Math.abs(row.at) <= 8640000000000000 ? new Date(row.at).toISOString() : null, stage: row?.kind === "stage" ? row.text : null, tool: row?.name, code: row?.code })),
	};
}
function timing(value) { return value && typeof value === "object" ? { meanMs: number(value.meanMs), p95Ms: number(value.p95Ms), maxMs: number(value.maxMs) } : null; }
function rpc(value) {
	if (value?.version !== 1) return { state: "unavailable" };
	const data = Object.fromEntries(["started", "responses", "rpcErrors", "aborted", "pending", "peakPending", "pendingCapacity", "sampleCapacity", "sampleCount", "roundTripSampleCount", "duplicateReplies", "rejectedBeforeAdmission"].map(key => [key, count(value[key])]));
	return { state: "available", source: "mcp-client-monotonic", scope: "this-client", ...data, windowDurationMs: number(value.windowDurationMs), lastCompletedAgeMs: number(value.lastCompletedAgeMs), durationMs: timing(value.durationMs), lifetime: { state: choice(value.lifetime?.state, ["running", "exit_observed", "launch_failed"]), basis: choice(value.lifetime?.basis, ["client_attachment", "launch_request"]), durationMs: number(value.lifetime?.durationMs), endedAgeMs: number(value.lifetime?.endedAgeMs) } };
}
function bridgeDiagnostics(value, performance) {
	if (!value || value.unavailableCode) return { state: "unavailable", code: diagnosticCode(value?.unavailableCode) ?? "COMPONENT_SNAPSHOT_UNAVAILABLE" };
	const native = value.observation?.runtimePerformance, metrics = native?.data;
	return {
		state: "available", connected: value.observation ? boolean(value.observation.connected) : false, busy: boolean(value.busy), code: diagnosticCode(value.error),
		metadata: value.metadata ? { protocolVersion: typeof value.metadata.protocolVersion === "string" && /^\d{4}-\d\d-\d\d$/.test(value.metadata.protocolVersion) ? value.metadata.protocolVersion : null, serverVersion: version(value.metadata.serverVersion), toolCount: count(value.metadata.toolCount), resourceCount: count(value.metadata.resourceCount), researchAvailable: boolean(value.metadata.researchAvailable) } : null,
		rpc: performance ? rpc(value.requestPerformance) : { state: "omitted" },
		nativePerformance: performance ? { state: choice(native?.state, ["observed", "warming_up", "stale", "unsupported", "unavailable", "restricted"]), ageMs: number(native?.ageMs), sampleCount: count(metrics?.sampleCount), windowDurationMs: number(metrics?.windowDurationMs), pendingMainThreadRequests: count(metrics?.pendingMainThreadRequests), updateIntervalMs: timing(metrics?.updateInterval), bridgePumpMs: timing(metrics?.bridgePump) } : { state: "omitted" },
	};
}
export function diagnosticOptions(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["includeTasks", "includePerformance"].includes(key)) || ["includeTasks", "includePerformance"].some(key => value[key] !== undefined && typeof value[key] !== "boolean")) throw new Error("INVALID_DIAGNOSTIC_OPTIONS");
	return { includeTasks: value.includeTasks ?? true, includePerformance: value.includePerformance ?? true };
}
export function buildDiagnosticReport(input, options, { reportId, generatedAt }) {
	const selected = diagnosticOptions(options), build = input.build ?? {}, runtime = input.runtime ?? {};
	return {
		kind: "spherewright-commanddeck-diagnostic", version: 1, reportId, generatedAt, collection: "read-only host snapshot; no live game or model requests", sections: selected, limits: diagnosticLimits,
		privacy: { privatePaths: "omitted", credentialsAndApprovals: "omitted", worldSessionAndActionIdentities: "omitted", modelAndCommandContent: "omitted", taskLabels: "local-to-this-report", eventReplay: "not-supported" },
		build: { state: build.packaged === true ? revision(build.sourceRevision) && revision(build.piCommit) ? "reported-package-metadata" : "package-metadata-unavailable" : "development-unverified", packaged: boolean(build.packaged), applicationVersion: version(build.applicationVersion), sourceRevision: revision(build.sourceRevision), piCommit: revision(build.piCommit), electronVersion: version(build.electronVersion), nodeVersion: version(build.nodeVersion), platform: choice(build.platform, ["win32", "linux", "darwin"]), architecture: choice(build.architecture, ["x64", "arm64", "ia32"]), installationVerified: false },
		runtime: { available: boolean(runtime.available), exitObserved: boolean(runtime.exitObserved), probeBusy: boolean(runtime.probeBusy), uiConnected: boolean(runtime.uiConnected), uiRecovering: boolean(runtime.uiRecovering), uiReplacements: count(runtime.uiReplacements) },
		workbench: selected.includeTasks ? workbenchDiagnostics(input.workbench) : { state: "omitted" },
		game: selected.includeTasks ? gameDiagnostics(input.game) : { state: "omitted" },
		bridge: bridgeDiagnostics(input.bridge, selected.includePerformance),
	};
}
