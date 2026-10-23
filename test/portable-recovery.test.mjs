import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { seedLegacyRecovery, readLegacyBaseRows } from "../scripts/legacy-recovery-fixture.mjs";
import { readPortableRecovery, assertPortableRecovery, assertPendingRecoveryControls, runPortableRecoverySmoke, portableRecoveryFile } from "../apps/desktop/portable-recovery.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";

async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID();
	t.after(async () => { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { directory, runId, ...await seedLegacyRecovery(directory, runId) };
}

test("the actual v1 pending fixture migrates and freezes development on each new coordinator without calling a planner", async t => {
	const f = await fixture(t), before = readLegacyBaseRows(f.file); assert.equal(before.version, 1);
	for (let reopen = 0; reopen < 2; reopen++) {
		let reserves = 0, unexpected = 0;
		const workbench = new Workbench({ directory: join(f.directory, "supervisor-profile/supervisor/m1-smoke-" + f.runId), helperSource: join(f.directory, "unused") });
		const fail = () => { unexpected++; throw new Error("NO_REPLAY_ALLOWED"); };
		const game = new GameTasks({ directory: dirname(f.file), bridge: {}, researchAuthority: {}, approvalAuthority: {}, syntheticOnly: true, freezeDevelopment: async () => { reserves++; workbench.gameWritesFrozen = false; }, releaseDevelopment: fail, planner: fail });
		try {
			await game.initialize();
			const api = async (action, args) => action === "game" ? game.snapshot() : action === "workbench" ? workbench.request(args.action, args.args) : { selected: null, metadata: null, observation: null, requestPerformance: null };
			const proof = await assertPortableRecovery(api, await readPortableRecovery({ root: f.directory, runId: f.runId })); assert.equal(proof.developmentFrozen, true); assert.equal(proof.unresolvedIntents, 1);
			await assert.rejects(workbench.start({ rootId: "unused", kind: "check" }, fail), /GAME_EXECUTION_OWNS_RUNTIME/);
			assert.equal(reserves, 1); assert.equal(unexpected, 0); assert.throws(() => game.ledger.confirmationPreview(f.expected.task.id), /FRESH_RESEARCH_PREVIEW_REQUIRED/);
			await game.drain(); assert.equal(unexpected, 0);
		} finally { game.close(); await workbench.close(); }
		const after = readLegacyBaseRows(f.file); assert.equal(after.version, 2); assert.deepEqual(after.rows, before.rows);
	}
});

test("recovery expectations reject foreign runs, changed identities and any silently released development gate", async t => {
	const f = await fixture(t), context = { root: f.directory, runId: f.runId }, file = join(f.directory, portableRecoveryFile), bytes = await readFile(file);
	await assert.rejects(readPortableRecovery({ ...context, runId: randomUUID() }));
	const changed = structuredClone(f.expected); changed.intent.idempotencyKey = "changed"; await writeFile(file, JSON.stringify(changed)); await assert.rejects(readPortableRecovery(context)); await writeFile(file, bytes);
	const api = async (action) => action === "game" ? { busy: false, phase: "blocked", error: "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES", developmentFrozen: true, syntheticOnly: true, currentTaskId: f.expected.task.id, tasks: [f.expected.task], unresolved: [f.expected.intent], events: [] } : action === "workbench" ? { executionBlocked: false, gameWriteAccess: "development_frozen", activeTask: null, roots: [], tasks: [] } : { selected: null, metadata: null, observation: null, requestPerformance: null };
	await assert.rejects(assertPortableRecovery(api, f.expected));
});

test("a blocked pending task disables new execution while retaining the read-only original-action query entry", () => {
	const buttons = [{ text: "开始分析", disabled: true }, { text: "核对并确认入队", disabled: true }, { text: "核销原动作", disabled: false }];
	assertPendingRecoveryControls({ buttons });
	for (let index = 0; index < 2; index++) { const changed = structuredClone(buttons); changed[index].disabled = false; assert.throws(() => assertPendingRecoveryControls({ buttons: changed }), /NEW_EXECUTION_CONTROL_ENABLED/); }
	assert.throws(() => assertPendingRecoveryControls({ buttons: buttons.slice(0, 2) }), /ORIGINAL_ACTION_QUERY_MISSING/);
});

function recoveryDriver(f, enabledNewExecution = false) {
	let reloads = 0, activationAttempts = 0, phaseActivationAttempts = 0;
	const api = async (action, args) => {
		if (action === "game" && args?.action === "snapshot") return { busy: false, phase: "blocked", error: "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES", developmentFrozen: true, syntheticOnly: true, currentTaskId: f.expected.task.id, tasks: [f.expected.task], unresolved: [f.expected.intent], events: [] };
		if (action === "workbench" && args?.action === "state") return { executionBlocked: true, gameWriteAccess: "development_frozen", activeTask: null, roots: [], tasks: [] };
		if (action === "bridge" && args?.action === "snapshot") return { selected: null, metadata: null, observation: null, requestPerformance: null };
		if (action === "snapshot") return { lastProbeResult: null };
		throw new Error(action === "probe" ? "GAME_EXECUTION_OWNS_RUNTIME" : "PORTABLE_SMOKE_ACTION_REJECTED");
	};
	return { api, context: { root: f.directory, runId: f.runId }, getRuntimePid: () => 37, getProbeSequence: () => 0, getReloads: () => reloads, getActivationAttempts: () => activationAttempts,
		testCommand: async (name, args) => {
			if (name === "reload") { reloads++; phaseActivationAttempts = 0; return true; }
			if (name === "portable-renderer-state") return { errors: [] };
			assert.equal(name, "evaluate"); if (args.source.includes("button.click()")) { activationAttempts++; return ++phaseActivationAttempts > 1; }
			assert.ok(args.source.includes(".game-tasks-panel"));
			return { stage: "等待核销 · 开发写入与构建已冻结", syntheticNotice: true, receipts: [f.expected.intent.actionId], buttons: [{ text: "开始分析", disabled: !enabledNewExecution }, { text: "核对并确认入队", disabled: true }, { text: "核销原动作", disabled: false }] };
		} };
}

test("the recovery smoke writes its completion receipt only after both UI phases and preserves phase diagnostics", async t => {
	const f = await fixture(t), driver = recoveryDriver(f), manifest = { sourceRevision: "synthetic-source", piCommit: "synthetic-pi" };
	await runPortableRecoverySmoke(driver, f.expected, manifest, 37, async () => {});
	assert.equal(driver.getReloads(), 1);
	assert.equal(driver.getActivationAttempts(), 4, "Each phase must wait for a ready activation, even if a pending snapshot is already displayed");
	const proof = JSON.parse(await readFile(join(f.directory, "application-proof.json"), "utf8"));
	assert.equal(proof.legacyPendingRecovery.originalPendingSha256, f.expected.sha256); assert.equal(proof.pendingDisplayedWithNewExecutionDisabled, true); assert.equal(proof.layoutReadyBeforePanelActivation, true); assert.equal(proof.noProbeAllocated, true);
	for (const phase of ["before-reload", "after-reload"]) { const diagnostic = JSON.parse(await readFile(join(f.directory, `legacy-recovery-ui-${process.pid}-${phase}.private.json`), "utf8")); assert.equal(diagnostic.phase, phase); assert.equal(diagnostic.completed, true); assert.equal(diagnostic.activatedAfterLayoutReady, true); }
});

test("a new-execution regression retains the failing UI phase without writing a completion receipt", async t => {
	const f = await fixture(t), driver = recoveryDriver(f, true);
	await assert.rejects(runPortableRecoverySmoke(driver, f.expected, {}, 37, async () => {}), /NEW_EXECUTION_CONTROL_ENABLED/);
	assert.equal(driver.getReloads(), 0);
	const diagnostic = JSON.parse(await readFile(join(f.directory, `legacy-recovery-ui-${process.pid}-before-reload.private.json`), "utf8"));
	assert.equal(diagnostic.completed, false); assert.equal(diagnostic.ui.buttons[0].disabled, false);
	await assert.rejects(readFile(join(f.directory, "application-proof.json")), { code: "ENOENT" });
});
