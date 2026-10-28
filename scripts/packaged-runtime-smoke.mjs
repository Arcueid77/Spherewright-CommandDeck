import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, basename, join, resolve, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { portableRuntimeScenarios, portableMcpScenarios } from "../apps/desktop/portable-mode.mjs";
import { mcpLossCase, packagedMcpLossVersion } from "../apps/desktop/mcp-loss-case.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { modelUsageRecoveryFile, modelUsageRecoveryHash } from "../apps/desktop/model-usage-recovery.mjs";
import { usageRecoveryState } from "./model-usage-recovery-state.mjs";
import { prepareDevelopmentUsageCase, developmentWorkspaceState, developmentGitHash } from "./development-usage-case.mjs";
import { readDevelopmentUsageOriginal } from "../apps/desktop/development-usage-smoke.mjs";
import { readDevelopmentContextOriginal } from "../apps/desktop/development-context-recovery.mjs";
import { modelUsageSnapshot } from "../apps/desktop/model-usage.mjs";
import { runContextInterruptionCase } from "./development-context-interruption-case.mjs";
import { readProviderContextOriginal } from "../apps/desktop/development-provider-context-smoke.mjs";
import { providerContextFailures, providerContextPrefix, providerContextSteps } from "../apps/desktop/development-provider-context-case.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
const contextInterruption = args[0] === "--development-context-interruption";
const contextFailures = args[0] === "--development-context-failures";
const providerContext = contextFailures || args[0] === "--development-context-providers";
const developmentContext = providerContext || contextInterruption || args[0] === "--development-context"; if (developmentContext) args.shift();
const developmentUsage = developmentContext || args[0] === "--development-usage"; if (developmentUsage && !developmentContext) args.shift();
const mcpLoss = args[0] === "--mcp-loss"; if (mcpLoss) args.shift();
if (developmentUsage && mcpLoss) throw new Error("PACKAGED_USAGE_MODE_CONFLICT");
const scenarios = contextFailures ? providerContextFailures : developmentUsage ? ["development"] : mcpLoss ? portableMcpScenarios : portableRuntimeScenarios, proofFolder = contextFailures ? "packaged-development-context-failures" : providerContext ? "packaged-development-context-providers" : contextInterruption ? "packaged-development-context-interruption" : developmentContext ? "packaged-development-context" : developmentUsage ? "packaged-development-usage" : mcpLoss ? "packaged-mcp-loss" : "packaged-runtime-loss", proofKind = contextFailures ? "packagedDevelopmentContextFailuresSmoke" : providerContext ? "packagedDevelopmentProviderContextSmoke" : contextInterruption ? "packagedDevelopmentContextInterruptionSmoke" : developmentContext ? "packagedDevelopmentContextSmoke" : developmentUsage ? "packagedDevelopmentUsageSmoke" : mcpLoss ? "packagedMcpLossSmoke" : "packagedRuntimeLossSmoke";
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_RUNTIME_FAULT_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1); assert.equal(manifest[developmentUsage ? "portableDevelopmentUsage" : mcpLoss ? "portableMcpFaults" : "portableRuntimeFaults"], mcpLoss ? packagedMcpLossVersion : 1, "PACKAGED_FAULT_MODE_UNSUPPORTED_REBUILD_REQUIRED");
if (developmentUsage) assert.equal(manifest.modelUsageSummary, 1, "PACKAGED_USAGE_SUMMARY_REBUILD_REQUIRED");
if (developmentUsage && !developmentContext) assert.equal(manifest.portableUsageUiRecovery, 1, "PACKAGED_USAGE_UI_RECOVERY_REBUILD_REQUIRED");
if (developmentContext) { assert.equal(manifest.portableDevelopmentContext, 1, "PACKAGED_CONTEXT_REBUILD_REQUIRED"); assert.equal(manifest.developmentContextManagement, 1); }
if (contextInterruption) assert.equal(manifest.portableDevelopmentContextInterruption, 1, "PACKAGED_CONTEXT_INTERRUPTION_REBUILD_REQUIRED");
if (providerContext) assert.equal(manifest.portableDevelopmentProviderContext, 1, "PACKAGED_PROVIDER_CONTEXT_REBUILD_REQUIRED");
if (contextFailures) assert.equal(manifest.portableDevelopmentContextFailures, 1, "PACKAGED_CONTEXT_FAILURES_REBUILD_REQUIRED");
assert.ok(manifest.files.some(file => file.path === "resources/app/test/fixtures/research-mcp-server.mjs"));
const proofRoot = join(root, ".local", proofFolder, runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const path = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(path); return path; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
async function launch(directory, environment, evidence, argv, prefix = "", { beforeExit, forced = false } = {}) {
	const child = spawn(join(copy, bundleExecutable), argv, { cwd: directory, env: environment, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	const exited = once(child, "exit"); exited.catch(() => {});
	const observe = () => observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env: environment });
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
	let code, signal, phaseError;
	try { if (beforeExit) await beforeExit(child, observe); [code, signal] = await exited; }
	catch (error) { phaseError = error; if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); [code, signal] = await exited; }
	finally { clearTimeout(timer); }
	await writeFile(join(evidence, prefix + "exit.private.json"), JSON.stringify({ code, signal, timedOut, forced, output, error: phaseError?.message }), { flag: "wx" });
	let remaining; const until = performance.now() + 25000;
	do {
		const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
		const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env: environment, timeoutMs: Math.min(20000, budget) });
		await writeFile(join(evidence, prefix + "process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
		if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < until);
	assert.equal(remaining, 0); if (phaseError) throw phaseError; assert.equal(timedOut, false);
	if (forced) assert.ok(code !== 0 || signal, "EXPECTED_CONTEXT_INTERRUPTION_NOT_OBSERVED"); else assert.equal(code, 0, signal ?? output);
}
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const scenario of scenarios) {
		const directory = await temporary(), caseId = randomUUID(), caseProof = join(proofRoot, scenario); await mkdir(caseProof);
		await writeFile(join(caseProof, "context.private.json"), JSON.stringify({ runId, caseId, scenario, directory, copy, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
		const caseEnvironment = mcpLoss ? syntheticMcpEnvironment(env) : env;
		if (developmentUsage) {
			const toolchain = await prepareDevelopmentUsageCase(directory), workspaceBefore = await developmentWorkspaceState(directory);
			caseEnvironment.PATH = [toolchain.gitDirectory, join(process.env.SystemRoot, "System32")].join(delimiter);
			if (contextInterruption) { cases.push(await runContextInterruptionCase({ directory, caseId, caseProof, caseEnvironment, manifest, toolchain, workspaceBefore, launch })); continue; }
			const summaryFailure = contextFailures ? scenario : null, phasePrefix = providerContext ? providerContextPrefix(summaryFailure) : developmentContext ? "context-" : "";
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=" + phasePrefix + "record"], "record-");
			const original = await (providerContext ? readProviderContextOriginal : developmentContext ? readDevelopmentContextOriginal : readDevelopmentUsageOriginal)({ root: directory, runId: caseId }, { summaryFailure }), before = await usageRecoveryState(directory, caseId, { role: "development" });
			if (contextFailures) {
				assert.deepEqual(before.workbench.tasks.map(task => task.state), ["succeeded", "succeeded", "succeeded", ...Array(2).fill(summaryFailure === "cancel" ? "cancelled" : "failed")]); assert.equal(before.workbench.invocations.length, 3); assert.equal(before.workbench.changes.length, 0); assert.equal(before.pi.length, 9);
				for (const entry of before.pi) {
					assert.ok(entry.path.endsWith(".jsonl"));
					const bytes = await readFile(join(directory, "supervisor-profile/supervisor", entry.path), "utf8"), entries = bytes.trim().split(/\r?\n/).map(line => JSON.parse(line));
					assert.ok(entries.length >= 2 && entries.every(value => value.type !== "compaction"), "FAILED_COMPACTION_RESULT_INVENTED");
					assert.ok(providerContextSteps.slice(3).every(step => !bytes.includes(step.marker)), "FOLLOWUP_AFTER_FAILED_COMPACTION");
				}
			}
			assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore, "DEVELOPMENT_USAGE_SOURCE_CHANGED");
			await writeFile(join(caseProof, "before-reopen.private.json"), JSON.stringify(before), { flag: "wx" });
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=" + phasePrefix + "reopen"], "reopen-");
			const phases = [];
			for (const phase of ["record", "reopen"]) {
				const proof = JSON.parse(await readFile(join(directory, (providerContext ? "development-" + phasePrefix : developmentContext ? "development-context-" : "development-usage-") + phase + "-proof.json"), "utf8"));
				assert.equal(proof.runId, caseId); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.expectedSha256, original.sha256);
				if (providerContext) {
					for (const key of ["packaged", "syntheticOnly", "readOnlyWorkspace", "originalTasksAndContextsRetained", "originalPricesAndModelLimitsRetained", "uiReloadDoesNotReplay", "newExecutionRejected", "noMcpSelected", "noProbeAllocated"]) assert.equal(proof[key], true);
					assert.equal(proof.bidirectionalContinuationAndCompaction, !contextFailures);
					assert.equal(proof.wholeApplicationRestartVerified, phase === "reopen"); assert.equal(proof.syntheticModelRequests, phase === "record" ? contextFailures ? 8 : 12 : 0); assert.equal(proof.actualToolCalls, phase === "record" ? contextFailures ? 3 : 5 : 0); assert.equal(proof.realModelRequests, 0); assert.equal(proof.gameCalls, 0);
					assert.deepEqual(proof.apis, ["openai-completions", "anthropic-messages"]); assert.equal(proof.totals.tasks, 5); assert.equal(proof.totals.knownRequests, contextFailures ? 8 : 12); assert.equal(proof.totals.missingResponses, contextFailures ? 2 : 0);
					const snapshots = original.expected.records.map(task => modelUsageSnapshot(task.usage)); assert.equal(proof.totals.tokens.totalTokens, snapshots.reduce((sum, usage) => sum + (usage.tokens?.totalTokens ?? 0), 0)); assert.ok(Math.abs(proof.totals.estimatedUsd - snapshots.reduce((sum, usage) => sum + (usage.estimate.usd ?? 0), 0)) < 1e-12);
					if (phase === "record") { assert.equal(proof.exercise.uiModelSwitches, 4); assert.equal(proof.exercise.compactionRequests, 2); assert.equal(proof.exercise.crossProviderToolPairsVerified, true); assert.equal(proof.exercise.independentCredentialsAndPrices, true); assert.equal(proof.exercise.currentReadOnlyTools, true); }
					if (contextFailures) {
						assert.equal(proof.summaryFailure, scenario); assert.equal(proof.summaryFailureDoesNotContinue, true); assert.equal(proof.missingUsageRemainsUnknown, true); assert.equal(proof.totals.unpricedTasks, 2); assert.equal(proof.totals.reportedResponses, 6);
						if (phase === "record") { assert.equal(proof.exercise.summaryFailure, scenario); assert.equal(proof.exercise.completedCompactions, 0); assert.equal(proof.exercise.noFollowupAfterSummaryFailure, true); assert.deepEqual(proof.exercise.cancelledByUi, scenario === "cancel" ? [3, 4] : []); assert.deepEqual(proof.exercise.clientAbortedBeforeCleanup, scenario === "cancel" ? [3, 4] : []); }
					}
				} else if (developmentContext) {
					for (const key of ["packaged", "syntheticOnly", "readOnlyWorkspace", "originalTasksAndContextsRetained", "usageIncludesCompaction", "uiReloadDoesNotReplay", "newExecutionRejected", "noMcpSelected", "noProbeAllocated"]) assert.equal(proof[key], true);
					const usage = original.expected.records.map(task => modelUsageSnapshot(task.usage)), requests = usage.reduce((sum, value) => sum + value.requests, 0);
					assert.equal(proof.totals.requests, requests); assert.equal(proof.totals.normalizedTokens, usage.reduce((sum, value) => sum + value.tokens.totalTokens, 0)); assert.ok(Math.abs(proof.totals.estimatedUsd - usage.reduce((sum, value) => sum + value.estimate.usd, 0)) < 1e-12);
					assert.equal(proof.syntheticModelRequests, phase === "record" ? requests : 0); assert.equal(proof.actualToolCalls, phase === "record" ? 1 : 0); assert.equal(proof.wholeApplicationRestartVerified, phase === "reopen"); assert.equal(proof.realModelRequests, 0); assert.equal(proof.gameCalls, 0);
					if (phase === "record") { assert.equal(proof.exercise.uiContinuationVerified, true); assert.equal(proof.exercise.uiCompactionVerified, true); assert.equal(proof.exercise.copiedSourceHashesRetained, true); assert.equal(proof.exercise.originalTasksAndReceiptsRetained, true); assert.equal(proof.exercise.usageIncludesCompaction, true); assert.equal(proof.exercise.compactionRequests, original.expected.records[2].result.contextManagement.compactionRequests); }
				} else {
				for (const key of ["packaged", "syntheticOnly", "readOnlyWorkspace", "priceSnapshotSurvivesReconfiguration", "uiReloadRetainsUsage", "originalTaskRetained", "newExecutionRejected", "noMcpSelected", "noProbeAllocated"]) assert.equal(proof[key], true);
				assert.equal(proof.wholeApplicationRestartVerified, phase === "reopen"); assert.equal(proof.syntheticModelRequests, phase === "record" ? 2 : 0); assert.equal(proof.toolInvocations, 1); assert.equal(proof.normalizedTokens, 240); assert.equal(proof.reportedResponses, 2); assert.ok(Math.abs(proof.estimatedUsd - 0.00077) < 1e-12); assert.equal(proof.realModelRequests, 0); assert.equal(proof.gameCalls, 0);
				assert.equal(proof.summary.readOnlySummaryVerified, true); assert.equal(proof.summary.normalizedTokens, 240); assert.equal(proof.summary.estimatedUsd, proof.estimatedUsd); assert.deepEqual(proof.summary.taskEndContext, original.expected.task.context);
					assert.deepEqual(proof.uiRecovery, phase === "record" ? { exactRecoveryGateVerified: true, waitedBeforeApiCall: true, originalUiExitConfirmed: true, uiEpochAdvancedOnce: true, runtimeRetained: true } : null);
				}
				await writeFile(join(caseProof, phase + "-application-proof.json"), JSON.stringify(proof), { flag: "wx" }); phases.push(proof);
			}
			if (developmentContext) assert.deepEqual(phases[1].totals, phases[0].totals);
			const after = await usageRecoveryState(directory, caseId, { role: "development" }); assert.deepEqual(after, before, "DEVELOPMENT_USAGE_ORIGINAL_ROWS_OR_PI_CHANGED");
			assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore, "DEVELOPMENT_USAGE_SOURCE_CHANGED_AFTER_RESTART"); assert.equal(await developmentGitHash(toolchain.git), toolchain.gitSha256);
			await writeFile(join(caseProof, "after-reopen.private.json"), JSON.stringify(after), { flag: "wx" });
			cases.push({ ...phases[0], developmentUsageScenario: contextFailures ? "cross-protocol-" + scenario + "-and-reopen" : providerContext ? "cross-protocol-continue-compact-and-reopen" : developmentContext ? "continue-compact-and-reopen" : "read-file-and-reopen", developmentUsageRecovery: phases[1], ...(contextFailures ? { noCompactionResultOrFollowupInvented: true } : {}), noPackagedChildrenRemain: true, originalRowsAndPiPreserved: true, sourceFilesUnchanged: true, externalGitRequired: true, gitVersion: toolchain.gitVersion, gitSha256: toolchain.gitSha256 });
			continue;
		}
		await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", (mcpLoss ? "--portable-mcp-loss=" : "--portable-runtime-loss=") + scenario]);
		const proof = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
		assert.equal(proof.runId, caseId); assert.equal(proof[mcpLoss ? "mcpLossScenario" : "runtimeScenario"], scenario); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit);
		for (const key of ["packaged", "visibleRenderer", "rendererNodeDisabled", "externalProviderAndDevelopmentRejected", "syntheticFactoryOnly"]) assert.equal(proof[key], true, key);
		assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
		if (mcpLoss) {
			const expected = mcpLossCase(scenario);
			if (manifest.modelUsage === 1) { assert.equal(proof.modelUsage?.normalizedTokens, 360); assert.equal(proof.modelUsage?.reportedResponses, 3); assert.ok(Math.abs(proof.modelUsage?.estimatedUsd - 0.001155) < 1e-12); assert.equal(proof.modelUsage?.retainedAcrossUiReloadAndMcpLoss, true); }
			for (const key of ["originalMcpExitObserved", "originalIdentityRetained", "noModelOrCommitReplay", "runtimeRetained", "ownServerExitConfirmed"]) assert.equal(proof[key], true, key);
			for (const key of ["newExecutionDisabledDuringLoss", "explicitOriginalReconciliationOnly"]) assert.equal(proof[key], expected.hasIntent !== false, key);
			if (expected.hasIntent === false) { assert.equal(proof.noIntentAllocated, true); assert.equal(proof.confirmationAfterLossRejected, true); assert.equal(proof.stoppedTaskRetained, true); assert.equal(proof.preIntentError, "MCP_READ_NOT_SUPPORTED"); assert.equal(proof.approvalStage, expected.beforeIntent); assert.equal(proof.heldDialogResponseMocked, expected.beforeIntent === "confirmation"); }
			assert.equal(proof.originalAcceptedActionReconciled, expected.taskState === "completed"); assert.equal(proof.unknownCommitRemainsBlocked, !expected.hasActionId && expected.hasIntent !== false); assert.equal(proof.mismatchRemainsBlocked, Boolean(expected.error && !expected.nativeOutcome)); assert.equal(proof.recoveryError, expected.error); assert.equal(proof.repeatedIsolatedReconciliationMakesNoRequests, Boolean(expected.auditReason)); assert.equal(proof.syntheticGameCommits, expected.commits ?? 1); assert.equal(proof.syntheticCommitRequests, expected.commitRequests ?? 1); assert.equal(proof.duplicateRepliesIgnored, expected.duplicateReplies ?? 0); assert.equal(proof.duplicateDelivery, expected.duplicateDelivery ?? null); assert.equal(proof.syntheticPrepareCalls, 1); assert.equal(proof.syntheticModelRequests, 3); assert.equal(proof.replacementMcpCount, expected.hasActionId ? 1 : 0);
			assert.equal(proof.nativeOutcomeRemainsBlocked, Boolean(expected.nativeOutcome)); assert.deepEqual(proof.nativeOutcome, expected.nativeOutcome ?? null);
			const base = join(directory, "runtime-fixtures/m3-smoke", caseId), world = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8")); assert.equal(world.runId, caseId); assert.equal(world.commits, expected.commits ?? 1); assert.equal(world.commitRequests ?? 0, expected.commitRequests ?? 1); assert.equal(world.duplicateRepliesSent ?? 0, expected.duplicateReplies ?? 0); assert.equal(world.duplicateDelivery ?? null, expected.duplicateDelivery ?? null); assert.equal(world.prepares, 1); assert.equal(world.launches, expected.hasActionId ? 2 : 1); assert.equal(world.resultReads, expected.resultReads); assert.deepEqual(world.nativeOutcome ?? null, expected.nativeOutcome ?? null);
			await writeFile(join(caseProof, "mcp-loss.private.json"), await readFile(join(base, "mcp-loss.private.json")), { flag: "wx" });
		} else {
		assert.equal(proof.runtimeExitObserved, true);
		if (scenario === "idle") { assert.equal(proof.previousResultRetained, true); assert.equal(proof.noProbeAllocated, true); assert.equal(proof.syntheticProbeRequests, 2); }
		else { assert.equal(proof.noNewCommitAfterRuntimeExit, true); assert.equal(proof.developmentRemainsFrozen, true); assert.equal(proof.newExecutionDisabled, true); assert.equal(proof.noRuntimeOrModelReplay, true); assert.equal(proof.ownServerExitConfirmed, true); assert.equal(proof.syntheticGameCommits, scenario === "accepted" ? 1 : 0); assert.equal(proof.syntheticModelRequests, scenario === "planning" ? 1 : 3); }
		if (scenario === "confirmation") assert.equal(proof.confirmationInvalidated, true);
		if (scenario === "accepted") assert.equal(proof.originalAcceptedActionReconciled, true);
		if (scenario === "planning") assert.equal(proof.inFlightPlannerEnded, true);
		}
		await writeFile(join(caseProof, "application-proof.json"), JSON.stringify(proof), { flag: "wx" });
		let modelUsageRecovery = null;
		if (mcpLoss && manifest.modelUsageRecovery === 1) {
			assert.equal(manifest.modelUsage, 1);
			const before = await usageRecoveryState(directory, caseId), state = JSON.parse(await readFile(join(caseProof, "mcp-loss.private.json"), "utf8")).state;
			const nativeCase = mcpLossCase(scenario);
			if (nativeCase.hasIntent === false) { assert.equal(state.tasks[0].state, "cancelled"); assert.equal(state.tasks[0].intent, null); assert.deepEqual(before.rows.game_intents, []); assert.deepEqual(before.rows.game_gate, []); }
			if (nativeCase.auditReason) assert.deepEqual(before.rows.game_gate, [{ id: 1, intent_id: state.tasks[0].intent.intentId, reason: nativeCase.auditReason }]);
			const expected = { tasks: state.tasks, events: state.events }, marker = { version: 1, kind: "synthetic-model-usage-recovery", runId: caseId, scenario, expected, sha256: modelUsageRecoveryHash(expected) };
			await writeFile(join(caseProof, "before-reopen.private.json"), JSON.stringify(before), { flag: "wx" });
			await writeFile(join(directory, modelUsageRecoveryFile), JSON.stringify(marker), { flag: "wx" });
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke"], "reopen-");
			modelUsageRecovery = JSON.parse(await readFile(join(directory, "model-usage-recovery-proof.json"), "utf8"));
			assert.equal(modelUsageRecovery.runId, caseId); assert.equal(modelUsageRecovery.scenario, scenario); assert.equal(modelUsageRecovery.sourceRevision, manifest.sourceRevision); assert.equal(modelUsageRecovery.piCommit, manifest.piCommit); assert.equal(modelUsageRecovery.expectedSha256, marker.sha256);
			for (const key of ["packaged", "syntheticOnly", "wholeApplicationRestartVerified", "originalTaskAndUsageRetained", "usageVisibleAfterRestartAndUiReload", "noMcpSelected", "noProbeAllocated", "newExecutionRejected"]) assert.equal(modelUsageRecovery[key], true);
			assert.equal(modelUsageRecovery.unknownCommitRemainsBlocked, !nativeCase.hasActionId && nativeCase.hasIntent !== false); assert.equal(modelUsageRecovery.noIntentRemainsUnallocated, nativeCase.hasIntent === false); assert.equal(modelUsageRecovery.mismatchRemainsBlocked, Boolean(nativeCase.error && !nativeCase.nativeOutcome)); assert.equal(modelUsageRecovery.nativeOutcomeRemainsBlocked, Boolean(nativeCase.nativeOutcome)); assert.equal(modelUsageRecovery.modelUsage.normalizedTokens, 360); assert.equal(modelUsageRecovery.modelUsage.reportedResponses, 3); assert.ok(Math.abs(modelUsageRecovery.modelUsage.estimatedUsd - 0.001155) < 1e-12);
			if (manifest.modelUsageSummary === 1) { assert.equal(modelUsageRecovery.summary.readOnlySummaryVerified, true); assert.equal(modelUsageRecovery.summary.normalizedTokens, 360); assert.equal(modelUsageRecovery.summary.estimatedUsd, modelUsageRecovery.modelUsage.estimatedUsd); assert.deepEqual(modelUsageRecovery.summary.taskEndContext, marker.expected.tasks[0].details.context); }
			assert.equal(modelUsageRecovery.gameCalls, 0); assert.equal(modelUsageRecovery.realModelRequests, 0);
			const after = await usageRecoveryState(directory, caseId); assert.deepEqual(after, before, "MODEL_USAGE_RESTART_CHANGED_ORIGINAL_ROWS_OR_PI");
			await writeFile(join(caseProof, "after-reopen.private.json"), JSON.stringify(after), { flag: "wx" }); await writeFile(join(caseProof, "model-usage-recovery.json"), JSON.stringify(modelUsageRecovery), { flag: "wx" });
		}
		cases.push({ ...proof, noPackagedChildrenRemain: true, ...(modelUsageRecovery ? { modelUsageRecovery } : {}) });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, outsideSourceCheckout: true, actualPackagedApplication: true, applicationRuns: cases.reduce((sum, value) => sum + (value.applicationRuns ?? 1 + Number(Boolean(value.modelUsageRecovery || value.developmentUsageRecovery))), 0), cases, bundleUnchanged: true, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false, cleanWindowsVmVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local", proofFolder + "-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify({ [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, cases: cases.map(value => value[developmentUsage ? "developmentUsageScenario" : mcpLoss ? "mcpLossScenario" : "runtimeScenario"]), gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
