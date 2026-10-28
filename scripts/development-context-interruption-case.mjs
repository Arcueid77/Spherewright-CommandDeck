import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readContextInterruptionOriginal } from "../apps/desktop/development-context-interruption.mjs";
import { usageRecoveryState } from "./model-usage-recovery-state.mjs";
import { developmentWorkspaceState, developmentGitHash } from "./development-usage-case.mjs";
import { bundleExecutable } from "./desktop-bundle-files.mjs";

export function assertContextInterruptionRows(before, after) {
	assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.pi, before.pi); assert.deepEqual(after.vault, before.vault); assert.equal(after.world, null);
	const previous = before.workbench, actual = after.workbench;
	assert.equal(previous.tasks.length, 3); assert.equal(previous.invocations.length, 0); assert.equal(previous.changes.length, 0);
	assert.deepEqual(previous.tasks.map(task => task.state), ["succeeded", "succeeded", "running"]);
	const last = actual.tasks[2]; assert.equal(last.state, "interrupted"); assert.equal(last.error, "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY"); assert.equal(last.result, "null");
	assert.ok(Number.isFinite(Date.parse(last.finished_at)) && Date.parse(last.finished_at) >= Date.parse(previous.tasks[2].started_at));
	const tasks = [...previous.tasks.slice(0, 2), { ...previous.tasks[2], state: last.state, error: last.error, finished_at: last.finished_at }];
	assert.deepEqual(actual.events.slice(0, -1), previous.events); assert.equal(actual.events.length, previous.events.length + 1);
	const event = actual.events.at(-1); assert.equal(event.sequence, previous.events.at(-1).sequence + 1); assert.equal(event.task_id, last.id); assert.equal(event.kind, "task"); assert.deepEqual(JSON.parse(event.value), { state: "interrupted", error: last.error }); assert.ok(Number.isFinite(Date.parse(event.created_at)));
	assert.deepEqual(actual, { ...previous, tasks, events: actual.events });
}

export async function runContextInterruptionCase({ directory, caseId, caseProof, caseEnvironment, manifest, toolchain, workspaceBefore, launch }) {
	let before, original;
	await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=context-interrupt-record"], "record-", { forced: true, beforeExit: async (child, observe) => {
		const deadline = performance.now() + 45000;
		while (!original) {
			assert.ok(child.exitCode === null && child.signalCode === null && performance.now() < deadline, "CONTEXT_PENDING_REQUEST_NOT_OBSERVED");
			try { original = await readContextInterruptionOriginal({ root: directory, runId: caseId }); } catch (error) { if (error.code !== "ENOENT") throw error; }
			if (!original) await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.equal(original.supervisorPid, child.pid); assert.equal(original.sourceRevision, manifest.sourceRevision);
		const live = await observe();
		assert.ok(live.members.some(member => member.pid === child.pid && member.rootIndex === 1 && member.relativeImage.toLowerCase() === ("bundle/" + bundleExecutable).toLowerCase()), "EXACT_CONTEXT_PACKAGED_ROOT_NOT_OBSERVED");
		await writeFile(join(caseProof, "live-before-termination.private.json"), JSON.stringify(live), { flag: "wx" });
		before = await usageRecoveryState(directory, caseId, { role: "development" });
		assert.deepEqual(before.workbench.tasks.map(task => task.state), ["succeeded", "succeeded", "running"]); assert.equal(before.workbench.invocations.length, 0); assert.equal(before.workbench.changes.length, 0); assert.equal(before.pi.length, 5);
		for (const entry of before.pi) {
			assert.ok(entry.path.endsWith(".jsonl"));
			const entries = (await readFile(join(directory, "supervisor-profile/supervisor", entry.path), "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line));
			assert.ok(entries.length >= 2 && entries.every(entry => entry.type !== "compaction"), "UNFINISHED_COMPACTION_RESULT_INVENTED");
		}
		await writeFile(join(caseProof, "before-interruption.private.json"), JSON.stringify(before), { flag: "wx" });
		assert.equal(child.kill("SIGKILL"), true);
	} });
	assert.deepEqual(await usageRecoveryState(directory, caseId, { role: "development" }), before, "CONTEXT_TERMINATION_CHANGED_RUNNING_RECEIPT");
	assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore); const phases = [];
	let recovered;
	for (const phase of ["recover", "reopen"]) {
		await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=context-interrupt-" + phase], phase + "-");
		const after = await usageRecoveryState(directory, caseId, { role: "development" }); assertContextInterruptionRows(before, after);
		if (recovered) assert.deepEqual(after, recovered, "CONTEXT_SECOND_REOPEN_CHANGED_ORIGINAL_ROWS"); else recovered = after;
		const proof = JSON.parse(await readFile(join(directory, "development-context-interruption-" + phase + "-proof.json"), "utf8"));
		assert.equal(proof.runId, caseId); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.expectedSha256, original.sha256);
		for (const key of ["packaged", "syntheticOnly", "originalCompletedTasksAndContextsRetained", "unfinishedCompactionInterrupted", "unfinishedUsageRemainsUnknown", "noCompactionOrPromptReplayed", "uiReloadDoesNotReplay", "newExecutionRejected", "noMcpSelected", "noProbeAllocated", "readOnlyWorkspace", "wholeApplicationRestartVerified"]) assert.equal(proof[key], true);
		for (const key of ["syntheticModelRequests", "actualToolCalls", "gameCalls", "realModelRequests"]) assert.equal(proof[key], 0);
		assert.equal(proof.totals.knownRequests, 3); assert.equal(proof.totals.reportedResponses, 2); assert.equal(proof.totals.missingResponses, 1); assert.equal(proof.totals.unpricedTasks, 1);
		if (phases.length) { assert.deepEqual(proof.totals, phases[0].totals); assert.equal(proof.recoveredStateSha256, phases[0].recoveredStateSha256); }
		await writeFile(join(caseProof, phase + "-application-proof.json"), JSON.stringify(proof), { flag: "wx" });
		await writeFile(join(caseProof, phase + "-rows.private.json"), JSON.stringify(after), { flag: "wx" }); phases.push(proof);
	}
	assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore); assert.equal(await developmentGitHash(toolchain.git), toolchain.gitSha256);
	return { developmentUsageScenario: "compaction-interrupted-recover-and-reopen", applicationRuns: 3, exactSpawnHandleTerminatedAfterIndependentObservation: true, noPackagedChildrenRemain: true, originalCompletedRowsAndAllPiPreserved: true, onlyPendingTaskAndRecoveryEventChanged: true, noCompactionResultInvented: true, unfinishedUsageRemainsUnknown: true, sourceFilesUnchanged: true, externalGitRequired: true, gitVersion: toolchain.gitVersion, gitSha256: toolchain.gitSha256, syntheticModelRequests: 3, actualToolCalls: 0, gameCalls: 0, realModelRequests: 0, phases };
}
