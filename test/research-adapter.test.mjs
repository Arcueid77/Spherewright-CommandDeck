import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";
import { ResearchAdapter } from "../apps/desktop/research-adapter.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";

async function fixture(t, mode = "normal") {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-research-wire-")), authority = {}, approvalAuthority = {};
	const client = new ReadOnlyMcpClient(spawn(process.execPath, [fileURLToPath(new URL("./fixtures/research-mcp-server.mjs", import.meta.url)), mode], { windowsHide: true, stdio: "pipe" }), { researchAuthority: authority, timeoutMs: 1000 });
	await client.discover(); let ledger, adapter;
	t.after(async () => { ledger?.close(); await client.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-research-wire-")); await rm(absolute, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 }); });
	const open = async () => {
		adapter = new ResearchAdapter({ client, authority, selection: { cohortHash: "fixture-cohort" } });
		ledger = new GameIntentLedger(join(directory, "game.sqlite"), { approvalAuthority, prepareResearch: (request) => adapter.prepareResearch(request, ledger.task(task.id).scope), readResearchProof: (request) => adapter.readResearchProof(request) });
		const observed = await adapter.observe(undefined, { player: true });
		const task = ledger.createResearchTask({ ...observed.context, capturedAtGameTick: observed.progression.capturedAtGameTick, techId: 100 });
		return { adapter, ledger, task, observed };
	};
	return { client, authority, approvalAuthority, directory, open };
}

test("research wire capability requires exact host authority, annotations and schema; public read stays closed", async (t) => {
	for (const mode of ["normal", "bad-schema", "bad-commit-hint"]) {
		const f = await fixture(t, mode);
		await assert.rejects(f.client.read("spherewright_commit_select_research", {}), /READ_NOT_SUPPORTED/);
		assert.throws(() => f.client.researchPort({}), /TRUSTED_RESEARCH_CAPABILITY_REQUIRED/);
		if (mode !== "normal") assert.throws(() => f.client.researchPort(f.authority), /TRUSTED_RESEARCH_CAPABILITY_REQUIRED/);
		else {
			const port = f.client.researchPort(f.authority);
			await assert.rejects(port.prepare({ sessionId: "s", planetId: 1, techId: 100, expectedSelectionStateHash: "sha256:" + "a".repeat(64), stateHashVersion: 1, prioritizeQueued: true }), /RESEARCH_CALL_NOT_SUPPORTED/);
			await assert.rejects(port.commit({ sessionId: "s", planetId: 1, planToken: "x".repeat(30), idempotencyKey: "key", extra: true }), /RESEARCH_CALL_NOT_SUPPORTED/);
		}
		assert.equal(f.client.stats.toolCalls, 0);
	}
});

test("actual stdio prepare -> durable intent -> unique commit -> original result -> fresh queue reconciles", async (t) => {
	const f = await fixture(t), { adapter, ledger, task, observed } = await f.open();
	assert.ok((await adapter.playbook()).text.includes("never replay"));
	assert.ok(!JSON.stringify(observed).includes("PRIVATE_"));
	const preview = await ledger.prepare(task.id); assert.equal(preview.scope.techId, 100); assert.ok(!JSON.stringify(preview).includes("PRIVATE_"));
	ledger.approve(f.approvalAuthority, task.id, preview.previewHash);
	const fresh = await adapter.observe(task.scope), intent = ledger.beginIntent(task.id, preview.previewHash, fresh.context);
	const acceptance = await adapter.commit(intent.commit); assert.equal(acceptance.syntheticCommitCount, 1); ledger.accept(intent.intentId, acceptance);
	const completed = await ledger.reconcile(intent.intentId); assert.equal(completed.state, "completed"); assert.deepEqual(completed.terminal.afterQueue, [99, 100]);
	const count = f.client.stats.toolCalls; await ledger.reconcile(intent.intentId); assert.equal(f.client.stats.toolCalls, count);
	assert.throws(() => ledger.beginIntent(task.id, preview.previewHash, fresh.context), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	ledger.close(); assert.ok(!(await readFile(join(f.directory, "game.sqlite"))).includes(Buffer.from("PRIVATE_")));
});

test("unowned, disabled, changed world and stale selection refuse before commit", async (t) => {
	for (const mode of ["unowned", "writes-disabled", "world-switch", "stale-selection"]) {
		const f = await fixture(t, mode);
		if (mode === "stale-selection") { const { ledger, task } = await f.open(); await assert.rejects(ledger.prepare(task.id), /RESEARCH_SELECTION_CHANGED/); assert.equal(ledger.unresolved().length, 0); }
		else await assert.rejects(f.open(), /OWNED_RESEARCH_WORLD_REQUIRED|HEALTHY_RESEARCH_WRITES_REQUIRED|GAME_CONTEXT_CHANGED/);
	}
});

test("pending action stays pending; wrong queue or native unknown never becomes success", async (t) => {
	for (const mode of ["pending", "wrong-queue", "native-unknown", "native-unknown-context-failure"]) {
		const f = await fixture(t, mode), { ledger, task, adapter } = await f.open(), preview = await ledger.prepare(task.id);
		ledger.approve(f.approvalAuthority, task.id, preview.previewHash);
		const intent = ledger.beginIntent(task.id, preview.previewHash, (await adapter.observe(task.scope)).context); ledger.accept(intent.intentId, await adapter.commit(intent.commit));
		await assert.rejects(ledger.reconcile(intent.intentId), mode === "pending" ? /ORIGINAL_ACTION_PENDING/ : mode === "wrong-queue" ? /RESEARCH_TERMINAL_PROOF_INCOMPLETE/ : /INDEPENDENT_GAME_AUDIT_REQUIRED/);
		assert.equal(ledger.unresolved().length, 1);
		if (mode === "pending") { assert.equal(ledger.intent(intent.intentId).state, "accepted"); assert.equal((await ledger.reconcile(intent.intentId)).state, "completed"); }
		if (mode === "native-unknown-context-failure") await assert.rejects(adapter.context(task.scope), /MCP_TOOL_REJECTED/);
		if (mode.startsWith("native-unknown")) { const count = f.client.stats.toolCalls; await assert.rejects(ledger.reconcile(intent.intentId), /INDEPENDENT_GAME_AUDIT_REQUIRED/); assert.equal(f.client.stats.toolCalls, count); }
	}
});
