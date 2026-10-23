import assert from "node:assert/strict";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const portableRecoveryFile = "legacy-recovery-case.json";
export const recoveryHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Expected synthetic records are data. They never authorize a connection,
// approval, token, model turn or game action.
export async function readPortableRecovery(context) {
	const file = join(context.root, portableRecoveryFile); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 65536, "PORTABLE_RECOVERY_FILE_INVALID");
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.equal(value.version, 1); assert.equal(value.kind, "legacy-v1-pending-recovery"); assert.equal(value.runId, context.runId);
	assert.equal(value.legacySourceRevision, "f37dae5ad59df6968e7335c12bbc8f56a2dd5aae"); assert.equal(value.legacySourceBlob, "23fa44e215e69f47b3ed695b50858daf11f36d9f");
	assert.equal(value.task?.state, "accepted"); assert.equal(value.intent?.state, "accepted"); assert.equal(value.intent?.terminal, null);
	assert.equal(value.task.id, value.intent.taskId); assert.deepEqual(value.task.intent, value.intent); assert.deepEqual(value.task.details, {});
	assert.ok(typeof value.intent.idempotencyKey === "string" && value.intent.idempotencyKey && typeof value.intent.actionId === "string" && value.intent.actionId);
	assert.equal(value.sha256, recoveryHash({ task: value.task, intent: value.intent }));
	return value;
}

export async function assertPortableRecovery(api, expected) {
	const game = await api("game", { action: "snapshot" }), workbench = await api("workbench", { action: "state" }), bridge = await api("bridge", { action: "snapshot" });
	assert.equal(game.busy, false); assert.equal(game.phase, "blocked"); assert.equal(game.error, "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES"); assert.equal(game.developmentFrozen, true, "LEGACY_DEVELOPMENT_GATE_RELEASED"); assert.equal(game.currentTaskId, expected.task.id); assert.equal(game.syntheticOnly, true, "LEGACY_FIXTURE_LABEL_MISSING");
	assert.deepEqual(game.tasks, [expected.task]); assert.deepEqual(game.unresolved, [expected.intent]); assert.deepEqual(game.events, []);
	assert.equal(workbench.executionBlocked, true, "LEGACY_WORKBENCH_GATE_RELEASED"); assert.equal(workbench.gameWriteAccess, "development_frozen"); assert.equal(workbench.activeTask, null); assert.deepEqual(workbench.roots, []); assert.deepEqual(workbench.tasks, []);
	assert.equal(bridge.selected, null); assert.equal(bridge.metadata, null); assert.equal(bridge.observation, null); assert.equal(bridge.requestPerformance, null);
	return { originalPendingSha256: expected.sha256, unresolvedIntents: 1, developmentFrozen: true, noMcpSelected: true };
}

export function assertPendingRecoveryControls(value) {
	for (const label of ["开始分析", "核对并确认入队"]) {
		const button = value.buttons.find(button => button.text === label); assert.ok(button, "LEGACY_NEW_EXECUTION_CONTROL_MISSING"); assert.equal(button.disabled, true, "LEGACY_NEW_EXECUTION_CONTROL_ENABLED");
	}
	// Polling the retained original action is a read-only recovery operation.
	// Freezing new execution must keep this entry available to the operator.
	assert.ok(value.buttons.some(button => button.text === "核销原动作"), "LEGACY_ORIGINAL_ACTION_QUERY_MISSING");
}

export async function runPortableRecoverySmoke(driver, expected, manifest, runtimePid, settledUi) {
	const { api, testCommand, getRuntimePid, getProbeSequence, context } = driver;
	async function pendingUi(phase) {
		let value = null, completed = false, activated = false;
		try {
			const until = performance.now() + 10000;
			while (true) {
				if (!activated) activated = await testCommand("evaluate", { source: "(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()" });
				value = await testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('.game-tasks-panel');return {readyState:document.readyState,panelPresent:Boolean(panel),stage:panel?.querySelector('.game-task-stage')?.textContent??'',syntheticNotice:panel?.textContent.includes('NO DSP')??false,receipts:[...(panel?.querySelectorAll('.game-task-receipt')??[])].map(node=>node.textContent),buttons:[...(panel?.querySelectorAll('button')??[])].map(node=>({text:node.textContent,disabled:node.disabled}))}})()" });
				if (activated && value.stage.includes("等待核销") && value.stage.includes("冻结") && value.receipts.some(text => text.includes(expected.intent.actionId))) {
					assertPendingRecoveryControls(value);
					assert.equal(value.syntheticNotice, true, "LEGACY_FIXTURE_NOTICE_NOT_DISPLAYED");
					break;
				}
				assert.ok(performance.now() < until, "LEGACY_PENDING_UI_NOT_READY_" + phase.toUpperCase().replaceAll("-", "_")); await new Promise(resolve => setTimeout(resolve, 50));
			}
			assert.deepEqual((await testCommand("portable-renderer-state")).errors, []);
			completed = true;
		} finally {
			const renderer = await testCommand("portable-renderer-state").catch(() => ({ unavailable: true }));
			await writeFile(join(context.root, `legacy-recovery-ui-${process.pid}-${phase}.private.json`), JSON.stringify({ phase, completed, activatedAfterLayoutReady: activated, ui: value, renderer }), { flag: "wx" });
		}
	}
	assert.equal(getProbeSequence(), 0); const original = await assertPortableRecovery(api, expected);
	await pendingUi("before-reload");
	await settledUi(); await assert.rejects(api("probe", { mode: "offline" }), /GAME_EXECUTION_OWNS_RUNTIME/);
	assert.equal(getProbeSequence(), 0); assert.equal((await api("snapshot")).lastProbeResult, null);
	for (const [action, args] of [["bridge-select", "C:\\not-a-server.exe"], ["game", { action: "start" }], ["game", { action: "reconcile", args: { intentId: expected.intent.intentId } }], ["workbench", { action: "check" }]]) await assert.rejects(api(action, args), /PORTABLE_SMOKE_ACTION_REJECTED/);
	await testCommand("reload"); assert.equal(getRuntimePid(), runtimePid); await assertPortableRecovery(api, expected); assert.equal(getProbeSequence(), 0); await pendingUi("after-reload");
	await writeFile(join(context.root, "application-proof.json"), JSON.stringify({ runId: context.runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, packaged: true, visibleRenderer: true, rendererNodeDisabled: true, legacyPendingRecovery: original, originalApprovalNotReused: true, pendingDisplayedWithNewExecutionDisabled: true, originalActionQueryEntryRetained: true, layoutReadyBeforePanelActivation: true, uiReloadRetainsRuntimeAndPending: true, noProbeAllocated: true, syntheticModelRequests: 0, syntheticTools: 0, gameCalls: 0, realModelRequests: 0 }), { flag: "wx" });
}
