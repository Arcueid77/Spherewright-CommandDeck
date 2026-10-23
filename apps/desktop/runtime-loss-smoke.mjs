import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function runRuntimeLossSmoke(driver) {
	const proofDirectory = driver.proofDirectory ?? join(driver.root, ".local"); await mkdir(proofDirectory, { recursive: true });
	const original = await driver.api("probe", { mode: "offline" }), sequence = driver.getProbeSequence();
	assert.equal(sequence, 1);
	const runtime = await driver.stopRuntimeForSmoke(); assert.equal(runtime.exitObserved, true);
	await assert.rejects(driver.api("probe", { mode: "offline" }));
	const retained = (await driver.api("snapshot")).lastProbeResult;
	await writeFile(join(proofDirectory, "runtime-loss-idle.private.json"), JSON.stringify({ runId: driver.runId, runtimeExitObserved: true, probeSequence: driver.getProbeSequence(), previousResultRetained: JSON.stringify(retained) === JSON.stringify(original) }));
	assert.equal(driver.getProbeSequence(), sequence, "RUNTIME_EXIT_ALLOCATED_NEW_PROBE"); assert.deepEqual(retained, original, "RUNTIME_EXIT_CLEARED_PREVIOUS_RESULT");
	await driver.testCommand("reload"); assert.deepEqual((await driver.api("snapshot")).lastProbeResult, original);
	assert.equal(driver.getProbeSequence(), sequence);
	const uiDeadline = performance.now() + 10000;
	while (!await driver.testCommand("evaluate", { source: "(()=>{const panel=document.querySelector('.agent');return Boolean(panel?.textContent.includes('运行时已停止')&&[...panel.querySelectorAll('button')].length>=2&&[...panel.querySelectorAll('button')].every(button=>button.disabled))})()" })) { assert.ok(performance.now() < uiDeadline, "RUNTIME_LOSS_PROBE_CONTROLS_NOT_DISABLED"); await new Promise(resolve => setTimeout(resolve, 50)); }
	await writeFile(join(proofDirectory, "desktop-smoke-runtime-loss.application.private.json"), JSON.stringify({ runId: driver.runId, syntheticOnly: true, runtimeExitObserved: true, previousResultRetained: true, noProbeAllocated: true, noRuntimeRestart: true, syntheticProbeRequests: 2, gameCalls: 0, realModelRequests: 0 }));
}

export async function runGameRuntimeLossSmoke(driver, { evaluate, state, until, requests, base }) {
	const accepted = driver.runtimeScenario ? driver.runtimeScenario === "accepted" : process.argv.includes("--smoke-runtime-accepted"), planning = driver.runtimeScenario ? driver.runtimeScenario === "planning" : process.argv.includes("--smoke-runtime-planning"), taskId = (await state()).currentTaskId;
	let original = null;
	if (accepted) {
		await driver.testCommand("answer-game-confirmation", { response: 1 }); await evaluate(`window.deck.confirmResearch(${JSON.stringify(taskId)})`);
		await until(async () => { const value = await state(); return !value.busy && value.phase === "reconciling" && value.unresolved.length === 1; }, "ACCEPTED_PENDING");
		original = structuredClone((await state()).unresolved[0]); assert.equal(await driver.getSyntheticCommitCount(), 1);
	} else if (!planning) {
		await driver.testCommand("hold-game-confirmation");
		await evaluate(`(()=>{window.__runtimeLossAnswer=null;void window.deck.confirmResearch(${JSON.stringify(taskId)}).then(()=>window.__runtimeLossAnswer={ok:true},()=>window.__runtimeLossAnswer={ok:false});return true})()`);
		await until(() => driver.testCommand("held-game-confirmation-state"), "CONFIRMATION_HELD");
		assert.equal(await driver.getSyntheticCommitCount(), 0); assert.equal((await state()).tasks[0].intent, null);
	}
	const runtime = await driver.stopRuntimeForSmoke(); assert.equal(runtime.exitObserved, true);
	if (accepted) {
		await driver.api("game", { action: "reconcile", args: { intentId: original.intentId } });
		await until(async () => { const value = await state(); return !value.busy && value.phase === "completed"; }, "ORIGINAL_ACTION_AFTER_RUNTIME_EXIT");
	} else if (planning) {
		await until(async () => !(await state()).busy, "IN_FLIGHT_PLANNER_STOPPED");
	} else {
		await driver.testCommand("answer-held-game-confirmation", { response: 1 });
		await until(async () => Boolean(await evaluate("window.__runtimeLossAnswer")) && !(await state()).busy, "LATE_CONFIRMATION_SETTLED");
	}
	const value = await state(), commits = await driver.getSyntheticCommitCount(), answer = accepted || planning ? null : await evaluate("window.__runtimeLossAnswer");
	await writeFile(join(base, "runtime-loss.private.json"), JSON.stringify({ runId: driver.runId, accepted, planning, runtimeExitObserved: true, syntheticModelRequests: requests(), syntheticGameCommits: commits, confirmationAnswer: answer, state: value }));
	assert.equal(commits, accepted ? 1 : 0, "RUNTIME_EXIT_ALLOWED_NEW_GAME_COMMIT");
	assert.equal(value.runtimeAvailable, false); assert.equal(value.developmentFrozen, true); assert.equal(value.unresolved.length, 0); assert.equal(requests(), planning ? 1 : 3);
	if (accepted) { assert.equal(value.tasks[0].intent.actionId, original.actionId); assert.equal(value.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.equal(value.tasks[0].intent.state, "completed"); }
	else { if (!planning) assert.equal(answer.ok, false); assert.equal(value.tasks[0].intent, null); }
	assert.equal(await evaluate(`window.deck.confirmResearch(${JSON.stringify(taskId)}).then(()=>false,()=>true)`), true, "RUNTIME_EXIT_ALLOWED_NEW_CONFIRMATION");
	for (const action of ["start", "catalog", "reprepare"]) await assert.rejects(driver.api("game", { action }), /GAME_RUNTIME_UNAVAILABLE/);
	await assert.rejects(driver.api("probe", { mode: "offline" })); assert.equal(driver.getProbeSequence(), 0);
	await driver.testCommand("reload");
	await until(() => evaluate("(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()"), "RELOADED_LAYOUT_READY");
	await until(async () => (await evaluate("document.body.innerText")).includes("运行时已停止"), "RUNTIME_LOSS_VISIBLE_AFTER_RELOAD");
	assert.equal(await evaluate("(()=>{const panel=document.querySelector('.game-tasks-panel');return ['开始分析','核对并确认入队'].every(label=>[...panel.querySelectorAll('button')].some(button=>button.textContent===label&&button.disabled))})()"), true, "RUNTIME_LOSS_NEW_EXECUTION_CONTROLS_ENABLED");
	assert.deepEqual((await state()).tasks, value.tasks); assert.equal(await driver.getSyntheticCommitCount(), commits); assert.equal(requests(), planning ? 1 : 3);
	await driver.api("game", { action: "stop" }); await until(async () => !(await state()).busy, "STOP_AFTER_RUNTIME_EXIT");
	await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
	const file = accepted ? "desktop-smoke-game-runtime-accepted" : planning ? "desktop-smoke-game-runtime-planning" : "desktop-smoke-game-runtime-loss";
	await writeFile(join(driver.proofDirectory ?? join(driver.root, ".local"), file + ".application.private.json"), JSON.stringify({ runId: driver.runId, syntheticOnly: true, runtimeExitObserved: true, confirmationInvalidated: !accepted && !planning, inFlightPlannerEnded: planning, originalAcceptedActionReconciled: accepted, noNewCommitAfterRuntimeExit: true, developmentRemainsFrozen: true, newExecutionDisabled: true, noRuntimeOrModelReplay: true, syntheticModelRequests: requests(), syntheticGameCommits: commits, ownServerExitConfirmed: true, gameCalls: 0, realModelRequests: 0 }));
}

export function runtimeLossProofName(scenario) {
	if (!["idle", "confirmation", "accepted", "planning"].includes(scenario)) throw new Error("UNKNOWN_RUNTIME_LOSS_SCENARIO");
	return (scenario === "idle" ? "desktop-smoke-runtime-loss" : scenario === "confirmation" ? "desktop-smoke-game-runtime-loss" : "desktop-smoke-game-runtime-" + scenario) + ".application.private.json";
}
