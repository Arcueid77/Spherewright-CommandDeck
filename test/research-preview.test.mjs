import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { matchResearchBudget, nativeResearchStateHash, normalizeResearchBudget, researchBudgetFromRequirements, researchCountLimit } from "../apps/desktop/research-preview.mjs";

const scope = { kind: "select-research", sessionId: "session-A", planetId: 104, techId: 1001, selectionStateHash: "sha256:" + "a".repeat(64) };
const requirement = { itemId: 1202, name: "磁线圈", requiredItemCount: 10 };
const budget = { itemId: 1202, name: "磁线圈", count: 10, direction: "research-consumption" };

test("native research hash matches independent C# Core v1 vectors including UTF-16 emoji and delimiters", async () => {
	// Root called the compiled Core CanonicalStateHash.Combine directly at source 99c2643.
	// These fixed outputs were copied from that C# probe, not computed by this JS implementation.
	const vectors = JSON.parse(await readFile(new URL("./fixtures/native-research-v1-vectors.json", import.meta.url), "utf8"));
	for (const vector of vectors) assert.equal(nativeResearchStateHash({ kind: "select-research", ...vector.scope }), vector.expected);
});

test("research hash binds each fixed native field and rejects invalid scope, integer widths and hash types", () => {
	for (const change of [{ sessionId: "session-B" }, { planetId: 105 }, { techId: 1002 }, { selectionStateHash: "sha256:" + "b".repeat(64) }]) assert.notEqual(nativeResearchStateHash({ ...scope, ...change }), nativeResearchStateHash(scope));
	for (const change of [{ kind: "build" }, { sessionId: "" }, { sessionId: "a\n" }, { sessionId: "a".repeat(129) }, { planetId: 0 }, { planetId: researchCountLimit + 1 }, { planetId: "104" }, { techId: -1 }, { techId: researchCountLimit + 1 }, { techId: 1.1 }, { selectionStateHash: "SHA256:" + "a".repeat(64) }]) assert.throws(() => nativeResearchStateHash({ ...scope, ...change }), /INVALID_RESEARCH_TASK_SCOPE/);
});

test("research total requirements project a bounded, sorted immutable budget without treating display text as identity", () => {
	const source = [{ itemId: 6001, name: "矩阵\n" + "x".repeat(180), requiredItemCount: researchCountLimit + 100, pointsPerHash: 1 }, { ...requirement }, { itemId: 1001, name: "零", requiredItemCount: 0 }];
	const normalized = researchBudgetFromRequirements(source);
	assert.deepEqual(normalized.map((item) => [item.itemId, item.count]), [[1001, 0], [1202, 10], [6001, researchCountLimit]]);
	assert.equal(normalized[2].name.length, 160); assert.ok(!normalized[2].name.includes("\n"));
	assert.ok(Object.isFrozen(normalized)); assert.ok(normalized.every(Object.isFrozen));
	source[1].requiredItemCount = 999; assert.equal(normalized[1].count, 10);
	assert.deepEqual(matchResearchBudget([{ ...budget, name: "Other display text" }], [budget]), [budget]);
});

test("budget validation rejects missing, extra, wrong, duplicated, excessive and unsafe items", () => {
	for (const value of [undefined, {}, Array(1), Array.from({ length: 65 }, (_, index) => ({ ...budget, itemId: index + 1 })), [budget, budget], [{ ...budget, itemId: 0 }], [{ ...budget, itemId: researchCountLimit + 1 }], [{ ...budget, count: -1 }], [{ ...budget, count: 0.5 }], [{ ...budget, count: researchCountLimit + 1 }], [{ ...budget, count: Number.MAX_SAFE_INTEGER + 1 }], [{ ...budget, count: "10" }], [{ ...budget, direction: "consume" }], [{ ...budget, name: null }], [{ ...budget, secret: "unexpected" }]]) assert.throws(() => normalizeResearchBudget(value), /RESEARCH_BUDGET_INVALID/);
	for (const value of [undefined, [requirement, requirement], [{ ...requirement, requiredItemCount: -1 }], [{ ...requirement, requiredItemCount: Number.MAX_SAFE_INTEGER + 1 }], [{ ...requirement, requiredItemCount: "10" }]]) assert.throws(() => researchBudgetFromRequirements(value), /RESEARCH_BUDGET_INVALID/);
	for (const value of [[], [{ ...budget, itemId: 1203 }], [{ ...budget, count: 11 }], [budget, { ...budget, itemId: 1203 }]]) assert.throws(() => matchResearchBudget(value, [budget]), /RESEARCH_BUDGET_MISMATCH/);
});
