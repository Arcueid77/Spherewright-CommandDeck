import { diagnosticCode } from "./diagnostic-snapshot.mjs";

export const journalLimits = Object.freeze({ recordings: 64, events: 4096, bookmarks: 128, eventBytes: 4096 });
export const bookmarkTags = Object.freeze(["checkpoint", "attention", "issue", "verified"]);
const states = new Set(["unknown", "idle", "queued", "running", "cancelling", "succeeded", "failed", "cancelled", "interrupted", "created", "preparing", "awaiting_approval", "approved", "intent_recorded", "accepted", "blocked", "reconciling", "completed", "advised", "observing", "planning", "confirming", "reading_catalog", "catalog_ready", "runtime_unavailable", "connected", "disconnected", "ready", "suspended", "checking"]);
const tools = new Set(["deck_echo", "workspace_read", "workspace_search", "workspace_diff", "workspace_write", "workspace_check", "workspace_list", "workspace_status", "observe_research", "propose_research"]);
const kinds = Object.freeze({ recording: ["start", "stop", "limit"], development: ["task", "tool", "assistant", "usage", "command-output", "check-result", "change", "reference", "error"], game: ["stage"], bridge: ["state"], probe: ["state", "result", "tool"], system: ["power", "runtime-stopped", "ui-health", "ui-recovered", "native-state"] });
const number = value => Number.isSafeInteger(value) && Math.abs(value) <= 4294967295 ? value : null;
const count = value => number(value) !== null && value >= 0 ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const state = value => states.has(value) ? value : "unknown";
const powerCodes = new Set(["SYSTEM_POWER_PAUSED", "SYSTEM_WAKE_NOT_OBSERVED", "SYSTEM_WAKE_CHECK_DEFERRED", "POWER_WINDOW_UNCONFIRMED", "POWER_WINDOW_BINDING_UNCONFIRMED", "POWER_WINDOW_STATUS_UNSUPPORTED", "POWER_WINDOW_OPERATION_PENDING", "POWER_RUNTIME_UNAVAILABLE", "POWER_RESTORE_DEFERRED", "POWER_FIXTURE_WINDOW_UNCONFIRMED"]);
const code = value => powerCodes.has(value) ? value : diagnosticCode(value);
export function journalFacts(value) {
	return { state: state(value?.state), tool: tools.has(value?.tool ?? value?.name) ? value.tool ?? value.name : null, code: code(value?.code ?? value?.error), busy: bool(value?.busy), available: bool(value?.available), count: count(value?.count), requests: count(value?.requests ?? value?.requestCount), executed: count(value?.executed), exitCode: number(value?.exitCode) };
}
export function validateJournalPoint(value) {
	if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["domain", "facts", "kind", "task"].sort()) || !Object.hasOwn(kinds, value.domain) || !kinds[value.domain].includes(value.kind) || value.task !== null && !/^(development|game)-[1-9][0-9]{0,4}$/.test(value.task)) throw new Error("JOURNAL_RECORD_INVALID");
	const facts = journalFacts(value.facts);
	if (!value.facts || JSON.stringify(Object.keys(value.facts).sort()) !== JSON.stringify(Object.keys(facts).sort()) || Object.keys(facts).some(key => facts[key] !== value.facts[key])) throw new Error("JOURNAL_RECORD_INVALID");
	return { domain: value.domain, kind: value.kind, task: value.task, facts };
}
export class JournalProjector {
	constructor() { this.aliases = new Map(); this.counts = { development: 0, game: 0 }; }
	alias(id, domain) {
		if (typeof id !== "string" || !id || id.length > 256) return null;
		const key = domain + ":" + id;
		if (!this.aliases.has(key) && this.aliases.size >= journalLimits.events) return null;
		if (!this.aliases.has(key)) this.aliases.set(key, domain + "-" + ++this.counts[domain]);
		return this.aliases.get(key);
	}
	project(event, context = {}) {
		let domain, kind, task = null, facts;
		if (event?.type === "workbench" && (kinds.development.includes(event.kind) || ["started", "settled"].includes(event.kind))) { domain = "development"; kind = ["started", "settled"].includes(event.kind) ? "task" : event.kind; task = this.alias(event.taskId, domain); facts = journalFacts(event.facts); }
		else if (event?.type === "game-changed") { domain = "game"; kind = "stage"; const game = context.game; task = this.alias(game?.currentTaskId, domain); facts = journalFacts({ state: game?.phase, busy: game?.busy, available: game?.runtimeAvailable, count: game?.unresolved?.length, code: game?.error }); }
		else if (event?.type === "bridge-changed") { domain = "bridge"; kind = "state"; const bridge = context.bridge; facts = journalFacts({ state: bridge?.observation?.connected ? "connected" : "disconnected", busy: bridge?.busy, count: bridge?.observation?.summary?.data?.coverage?.returned, requests: bridge?.observation?.requests, code: bridge?.error }); }
		else if (event?.type === "probe-state") { domain = "probe"; kind = "state"; facts = journalFacts({ busy: event.busy }); }
		else if (event?.type === "probe-result") { domain = "probe"; kind = "result"; facts = journalFacts(event.result); }
		else if (["tool_execution_start", "tool_execution_end"].includes(event?.type)) { domain = "probe"; kind = "tool"; facts = journalFacts({ name: event.toolName, state: event.type === "tool_execution_start" ? "running" : "completed" }); }
		else if (event?.type === "system-power") { domain = "system"; kind = "power"; facts = journalFacts({ state: event.power?.phase, busy: event.power?.draining, code: event.power?.error }); }
		else if (["runtime-stopped", "ui-health", "ui-recovered", "native-state"].includes(event?.type)) { domain = "system"; kind = event.type; facts = journalFacts({ available: event.nativeResponsive, busy: event.blocked }); }
		else return null;
		return validateJournalPoint({ domain, kind, task, facts });
	}
}
