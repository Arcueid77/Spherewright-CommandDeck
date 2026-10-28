import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ModelUsage } from "../apps/desktop/model-usage.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { readModelUsageRecovery, modelUsageRecoveryFile, modelUsageRecoveryHash } from "../apps/desktop/model-usage-recovery.mjs";
import { usageRecoveryState } from "../scripts/model-usage-recovery-state.mjs";
import { assertPortableAction } from "../apps/desktop/portable-mode.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { const path = await realpath(root); assert.equal(path, root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith("commanddeck-desktop-smoke-")); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { root, runId };
}
function marker(context, scenario = "accepted") {
	const tracker = new ModelUsage({ pricing: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }, publish() {} });
	for (let i = 0; i < 3; i++) tracker.finish(tracker.start(), { usage: { input: 90, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 7, totalTokens: 120 } });
	const pending = ["world-change", "schema-change"].includes(scenario), id = randomUUID(), expected = { tasks: [{ id, scope: { techId: 100 }, details: { model: "fixture", mode: "assist", usage: tracker.snapshot() }, state: scenario === "accepted" ? "completed" : pending ? "accepted" : "blocked", intent: { taskId: id, state: scenario === "accepted" ? "completed" : pending ? "accepted" : "unknown", actionId: scenario === "lost-ack" ? null : "synthetic-action" } }], events: [] };
	return { version: 1, kind: "synthetic-model-usage-recovery", runId: context.runId, scenario, expected, sha256: modelUsageRecoveryHash(expected) };
}

test("usage recovery expectations preserve the original completed, accepted or isolated task", async t => {
	const f = await fixture(t), file = join(f.root, modelUsageRecoveryFile);
	assert.equal(await readModelUsageRecovery(f), null);
	for (const scenario of ["accepted", "lost-ack", "world-change", "schema-change", "receipt-mismatch", "native-unknown", "native-recovery", "native-failed", "recovery-flag"]) { const value = marker(f, scenario); await writeFile(file, JSON.stringify(value)); assert.deepEqual(await readModelUsageRecovery(f), value); }
	for (const scenario of ["world-change", "schema-change", "receipt-mismatch", "native-unknown", "native-recovery", "native-failed", "recovery-flag"]) { const value = marker(f, scenario); value.expected.tasks[0].intent.actionId = null; value.sha256 = modelUsageRecoveryHash(value.expected); await writeFile(file, JSON.stringify(value)); await assert.rejects(readModelUsageRecovery(f)); }
	const original = marker(f);
	for (const patch of [{ version: 2 }, { kind: "execute" }, { runId: randomUUID() }, { scenario: "other" }, { sha256: "0".repeat(64) }, { command: "PRIVATE_TEXT_MUST_NOT_RUN" }, { expected: { tasks: [], events: [] } }]) {
		const bytes = JSON.stringify({ ...original, ...patch }); await writeFile(file, bytes); await assert.rejects(readModelUsageRecovery(f)); assert.equal(await readFile(file, "utf8"), bytes);
	}
	await writeFile(file, " ".repeat(131073)); await assert.rejects(readModelUsageRecovery(f), /CASE_INVALID/);
});

test("usage recovery does not widen the portable renderer's model, game or configuration permissions", () => {
	for (const [action, args] of [["game", { action: "start" }], ["game", { action: "reconcile" }], ["workbench", { action: "agent" }], ["workbench", { action: "check" }], ["profiles-manage", { action: "save" }], ["bridge-select", "PRIVATE_EXECUTABLE"], ["probe", { mode: "live" }]]) assert.throws(() => assertPortableAction(action, args));
	assertPortableAction("game", { action: "snapshot" }); assertPortableAction("workbench", { action: "task" });
});

test("external restart witness reads all original game rows and exact Pi/vault/world files without changing them", async t => {
	const f = await fixture(t), profile = join(f.root, "supervisor-profile/supervisor"), gameFile = join(profile, "game-smoke-" + f.runId, "game-tasks.sqlite");
	const ledger = new GameIntentLedger(gameFile, { approvalAuthority: {}, prepareResearch: async () => { throw new Error("MUST_NOT_EXECUTE"); }, readResearchProof: async () => { throw new Error("MUST_NOT_EXECUTE"); } });
	const task = ledger.createResearchTask({ bridgeInstanceId: "synthetic-bridge", sessionId: "synthetic-session", planetId: 1, techId: 100, capturedAtGameTick: 1, selectionStateHash: "sha256:" + "a".repeat(64) });
	ledger.details(task.id, { mode: "observe", model: "fixture" }); ledger.close();
	const session = join(profile, "game-agent-smoke-" + f.runId, "sessions", "original.jsonl"), vault = join(profile, "vault-smoke-" + f.runId, "profiles.vault.json"), world = join(f.root, "runtime-fixtures/m3-smoke", f.runId, "synthetic-research-world.json");
	for (const file of [session, vault, world]) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, "synthetic-only"); }
	const original = await readFile(gameFile), before = await usageRecoveryState(f.root, f.runId), after = await usageRecoveryState(f.root, f.runId);
	assert.deepEqual(after, before); assert.deepEqual(await readFile(gameFile), original); assert.equal(before.rows.game_tasks.length, 1); assert.equal(before.pi.length, 1); assert.equal(before.pi[0].path.endsWith("original.jsonl"), true);
	await writeFile(join(dirname(session), "unexpected.jsonl"), "new synthetic session"); assert.notDeepEqual((await usageRecoveryState(f.root, f.runId)).pi, before.pi);
	await link(session, join(dirname(session), "hardlink.jsonl")); await assert.rejects(usageRecoveryState(f.root, f.runId));
});
