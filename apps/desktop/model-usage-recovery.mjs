import assert from "node:assert/strict";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { modelUsageSnapshot } from "./model-usage.mjs";
import { verifyUsageSummary } from "./usage-summary-smoke.mjs";

export const modelUsageRecoveryFile = "model-usage-recovery.private.json";
export const modelUsageRecoveryHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Comparison data in the existing isolated portable mode. It grants no execution.
export async function readModelUsageRecovery(context) {
	const file = join(context.root, modelUsageRecoveryFile); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 131072, "MODEL_USAGE_RECOVERY_CASE_INVALID");
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), ["expected", "kind", "runId", "scenario", "sha256", "version"]);
	assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-model-usage-recovery"); assert.equal(value.runId, context.runId);
	assert.ok(["accepted", "lost-ack"].includes(value.scenario));
	assert.deepEqual(Object.keys(value.expected).sort(), ["events", "tasks"]); assert.ok(Array.isArray(value.expected.tasks) && value.expected.tasks.length === 1); assert.ok(Array.isArray(value.expected.events) && value.expected.events.length <= 100);
	const task = value.expected.tasks[0], accepted = value.scenario === "accepted";
	assert.match(task.id, /^[a-f0-9-]{36}$/); assert.equal(task.intent.taskId, task.id);
	assert.equal(task.scope.techId, 100); assert.equal(task.details.model, "fixture"); assert.equal(task.details.mode, "assist");
	assert.equal(task.state, accepted ? "completed" : "blocked"); assert.equal(task.intent.state, accepted ? "completed" : "unknown");
	assert.equal(task.intent.actionId, accepted ? "synthetic-action" : null);
	const usage = modelUsageSnapshot(task.details.usage);
	assert.equal(usage.reportedResponses, 3); assert.equal(usage.requests, 3); assert.equal(usage.tokens.totalTokens, 360); assert.equal(usage.estimate.status, "estimated"); assert.ok(Math.abs(usage.estimate.usd - 0.001155) < 1e-12);
	assert.equal(value.sha256, modelUsageRecoveryHash(value.expected)); return value;
}

export async function runModelUsageRecovery(driver, value, manifest) {
	const { api, testCommand } = driver, runtimePid = driver.getRuntimePid(), accepted = value.scenario === "accepted";
	async function compare() {
		const game = await api("game", { action: "snapshot" }), work = await api("workbench", { action: "state" }), bridge = await api("bridge", { action: "snapshot" });
		assert.deepEqual({ tasks: game.tasks, events: game.events }, value.expected, "MODEL_USAGE_TASK_CHANGED_AFTER_RESTART");
		assert.equal(game.busy, false); assert.equal(game.syntheticOnly, true); assert.equal(game.developmentFrozen, !accepted); assert.equal(game.unresolved.length, accepted ? 0 : 1);
		if (!accepted) { assert.equal(game.phase, "blocked"); assert.equal(game.error, "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES"); assert.equal(game.unresolved[0].actionId, null); }
		assert.deepEqual(work.roots, []); assert.deepEqual(work.tasks, []); assert.equal(work.activeTask, null); assert.equal(work.executionBlocked, !accepted);
		assert.equal(bridge.selected, null); assert.equal(bridge.observation, null); assert.equal(driver.getProbeSequence(), 0); assert.equal(driver.getRuntimePid(), runtimePid);
	}
	async function showUsage() {
		const until = performance.now() + 10000; let opened = false;
		while (true) {
			if (!opened) opened = await testCommand("evaluate", { source: "(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()" });
			if (opened && await testCommand("evaluate", { source: "(()=>{const text=document.querySelector('.game-tasks-panel [aria-label=模型用量与费用]')?.textContent;return Boolean(text?.includes('360 tokens')&&text?.includes('0.001155'))})()" })) return;
			assert.ok(performance.now() < until, "MODEL_USAGE_RESTART_UI_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50));
		}
	}
	await compare(); await showUsage();
	const denied = await testCommand("evaluate", { source: "(async()=>{let count=0;for(const call of [()=>window.deck.game('start',{}),()=>window.deck.game('reconcile',{}),()=>window.deck.manageProfiles('save',{}),()=>window.deck.workbench('agent',{}),()=>window.deck.workbench('check',{}),()=>window.deck.probe({mode:'live'})])try{await call()}catch{count++}return count})()" }); assert.equal(denied, 6);
	await testCommand("reload"); await showUsage(); await compare();
	const summary = manifest.modelUsageSummary === 1 ? await verifyUsageSummary(driver, { domain: "game", usage: value.expected.tasks[0].details.usage, context: value.expected.tasks[0].details.context }) : null;
	const proof = { version: 1, runId: driver.context.runId, scenario: value.scenario, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, expectedSha256: value.sha256, packaged: true, syntheticOnly: true, wholeApplicationRestartVerified: true, originalTaskAndUsageRetained: true, usageVisibleAfterRestartAndUiReload: true, unknownCommitRemainsBlocked: !accepted, modelUsage: { normalizedTokens: 360, reportedResponses: 3, estimatedUsd: value.expected.tasks[0].details.usage.estimate.usd }, noMcpSelected: true, noProbeAllocated: true, newExecutionRejected: true, gameCalls: 0, realModelRequests: 0, physicalInputVerified: false, fullRecoveryMatrixVerified: false };
	if (summary) proof.summary = summary;
	await writeFile(join(driver.context.root, "model-usage-recovery-proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
	return proof;
}
