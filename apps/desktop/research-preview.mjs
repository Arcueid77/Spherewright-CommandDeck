import { createHash } from "node:crypto";
import { opaque, selectionHash } from "./research-contract.mjs";

export const researchCountLimit = 2147483647;
export const researchId = (value) => Number.isInteger(value) && value > 0 && value <= researchCountLimit;
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const displayName = (value) => {
	if (typeof value !== "string") throw new Error("RESEARCH_BUDGET_INVALID");
	return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160);
};

// CanonicalStateHash.Combine v1: .NET string.Length counts UTF-16 code units.
// This is deliberately closed to a normal enqueue; callers cannot select a hash domain or priority.
export function nativeResearchStateHash(scope) {
	if (!record(scope) || scope.kind !== "select-research" || !opaque(scope.sessionId) || !researchId(scope.planetId) || !researchId(scope.techId) || !selectionHash(scope.selectionStateHash)) throw new Error("INVALID_RESEARCH_TASK_SCOPE");
	const fields = ["action-v1", "select-research", scope.sessionId, String(scope.planetId), scope.selectionStateHash, String(scope.techId), "False"];
	return "sha256:" + createHash("sha256").update(fields.map((value) => `${value.length}:${value}|`).join(""), "utf8").digest("hex");
}

// Names are display text only. Only item identity, quantity and direction establish budget equality.
export function normalizeResearchBudget(value) {
	if (!Array.isArray(value) || value.length > 64) throw new Error("RESEARCH_BUDGET_INVALID");
	const items = Array.from(value, (item) => {
		if (!record(item) || Object.keys(item).length !== 4 || !Object.keys(item).every((key) => ["itemId", "name", "count", "direction"].includes(key)) || !researchId(item.itemId) || !count(item.count) || item.count > researchCountLimit || item.direction !== "research-consumption") throw new Error("RESEARCH_BUDGET_INVALID");
		return Object.freeze({ itemId: item.itemId, name: displayName(item.name), count: item.count, direction: "research-consumption" });
	});
	if (new Set(items.map((item) => item.itemId)).size !== items.length) throw new Error("RESEARCH_BUDGET_INVALID");
	return Object.freeze(items.sort((left, right) => left.itemId - right.itemId));
}

export function researchBudgetFromRequirements(requirements) {
	if (!Array.isArray(requirements) || requirements.length > 64) throw new Error("RESEARCH_BUDGET_INVALID");
	return normalizeResearchBudget(Array.from(requirements, (item) => {
		if (!record(item) || !count(item.requiredItemCount)) throw new Error("RESEARCH_BUDGET_INVALID");
		return { itemId: item.itemId, name: item.name, count: Math.min(researchCountLimit, item.requiredItemCount), direction: "research-consumption" };
	}));
}

export function matchResearchBudget(nativeBudget, observedBudget) {
	const native = normalizeResearchBudget(nativeBudget), observed = normalizeResearchBudget(observedBudget);
	if (native.length !== observed.length || native.some((item, index) => ["itemId", "count", "direction"].some((key) => item[key] !== observed[index][key]))) throw new Error("RESEARCH_BUDGET_MISMATCH");
	return observed;
}
