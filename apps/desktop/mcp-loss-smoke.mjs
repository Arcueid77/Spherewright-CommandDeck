import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mcpLossCase } from "./mcp-loss-case.mjs";
import { syntheticCommitReceiptReleaseFile } from "./synthetic-scope.mjs";

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
	if (mcpLossCase(driver.mcpLossScenario).hasIntent === false) return runBeforeIntentLoss(driver, { evaluate, state, until, requests, base });
	const expected = mcpLossCase(driver.mcpLossScenario), accepted = expected.taskState === "completed", commits = expected.commits ?? 1, originalClient = driver.getBridgeClient(), runtimePid = driver.getRuntimePid(), taskId = (await state()).currentTaskId;
	let duplicateReplies = 0;
	const usage = (await state()).tasks[0].details.usage;
	const world = async () => { const value = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8")); assert.equal(value.runId, driver.runId); return value; };
	async function reloadGame() {
		await driver.testCommand("reload");
		await until(() => evaluate("(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "MCP_RECOVERY_LAYOUT_READY");
		await until(() => evaluate("Boolean(document.querySelector('.game-tasks-panel'))"), "MCP_RECOVERY_PANEL");
	}
	const disabledExecution = () => evaluate("(()=>{const panel=document.querySelector('.game-tasks-panel');return ['开始分析','核对并确认入队'].every(label=>[...panel.querySelectorAll('button')].some(button=>button.textContent===label&&button.matches(':disabled')))})()");
	await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate(`window.deck.confirmResearch(${JSON.stringify(taskId)})`);
	const buffered = expected.commitTimeout ? await bufferCommitReceipt(driver, { client: originalClient, state, world, until, base }) : null;
	await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.unresolved.length === 1 && originalClient.exitConfirmed; }, "ORIGINAL_MCP_EXITED", expected.commitTimeout ? originalClient.timeoutMs + 5000 : 12000);
	const timeoutReceipt = buffered ? await verifyTimedOutCommitReceipt(originalClient, buffered, { state, until }) : null;
	const blocked = await state(), original = structuredClone(blocked.unresolved[0]), before = await world();
	assert.equal(original.state, expected.hasActionId ? "accepted" : "unknown"); assert.equal(original.actionId, expected.hasActionId ? "synthetic-action" : null);
	assert.equal(blocked.developmentFrozen, true); assert.equal(before.commits, commits); assert.equal(before.commitRequests, 1); assert.equal(before.lastCommitRequestKey, original.idempotencyKey); assert.equal(before.prepares, 1); assert.equal(before.launches, 1); assert.equal(requests(), 3);
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
		duplicateReplies = driver.getBridgeClient().stats.duplicateReplies;
		assert.equal(duplicateReplies, expected.duplicateReplies ?? 0);
		await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
	} else if (expected.error) {
		await evaluate("[...document.querySelectorAll('.game-task-receipt button')].find(button=>button.textContent==='核销原动作').click()");
		await until(async () => { const value = await state(); return !value.busy && value.phase === "blocked" && value.error === expected.error; }, "MCP_RECOVERY_MISMATCH_BLOCKED");
		const refused = await state(), current = refused.unresolved[0], replacement = driver.getBridgeClient();
		assert.notEqual(replacement, originalClient); assert.equal(refused.developmentFrozen, true); assert.equal(refused.tasks[0].state, expected.taskState);
		assert.deepEqual(current, { ...original, state: expected.intentState }); assert.equal(current.terminal, null);
		await assertBlockedMcpExecution(driver, until);
		if (expected.auditReason) {
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
	const after = await world(); assert.equal(after.commits, commits); assert.equal(after.commitRequests, 1); assert.equal(after.lastCommitRequestKey, original.idempotencyKey); assert.equal(after.prepares, 1); assert.equal(after.launches, expected.hasActionId ? 2 : 1); assert.equal(after.resultReads, expected.resultReads); assert.equal(requests(), 3); assert.equal(driver.getRuntimePid(), runtimePid);
	assert.equal(after.duplicateRepliesSent ?? 0, duplicateReplies);
	assert.equal(after.duplicateDelivery ?? null, expected.duplicateDelivery ?? null);
	assert.deepEqual(after.nativeOutcome ?? null, expected.nativeOutcome ?? null);
	assert.deepEqual((await state()).tasks[0].details.usage, usage);
	await until(() => evaluate("document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent.includes('360 tokens') && document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent.includes('0.001155')"), "MCP_LOSS_USAGE_RETAINED");
	await writeFile(join(base, "mcp-loss.private.json"), JSON.stringify({ runId: driver.runId, scenario: driver.mcpLossScenario, original, before, after, state: await state() }), { flag: "wx" });
	const proofDirectory = driver.proofDirectory ?? join(driver.root, ".local/mcp-loss", driver.runId); await mkdir(proofDirectory, { recursive: true });
	await writeFile(join(proofDirectory, mcpLossProofName(driver.mcpLossScenario)), JSON.stringify({
		runId: driver.runId, mcpLossScenario: driver.mcpLossScenario, syntheticOnly: true, originalMcpExitObserved: true, originalAcceptedActionReconciled: accepted,
		unknownCommitRemainsBlocked: !expected.hasActionId, mismatchRemainsBlocked: Boolean(expected.error && !expected.nativeOutcome),
		nativeOutcomeRemainsBlocked: Boolean(expected.nativeOutcome), nativeOutcome: after.nativeOutcome ?? null, recoveryError: expected.error,
		repeatedIsolatedReconciliationMakesNoRequests: Boolean(expected.auditReason), originalIdentityRetained: true, newExecutionDisabledDuringLoss: true,
		explicitOriginalReconciliationOnly: true, noModelOrCommitReplay: true, runtimeRetained: true, replacementMcpCount: expected.hasActionId ? 1 : 0,
		syntheticModelRequests: requests(), syntheticGameCommits: commits, syntheticCommitRequests: 1, syntheticPrepareCalls: 1, duplicateRepliesIgnored: duplicateReplies, duplicateDelivery: after.duplicateDelivery ?? null, ownServerExitConfirmed: true,
		modelUsage: { normalizedTokens: usage.tokens.totalTokens, reportedResponses: usage.reportedResponses, estimatedUsd: usage.estimate.usd, retainedAcrossUiReloadAndMcpLoss: true },
		gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false,
		timeoutReceipt,
	}), { flag: "wx" });
}

async function bufferCommitReceipt(driver, { client, state, world, until, base }) {
	await until(async () => (await world()).commitReceiptWaiting === true, "COMMIT_RECEIPT_WAITING");
	const snapshot = await state(), original = structuredClone(snapshot.unresolved[0]);
	assert.equal(snapshot.phase, "confirming"); assert.equal(snapshot.busy, true); assert.equal(original.state, "recorded"); assert.equal(original.actionId, null); assert.equal(original.acceptance, null);
	const stream = client.child.stdout, delivered = [], performanceBefore = client.requestPerformance(), requests = client.stats.requests;
	assert.equal(performanceBefore.pending, 1); assert.equal(client.closed, false);
	stream.pause(); stream.on("data", bytes => delivered.push({ closed: client.closed, reason: client.requestPerformance().transportStopReason, text: bytes.toString() }));
	await writeFile(join(base, syntheticCommitReceiptReleaseFile(driver.runId)), "", { flag: "wx" });
	await until(async () => (await world()).commitReceiptWritten === true && stream.readableLength > 0, "ACCEPTED_REPLY_BUFFERED");
	assert.equal(client.closed, false); assert.equal((await state()).unresolved[0].state, "recorded");
	return { original, stream, delivered, performanceBefore, requests };
}

async function verifyTimedOutCommitReceipt(client, buffered, { state, until }) {
	assert.equal(client.closed, true); assert.equal(client.requestPerformance().transportStopReason, "MCP_REQUEST_TIMEOUT"); buffered.stream.resume();
	await until(() => buffered.delivered.map(part => part.text).join("").endsWith("\n"), "POST_TIMEOUT_ACCEPTED_REPLY_DELIVERED");
	assert.ok(buffered.delivered.every(part => part.closed && part.reason === "MCP_REQUEST_TIMEOUT"));
	const replies = buffered.delivered.map(part => part.text).join("").trim().split(/\r?\n/).map(line => JSON.parse(line));
	assert.equal(replies.length, 1); assert.equal(replies[0].id, "deck-read:" + buffered.requests); assert.equal(replies[0].result.structuredContent.success, true);
	const receipt = replies[0].result.structuredContent.result; assert.equal(receipt.accepted, true); assert.equal(receipt.idempotencyKey, buffered.original.idempotencyKey); assert.equal(receipt.actionId, "synthetic-action");
	const current = (await state()).unresolved[0]; assert.deepEqual(current, { ...buffered.original, state: "unknown" }); assert.equal(current.acceptance, null); assert.equal(current.terminal, null);
	const after = client.requestPerformance(); assert.equal(after.byKind.tool.responses, buffered.performanceBefore.byKind.tool.responses); assert.equal(after.byKind.tool.aborted, buffered.performanceBefore.byKind.tool.aborted + 1); assert.equal(after.pending, 0); assert.equal(client.stats.requests, buffered.requests);
	return { transportStopReason: after.transportStopReason, acceptedReplyBufferedBeforeTimeout: true, acceptedReplyDeliveredAfterClosure: true, originalIntentRemainsUnknown: true, acceptedReplyMatchesOriginalRequest: true, lateReplyDoesNotCompleteRequest: true, newTransportRequests: 0 };
}

async function runBeforeIntentLoss(driver, { evaluate, state, until, requests, base }) {
	const expected = mcpLossCase(driver.mcpLossScenario), client = driver.getBridgeClient(), runtimePid = driver.getRuntimePid(), initial = await state(), taskId = initial.currentTaskId, usage = initial.tasks[0].details.usage;
	const world = async () => JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8"));
	assert.equal(initial.phase, "awaiting_approval"); assert.equal(initial.tasks[0].intent, null); assert.deepEqual(initial.unresolved, []);
	const before = await world(); assert.equal(before.runId, driver.runId); assert.equal(before.prepares, 1); assert.equal(before.commits, 0); assert.equal(before.commitRequests ?? 0, 0);
	if (expected.beforeIntent === "confirmation") {
		await driver.testCommand("hold-game-confirmation");
		await evaluate("(()=>{window.__mcpBeforeIntentAnswer=null;void window.deck.confirmResearch(" + JSON.stringify(taskId) + ").then(()=>window.__mcpBeforeIntentAnswer={ok:true},()=>window.__mcpBeforeIntentAnswer={ok:false});return true})()");
		await until(() => driver.testCommand("held-game-confirmation-state"), "PREINTENT_CONFIRMATION_HELD");
		await until(() => evaluate("document.querySelector('header').inert && document.querySelector('.workspace').inert"), "PREINTENT_CONFIRMATION_OVERLAY");
		assert.equal((await state()).phase, "awaiting_approval"); assert.equal((await state()).tasks[0].intent, null);
	}
	const rpcBeforeLoss = client.stats.requests;
	assert.equal(client.child.kill(), true); await until(() => client.exitConfirmed && client.closed, "PREINTENT_ORIGINAL_EXITED");
	if (expected.beforeIntent === "confirmation") {
		await driver.testCommand("answer-held-game-confirmation", { response: 1 });
		await until(() => evaluate("window.__mcpBeforeIntentAnswer?.ok===true"), "PREINTENT_CONFIRMATION_RETURNED");
	} else {
		await driver.testCommand("answer-game-confirmation", { response: 1 });
		await evaluate("window.deck.confirmResearch(" + JSON.stringify(taskId) + ")");
	}
	await until(async () => { const value = await state(); return !value.busy && value.phase === "failed"; }, "PREINTENT_REVALIDATION_REFUSED");
	const refused = await state(); assert.equal(refused.error, "MCP_READ_NOT_SUPPORTED"); assert.equal(refused.tasks[0].intent, null); assert.deepEqual(refused.unresolved, []); assert.equal(refused.developmentFrozen, false);
	assert.equal(client.stats.requests, rpcBeforeLoss); assert.deepEqual(await world(), before);
	const rejected = await evaluate("(async()=>{try{await window.deck.confirmResearch(" + JSON.stringify(taskId) + ");return false}catch(error){return String(error).includes('GAME_CONFIRMATION_UNAVAILABLE')}})()"); assert.equal(rejected, true);
	await driver.api("game", { action: "stop" }); await until(async () => { const value = await state(); return !value.busy && value.phase === "cancelled"; }, "PREINTENT_TASK_STOPPED");
	const stopped = await state(); assert.equal(stopped.tasks[0].state, "cancelled"); assert.equal(stopped.tasks[0].intent, null); assert.equal(stopped.developmentFrozen, false);
	await driver.testCommand("reload");
	await until(() => evaluate("(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "PREINTENT_RELOAD_LAYOUT");
	await until(() => evaluate("document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent.includes('360 tokens')"), "PREINTENT_RELOAD_USAGE");
	assert.deepEqual((await state()).tasks, stopped.tasks); assert.deepEqual((await state()).events, stopped.events); assert.equal(driver.getBridgeClient(), client); assert.equal(driver.getRuntimePid(), runtimePid); assert.equal(requests(), 3); assert.equal(client.stats.requests, rpcBeforeLoss);
	const after = await world(); assert.deepEqual(after, before);
	await writeFile(join(base, "mcp-loss.private.json"), JSON.stringify({ runId: driver.runId, scenario: driver.mcpLossScenario, original: null, originalTask: initial.tasks[0], before, after, state: await state() }), { flag: "wx" });
	const proofDirectory = driver.proofDirectory ?? join(driver.root, ".local/mcp-loss", driver.runId); await mkdir(proofDirectory, { recursive: true });
	await writeFile(join(proofDirectory, mcpLossProofName(driver.mcpLossScenario)), JSON.stringify({ runId: driver.runId, mcpLossScenario: driver.mcpLossScenario, syntheticOnly: true, originalMcpExitObserved: true, originalAcceptedActionReconciled: false, unknownCommitRemainsBlocked: false, mismatchRemainsBlocked: false, nativeOutcomeRemainsBlocked: false, nativeOutcome: null, recoveryError: null, repeatedIsolatedReconciliationMakesNoRequests: false, originalIdentityRetained: true, newExecutionDisabledDuringLoss: false, explicitOriginalReconciliationOnly: false, noModelOrCommitReplay: true, runtimeRetained: true, replacementMcpCount: 0, syntheticModelRequests: requests(), syntheticGameCommits: 0, syntheticCommitRequests: 0, syntheticPrepareCalls: 1, duplicateRepliesIgnored: 0, duplicateDelivery: null, ownServerExitConfirmed: true, noIntentAllocated: true, approvalStage: expected.beforeIntent, heldDialogResponseMocked: expected.beforeIntent === "confirmation", confirmationAfterLossRejected: true, preIntentError: refused.error, stoppedTaskRetained: true, modelUsage: { normalizedTokens: usage.tokens.totalTokens, reportedResponses: usage.reportedResponses, estimatedUsd: usage.estimate.usd, retainedAcrossUiReloadAndMcpLoss: true }, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false, fullRecoveryMatrixVerified: false }), { flag: "wx" });
}
