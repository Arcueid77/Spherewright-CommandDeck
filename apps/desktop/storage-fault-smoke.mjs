import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mcpLossCase } from "./mcp-loss-case.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const originalFile = "storage-original.private.json";
const disabled = "(()=>{const panel=document.querySelector('.game-tasks-panel');return panel&&['开始分析','核对并确认入队'].every(label=>[...panel.querySelectorAll('button')].some(button=>button.textContent===label&&button.matches(':disabled')))})()";

export function armLostAckStorageFault(host) {
	assert.equal(host.syntheticOnly, true); assert.equal(host.phase, "awaiting_approval"); assert.equal(host.ledger.storageAvailable, true); assert.deepEqual(host.ledger.unresolved(), []);
	const ledger = host.ledger, beginIntent = ledger.beginIntent, markUnknown = ledger.markUnknown;
	let durableIntent = null, unknownWriteAttempts = 0, unknownWriteRejected = false, restored = false;
	ledger.beginIntent = function (...args) {
		assert.equal(durableIntent, null); const intent = beginIntent.apply(this, args); durableIntent = structuredClone(this.intent(intent.intentId));
		assert.equal(durableIntent.state, "recorded"); this.db.exec("PRAGMA query_only=ON"); return intent;
	};
	ledger.markUnknown = function (id, ...args) {
		unknownWriteAttempts++; assert.equal(id, durableIntent.intentId); assert.equal(this.db.prepare("PRAGMA query_only").get().query_only, 1);
		try { return markUnknown.call(this, id, ...args); }
		catch (error) { assert.equal(error.message, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(this.storageAvailable, false); unknownWriteRejected = true; throw error; }
	};
	return Object.freeze({
		get durableIntent() { return structuredClone(durableIntent); }, get unknownWriteAttempts() { return unknownWriteAttempts; }, get unknownWriteRejected() { return unknownWriteRejected; },
		restore() { if (restored) return; ledger.db.exec("PRAGMA query_only=OFF"); ledger.beginIntent = beginIntent; ledger.markUnknown = markUnknown; restored = true; },
	});
}

async function ui(driver) {
	const evaluate = source => driver.testCommand("evaluate", { source });
	const state = () => driver.api("game", { action: "snapshot" });
	async function until(predicate, label) { const deadline = performance.now() + 12000; while (!await predicate()) { if (performance.now() > deadline) { await writeFile(join(driver.context.root, "storage-" + (driver.storageCase?.resume ? "resume" : "fault") + "-failure.private.json"), JSON.stringify({ label, state: await state(), ui: await evaluate("document.body.innerText") }), { flag: "wx" }); throw new Error("STORAGE_SMOKE_TIMEOUT_" + label); } await new Promise(resolve => setTimeout(resolve, 50)); } }
	async function activate() {
		await until(() => evaluate("(()=>{const button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(document.querySelector('header')?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "LAYOUT_READY");
		await until(() => evaluate("Boolean(document.querySelector('.game-tasks-panel'))"), "PANEL");
	}
	return { evaluate, state, until, activate };
}

export async function runGameStorageFaultSmoke(driver, { evaluate, state, until, requests, base }) {
	const { scenario, resume } = driver.storageCase, host = driver.getGameTasks(), taskId = (await state()).currentTaskId;
	assert.equal(resume, false); assert.equal(host.syntheticOnly, true); assert.equal((await state()).phase, "awaiting_approval"); assert.equal(host.ledger.storageAvailable, true);
	const runtimePid = driver.getRuntimePid(), originalClient = driver.getBridgeClient();
	const adapter = host.adapter, commit = adapter.commit, reconcile = host.ledger.reconcile;
	try {
		if (scenario === "before-send") host.ledger.db.exec("PRAGMA query_only=ON");
		else if (scenario === "receipt") adapter.commit = async function(dto) { const receipt = await commit.call(this, dto); assert.equal(receipt.accepted, true); host.ledger.db.exec("PRAGMA query_only=ON"); return receipt; };
		else { assert.equal(scenario, "terminal"); host.ledger.reconcile = async function(id) { assert.equal(this.intent(id).state, "accepted"); host.ledger.db.exec("PRAGMA query_only=ON"); return reconcile.call(this, id); }; }
		await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate("window.deck.confirmResearch(" + JSON.stringify(taskId) + ")");
		await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.storageAvailable === false; }, "WRITE_BLOCKED");
	} finally { host.ledger.db.exec("PRAGMA query_only=OFF"); adapter.commit = commit; host.ledger.reconcile = reconcile; }
	const blocked = await state(), world = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8"));
	assert.equal(blocked.error, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(blocked.developmentFrozen, true); assert.equal(blocked.storageAvailable, false); assert.equal(blocked.tasks.length, 1); assert.equal(blocked.tasks[0].id, taskId);
	assert.equal(world.commits, scenario === "before-send" ? 0 : 1); assert.equal(world.prepares, 1); assert.equal(world.launches, 1); assert.equal(world.resultReads, scenario === "terminal" ? 1 : 0); assert.equal(requests(), 3);
	const intent = blocked.tasks[0].intent; assert.equal(blocked.unresolved.length, scenario === "before-send" ? 0 : 1);
	if (scenario === "before-send") assert.equal(intent, null);
	else { assert.equal(intent.state, scenario === "receipt" ? "recorded" : "accepted"); assert.equal(intent.actionId, scenario === "receipt" ? null : "synthetic-action"); assert.equal(intent.terminal, null); }
	for (const action of ["start", "catalog", "reprepare", "reconcile"]) await assert.rejects(driver.api("game", { action, args: { intentId: intent?.intentId } }), /GAME_LEDGER_STORAGE_UNAVAILABLE/);
	await assert.rejects(driver.api("probe", { mode: "offline" })); await driver.api("game", { action: "stop" });
	const helpers = await ui(driver); await driver.testCommand("reload"); await helpers.activate();
	await helpers.until(() => helpers.evaluate(disabled + "&&document.querySelector('.game-tasks-panel').textContent.includes('任务记录无法写入')"), "UNAVAILABLE_UI");
	assert.deepEqual((await state()).tasks, blocked.tasks); assert.deepEqual((await state()).events, blocked.events); assert.equal(driver.getRuntimePid(), runtimePid); assert.equal(driver.getBridgeClient(), originalClient);
	if (intent) assert.equal(await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').disabled"), true);
	const diagnostic = await evaluate("(async()=>{const preview=await window.deck.diagnosticPreview({includeTasks:true,includePerformance:true});try{return JSON.parse(preview.text)}finally{await window.deck.discardDiagnosticPreview(preview.id)}})()");
	assert.equal(diagnostic.game.storageAvailable, false); assert.equal(diagnostic.game.code, "GAME_LEDGER_STORAGE_UNAVAILABLE");
	assert.deepEqual(JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8")), world); assert.equal(requests(), 3); assert.equal(driver.getProbeSequence(), 0);
	const original = { version: 1, kind: "synthetic-storage-original", runId: driver.runId, scenario, task: blocked.tasks[0], events: blocked.events, world, sha256: hash({ task: blocked.tasks[0], events: blocked.events }) };
	await writeFile(join(driver.context.root, originalFile), JSON.stringify(original), { flag: "wx" });
	return { runId: driver.runId, storageScenario: scenario, phase: "fault", fault: "sqlite-query-only", storageBlocked: true, developmentFrozen: true, restoredWritabilityDoesNotUnlock: true, uiReloadRetainsFreeze: true, diagnosticShowsStorageFailure: true, originalRecordSha256: original.sha256, noProbeAllocated: true, noModelOrCommitReplay: true, syntheticModelRequests: 3, syntheticPrepareCalls: 1, syntheticGameCommits: world.commits, originalActionIdAvailable: Boolean(intent?.actionId), nativeConfirmationMocked: true, physicalInputVerified: false, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false };
}

export async function runGameMcpStorageFaultSmoke(driver, { evaluate, state, until, requests, base }) {
	assert.equal(mcpLossCase(driver.mcpLossScenario).storageFailure, true);
	const host = driver.getGameTasks(), runtimePid = driver.getRuntimePid(), client = driver.getBridgeClient(), taskId = (await state()).currentTaskId, fault = armLostAckStorageFault(host);
	try {
		await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate("window.deck.confirmResearch(" + JSON.stringify(taskId) + ")");
		await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.storageAvailable === false && client.exitConfirmed; }, "MCP_AND_STORAGE_BLOCKED");
	} finally { fault.restore(); }
	const blocked = await state(), original = fault.durableIntent, rpcCount = client.stats.requests;
	const before = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8"));
	assert.equal(fault.unknownWriteAttempts, 1); assert.equal(fault.unknownWriteRejected, true); assert.equal(host.ledger.db.prepare("PRAGMA query_only").get().query_only, 0);
	assert.equal(blocked.error, "GAME_LEDGER_STORAGE_UNAVAILABLE"); assert.equal(blocked.storageAvailable, false); assert.equal(blocked.developmentFrozen, true); assert.deepEqual(blocked.unresolved, [original]); assert.equal(blocked.tasks[0].state, "intent_recorded");
	assert.equal(original.state, "recorded"); assert.equal(original.actionId, null); assert.equal(original.acceptance, null); assert.equal(original.terminal, null);
	for (const action of ["start", "catalog", "reprepare", "reconcile"]) await until(async () => {
		if (!driver.getUi() || driver.getUi().nativeProbePending) return false;
		await assert.rejects(driver.api("game", { action, args: { intentId: original.intentId } }), /GAME_LEDGER_STORAGE_UNAVAILABLE/); return true;
	}, "COMBINED_STORAGE_ADMISSION");
	await assert.rejects(driver.api("probe", { mode: "offline" })); await driver.api("game", { action: "stop" });
	assert.deepEqual((await state()).tasks, blocked.tasks); assert.deepEqual((await state()).events, blocked.events);
	const helpers = await ui(driver); await driver.testCommand("reload"); await helpers.activate();
	await helpers.until(() => helpers.evaluate(disabled + "&&document.querySelector('.game-tasks-panel').textContent.includes('任务记录无法写入')"), "COMBINED_STORAGE_UI");
	assert.deepEqual((await state()).tasks, blocked.tasks); assert.deepEqual((await state()).events, blocked.events); assert.equal(driver.getRuntimePid(), runtimePid); assert.equal(driver.getBridgeClient(), client); assert.equal(client.stats.requests, rpcCount); assert.equal(driver.getProbeSequence(), 0); assert.equal(requests(), 3);
	const world = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8"));
	assert.deepEqual(world, before);
	assert.equal(world.runId, driver.runId); assert.equal(world.commitRequests, 1); assert.equal(world.lastCommitRequestKey, original.idempotencyKey); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.launches, 1); assert.equal(world.resultReads, 0);
	await writeFile(join(base, "mcp-loss.private.json"), JSON.stringify({ runId: driver.runId, scenario: driver.mcpLossScenario, original, before, after: world, state: await state() }), { flag: "wx" });
	const proofDirectory = driver.proofDirectory ?? join(driver.root, ".local/mcp-loss", driver.runId);
	await mkdir(proofDirectory, { recursive: true });
	await writeFile(join(proofDirectory, "desktop-smoke-game-mcp-" + driver.mcpLossScenario + ".application.private.json"), JSON.stringify({ runId: driver.runId, mcpLossScenario: driver.mcpLossScenario, syntheticOnly: true, originalMcpExitObserved: true, originalAcceptedActionReconciled: false, unknownCommitRemainsBlocked: false, recordedIntentRemainsBlocked: true, mismatchRemainsBlocked: false, nativeOutcomeRemainsBlocked: false, nativeOutcome: null, recoveryError: null, repeatedIsolatedReconciliationMakesNoRequests: false, originalIdentityRetained: true, newExecutionDisabledDuringLoss: true, explicitOriginalReconciliationOnly: false, noModelOrCommitReplay: true, runtimeRetained: true, replacementMcpCount: 0, syntheticModelRequests: requests(), syntheticGameCommits: 1, syntheticCommitRequests: 1, syntheticPrepareCalls: 1, duplicateRepliesIgnored: 0, duplicateDelivery: null, ownServerExitConfirmed: true, storageFailure: { fault: "sqlite-query-only", unknownWriteAttempts: fault.unknownWriteAttempts, unknownWriteRejected: fault.unknownWriteRejected, durableIntentRetained: true, restoredWritabilityDoesNotUnlock: true, uiReloadRetainsFreeze: true, newGameExecutionRejected: true }, modelUsage: { normalizedTokens: blocked.tasks[0].details.usage.tokens.totalTokens, reportedResponses: 3, estimatedUsd: blocked.tasks[0].details.usage.estimate.usd, retainedAcrossUiReloadAndMcpLoss: true }, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false, fullRecoveryMatrixVerified: false }), { flag: "wx" });
}

export async function runStorageResumeSmoke(driver) {
	const { scenario, resume } = driver.storageCase; assert.equal(resume, true);
	const file = join(driver.context.root, originalFile), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 262144); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	// Expected records are data only. Recovery authority still comes from the
	// actual ledger and its original scope; no plan or command is restored here.
	const original = JSON.parse(await readFile(file, "utf8")); assert.equal(original.version, 1); assert.equal(original.kind, "synthetic-storage-original"); assert.equal(original.runId, driver.runId); assert.equal(original.scenario, scenario); assert.equal(original.sha256, hash({ task: original.task, events: original.events }));
	const { evaluate, state, until, activate } = await ui(driver), initial = await state(), runtimePid = driver.getRuntimePid();
	assert.equal(initial.storageAvailable, true); assert.equal(initial.busy, false); assert.deepEqual(initial.tasks, [original.task]); assert.deepEqual(initial.events, original.events); assert.equal(driver.getBridgeClient(), undefined); assert.equal(driver.getProbeSequence(), 0);
	await activate();
	const base = join(driver.context.root, "runtime-fixtures/m3-smoke", driver.runId), worldFile = join(base, "synthetic-research-world.json");
	const world = () => readFile(worldFile, "utf8").then(JSON.parse);
	assert.deepEqual(await world(), original.world);
	if (scenario === "before-send") {
		assert.equal(initial.phase, "idle"); assert.equal(initial.unresolved.length, 0); assert.equal(initial.developmentFrozen, false);
		await assert.rejects(driver.api("game", { action: "reprepare" }), /GAME_CONFIRMATION_UNAVAILABLE/);
		await driver.testCommand("answer-game-confirmation", { response: 1 });
		assert.equal(await evaluate("(async()=>{try{await window.deck.confirmResearch(" + JSON.stringify(original.task.id) + ");return false}catch(error){return String(error).includes('GAME_CONFIRMATION_UNAVAILABLE')}})()"), true);
	} else {
		assert.equal(initial.phase, "blocked"); assert.equal(initial.developmentFrozen, true); assert.deepEqual(initial.unresolved, [original.task.intent]);
		await until(() => evaluate(disabled), "RECOVERED_EXECUTION_DISABLED");
		await assert.rejects(driver.api("game", { action: "start" }), /GAME_TASK_START_BLOCKED/);
		if (scenario === "receipt") { await assert.rejects(driver.api("game", { action: "reconcile", args: { intentId: original.task.intent.intentId } }), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.equal(driver.getBridgeClient(), undefined); }
		else {
			await driver.api("bridge-select", join(base, "Spherewright.Mcp.exe"));
			await until(() => evaluate("[...document.querySelectorAll('.game-task-receipt button')].some(button=>button.textContent==='核销原动作'&&!button.disabled)"), "ORIGINAL_QUERY_READY");
			await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').click()");
			await until(async () => { const value = await state(); return !value.busy && value.phase === "completed" && !value.developmentFrozen; }, "ORIGINAL_COMPLETED");
			const current = (await state()).tasks[0]; assert.equal(current.id, original.task.id); assert.equal(current.intent.actionId, original.task.intent.actionId); assert.equal(current.intent.idempotencyKey, original.task.intent.idempotencyKey); assert.deepEqual(current.intent.acceptance, original.task.intent.acceptance); assert.deepEqual(current.intent.terminal.afterQueue, [99, 100]);
			await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
		}
	}
	const retained = (await state()).tasks; await driver.testCommand("reload"); await activate(); assert.deepEqual((await state()).tasks, retained);
	const after = await world(); assert.equal(after.commits, original.world.commits); assert.equal(after.prepares, 1); assert.equal(after.launches, scenario === "terminal" ? 2 : 1); assert.equal(after.resultReads, scenario === "terminal" ? 2 : 0); assert.equal(driver.getProbeSequence(), 0); assert.equal(driver.getRuntimePid(), runtimePid);
	return { runId: driver.runId, storageScenario: scenario, phase: "resume", storageAvailable: true, originalRecordsRetainedOnOpen: true, originalRecordSha256: original.sha256, oldApprovalNotRestored: true, unknownActionRemainsBlocked: scenario === "receipt", onlyOriginalAcceptedActionReconciled: scenario === "terminal", noModelOrCommitReplay: true, noProbeAllocated: true, syntheticModelRequests: 0, syntheticPrepareCalls: after.prepares, syntheticGameCommits: after.commits, mcpLaunchesAcrossBothProcesses: after.launches, nativeConfirmationMocked: true, physicalInputVerified: false, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false };
}
