import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpLossCase } from "./mcp-loss-case.mjs";

export function mcpLossProofName(scenario) {
	mcpLossCase(scenario);
	return "desktop-smoke-game-mcp-" + scenario + ".application.private.json";
}

export async function assertBlockedMcpExecution(driver, until) {
	for (const action of ["start", "catalog"]) await until(async () => {
		// A UI response probe is an earlier, transient supervisor admission gate.
		// Check it and invoke the synchronous admission prefix in the same turn;
		// keep requiring the ledger gate's exact rejection, not either error.
		const ui = driver.getUi();
		if (!ui || ui.nativeProbePending) return false;
		await assert.rejects(driver.api("game", { action }), /GAME_TASK_START_BLOCKED/);
		return true;
	}, "MCP_LOSS_NATIVE_RESPONSE_CHECK_PENDING");
}

export async function runGameMcpLossSmoke(driver, { evaluate, state, until, requests, base }) {
	const accepted = driver.mcpLossScenario === "accepted", expected = mcpLossCase(driver.mcpLossScenario), originalClient = driver.getBridgeClient(), runtimePid = driver.getRuntimePid(), taskId = (await state()).currentTaskId;
	const usage = (await state()).tasks[0].details.usage;
	const world = async () => { const value = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8")); assert.equal(value.runId, driver.runId); return value; };
	async function reloadGame() {
		await driver.testCommand("reload");
		await until(() => evaluate("(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "MCP_RECOVERY_LAYOUT_READY");
		await until(() => evaluate("Boolean(document.querySelector('.game-tasks-panel'))"), "MCP_RECOVERY_PANEL");
	}
	const disabledExecution = () => evaluate("(()=>{const panel=document.querySelector('.game-tasks-panel');return ['开始分析','核对并确认入队'].every(label=>[...panel.querySelectorAll('button')].some(button=>button.textContent===label&&button.matches(':disabled')))})()");
	await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate(`window.deck.confirmResearch(${JSON.stringify(taskId)})`);
	await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.unresolved.length === 1 && originalClient.exitConfirmed; }, "ORIGINAL_MCP_EXITED");
	const blocked = await state(), original = structuredClone(blocked.unresolved[0]), before = await world();
	assert.equal(original.state, expected.hasActionId ? "accepted" : "unknown"); assert.equal(original.actionId, expected.hasActionId ? "synthetic-action" : null);
	assert.equal(blocked.developmentFrozen, true); assert.equal(before.commits, 1); assert.equal(before.prepares, 1); assert.equal(before.launches, 1); assert.equal(requests(), 3);
	await assert.rejects(driver.api("probe", { mode: "offline" })); assert.equal(driver.getProbeSequence(), 0);
	await reloadGame(); await until(disabledExecution, "MCP_LOSS_EXECUTION_DISABLED");
	assert.deepEqual((await state()).tasks, blocked.tasks); assert.equal(driver.getBridgeClient(), originalClient); assert.equal(driver.getRuntimePid(), runtimePid); assert.deepEqual(await world(), before);
	await until(() => evaluate("[...document.querySelectorAll('.game-task-receipt button')].some(button=>button.textContent==='核销原动作')"), "ORIGINAL_RECONCILIATION_VISIBLE");
	assert.equal(await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').disabled"), !expected.hasActionId);
	if (accepted) {
		await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').click()");
		await until(async () => { const value = await state(); return !value.busy && value.phase === "completed" && !value.developmentFrozen; }, "ORIGINAL_ACTION_RECOVERED");
		const done = await state(), current = done.tasks[0].intent; assert.equal(done.unresolved.length, 0);
		assert.notEqual(driver.getBridgeClient(), originalClient); assert.equal(current.actionId, original.actionId); assert.equal(current.idempotencyKey, original.idempotencyKey); assert.deepEqual(current.acceptance, original.acceptance); assert.deepEqual(current.terminal.afterQueue, [99, 100]);
		await reloadGame(); await until(() => evaluate("document.body.innerText.includes('队列变化已核对')"), "MCP_RECOVERED_RECEIPT_RELOADED"); assert.deepEqual((await state()).tasks, done.tasks);
		await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
	} else if (expected.error) {
		await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').click()");
		await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.error === expected.error; }, "MCP_RECOVERY_MISMATCH_BLOCKED");
		const refused = await state(), current = refused.unresolved[0], replacement = driver.getBridgeClient();
		assert.notEqual(replacement, originalClient); assert.equal(refused.developmentFrozen, true); assert.equal(refused.tasks[0].state, expected.taskState);
		assert.deepEqual(current, { ...original, state: expected.intentState }); assert.equal(current.terminal, null);
		await assertBlockedMcpExecution(driver, until);
		if (driver.mcpLossScenario === "receipt-mismatch") {
			const beforeRetry = await world(), rpcBeforeRetry = replacement.stats.requests;
			await driver.api("game", { action: "reconcile", args: { intentId: original.intentId } });
			await until(async () => { const value = await state(); return !value.busy && value.error === expected.error; }, "DURABLE_RECEIPT_ISOLATION");
			assert.deepEqual(await world(), beforeRetry); assert.equal(replacement.stats.requests, rpcBeforeRetry);
		}
		const preserved = await state(); await reloadGame(); await until(disabledExecution, "MISMATCH_STILL_DISABLED");
		assert.deepEqual((await state()).tasks, preserved.tasks); assert.deepEqual((await state()).unresolved, preserved.unresolved);
		// Close only this fixture's owned MCP transport; unresolved game authority remains frozen.
		await replacement.close(); assert.equal(replacement.exitConfirmed, true); assert.equal((await state()).developmentFrozen, true);
	} else {
		await assert.rejects(driver.api("game", { action: "reconcile", args: { intentId: original.intentId } }), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/);
		await assertBlockedMcpExecution(driver, until);
		await reloadGame(); await until(disabledExecution, "UNKNOWN_COMMIT_STILL_DISABLED");
		assert.deepEqual((await state()).unresolved, [original]); assert.equal((await state()).developmentFrozen, true); assert.equal(driver.getBridgeClient(), originalClient); assert.equal(driver.bridgeExitConfirmed(), true);
	}
	const after = await world(); assert.equal(after.commits, 1); assert.equal(after.prepares, 1); assert.equal(after.launches, expected.hasActionId ? 2 : 1); assert.equal(after.resultReads, expected.resultReads); assert.equal(requests(), 3); assert.equal(driver.getRuntimePid(), runtimePid);
	assert.deepEqual((await state()).tasks[0].details.usage, usage);
	await until(() => evaluate("document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent.includes('360 tokens') && document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent.includes('0.001155')"), "MCP_LOSS_USAGE_RETAINED");
	await writeFile(join(base, "mcp-loss.private.json"), JSON.stringify({ runId: driver.runId, scenario: driver.mcpLossScenario, original, before, after, state: await state() }), { flag: "wx" });
	const proofDirectory = driver.proofDirectory ?? join(driver.root, ".local/mcp-loss", driver.runId); await mkdir(proofDirectory, { recursive: true });
	await writeFile(join(proofDirectory, mcpLossProofName(driver.mcpLossScenario)), JSON.stringify({ runId: driver.runId, mcpLossScenario: driver.mcpLossScenario, syntheticOnly: true, originalMcpExitObserved: true, originalAcceptedActionReconciled: accepted, unknownCommitRemainsBlocked: !expected.hasActionId, mismatchRemainsBlocked: Boolean(expected.error), recoveryError: expected.error, repeatedIsolatedReconciliationMakesNoRequests: driver.mcpLossScenario === "receipt-mismatch", originalIdentityRetained: true, newExecutionDisabledDuringLoss: true, explicitOriginalReconciliationOnly: true, noModelOrCommitReplay: true, runtimeRetained: true, replacementMcpCount: expected.hasActionId ? 1 : 0, syntheticModelRequests: requests(), syntheticGameCommits: 1, syntheticPrepareCalls: 1, ownServerExitConfirmed: true, modelUsage: { normalizedTokens: usage.tokens.totalTokens, reportedResponses: usage.reportedResponses, estimatedUsd: usage.estimate.usd, retainedAcrossUiReloadAndMcpLoss: true }, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false }), { flag: "wx" });
}
