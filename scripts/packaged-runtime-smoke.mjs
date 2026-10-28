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
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { modelUsageRecoveryFile, modelUsageRecoveryHash } from "../apps/desktop/model-usage-recovery.mjs";
import { usageRecoveryState } from "./model-usage-recovery-state.mjs";
import { prepareDevelopmentUsageCase, developmentWorkspaceState, developmentGitHash } from "./development-usage-case.mjs";
import { readDevelopmentUsageOriginal } from "../apps/desktop/development-usage-smoke.mjs";
import { readDevelopmentContextOriginal } from "../apps/desktop/development-context-recovery.mjs";
import { modelUsageSnapshot } from "../apps/desktop/model-usage.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
const developmentContext = args[0] === "--development-context"; if (developmentContext) args.shift();
const developmentUsage = developmentContext || args[0] === "--development-usage"; if (developmentUsage && !developmentContext) args.shift();
const mcpLoss = args[0] === "--mcp-loss"; if (mcpLoss) args.shift();
if (developmentUsage && mcpLoss) throw new Error("PACKAGED_USAGE_MODE_CONFLICT");
const scenarios = developmentUsage ? ["development"] : mcpLoss ? portableMcpScenarios : portableRuntimeScenarios, proofFolder = developmentContext ? "packaged-development-context" : developmentUsage ? "packaged-development-usage" : mcpLoss ? "packaged-mcp-loss" : "packaged-runtime-loss", proofKind = developmentContext ? "packagedDevelopmentContextSmoke" : developmentUsage ? "packagedDevelopmentUsageSmoke" : mcpLoss ? "packagedMcpLossSmoke" : "packagedRuntimeLossSmoke";
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_RUNTIME_FAULT_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1); assert.equal(manifest[developmentUsage ? "portableDevelopmentUsage" : mcpLoss ? "portableMcpFaults" : "portableRuntimeFaults"], 1, "PACKAGED_FAULT_MODE_UNSUPPORTED_REBUILD_REQUIRED");
if (developmentUsage) assert.equal(manifest.modelUsageSummary, 1, "PACKAGED_USAGE_SUMMARY_REBUILD_REQUIRED");
if (developmentContext) { assert.equal(manifest.portableDevelopmentContext, 1, "PACKAGED_CONTEXT_REBUILD_REQUIRED"); assert.equal(manifest.developmentContextManagement, 1); }
assert.ok(manifest.files.some(file => file.path === "resources/app/test/fixtures/research-mcp-server.mjs"));
const proofRoot = join(root, ".local", proofFolder, runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const path = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(path); return path; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
async function launch(directory, environment, evidence, argv, prefix = "") {
	const child = spawn(join(copy, bundleExecutable), argv, { cwd: directory, env: environment, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
	let code, signal; try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
	await writeFile(join(evidence, prefix + "exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
	let remaining; const until = performance.now() + 25000;
	do {
		const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
		const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env: environment, timeoutMs: Math.min(20000, budget) });
		await writeFile(join(evidence, prefix + "process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
		if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < until);
	assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
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
			const phasePrefix = developmentContext ? "context-" : "";
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=" + phasePrefix + "record"], "record-");
			const original = await (developmentContext ? readDevelopmentContextOriginal : readDevelopmentUsageOriginal)({ root: directory, runId: caseId }), before = await usageRecoveryState(directory, caseId, { role: "development" });
			assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore, "DEVELOPMENT_USAGE_SOURCE_CHANGED");
			await writeFile(join(caseProof, "before-reopen.private.json"), JSON.stringify(before), { flag: "wx" });
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", "--portable-development-usage=" + phasePrefix + "reopen"], "reopen-");
			const phases = [];
			for (const phase of ["record", "reopen"]) {
				const proof = JSON.parse(await readFile(join(directory, (developmentContext ? "development-context-" : "development-usage-") + phase + "-proof.json"), "utf8"));
				assert.equal(proof.runId, caseId); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.expectedSha256, original.sha256);
				if (developmentContext) {
					for (const key of ["packaged", "syntheticOnly", "readOnlyWorkspace", "originalTasksAndContextsRetained", "usageIncludesCompaction", "uiReloadDoesNotReplay", "newExecutionRejected", "noMcpSelected", "noProbeAllocated"]) assert.equal(proof[key], true);
					const usage = original.expected.records.map(task => modelUsageSnapshot(task.usage)), requests = usage.reduce((sum, value) => sum + value.requests, 0);
					assert.equal(proof.totals.requests, requests); assert.equal(proof.totals.normalizedTokens, usage.reduce((sum, value) => sum + value.tokens.totalTokens, 0)); assert.ok(Math.abs(proof.totals.estimatedUsd - usage.reduce((sum, value) => sum + value.estimate.usd, 0)) < 1e-12);
					assert.equal(proof.syntheticModelRequests, phase === "record" ? requests : 0); assert.equal(proof.actualToolCalls, phase === "record" ? 1 : 0); assert.equal(proof.wholeApplicationRestartVerified, phase === "reopen"); assert.equal(proof.realModelRequests, 0); assert.equal(proof.gameCalls, 0);
					if (phase === "record") { assert.equal(proof.exercise.uiContinuationVerified, true); assert.equal(proof.exercise.uiCompactionVerified, true); assert.equal(proof.exercise.copiedSourceHashesRetained, true); assert.equal(proof.exercise.originalTasksAndReceiptsRetained, true); assert.equal(proof.exercise.usageIncludesCompaction, true); assert.equal(proof.exercise.compactionRequests, original.expected.records[2].result.contextManagement.compactionRequests); }
				} else {
				for (const key of ["packaged", "syntheticOnly", "readOnlyWorkspace", "priceSnapshotSurvivesReconfiguration", "uiReloadRetainsUsage", "originalTaskRetained", "newExecutionRejected", "noMcpSelected", "noProbeAllocated"]) assert.equal(proof[key], true);
				assert.equal(proof.wholeApplicationRestartVerified, phase === "reopen"); assert.equal(proof.syntheticModelRequests, phase === "record" ? 2 : 0); assert.equal(proof.toolInvocations, 1); assert.equal(proof.normalizedTokens, 240); assert.equal(proof.reportedResponses, 2); assert.ok(Math.abs(proof.estimatedUsd - 0.00077) < 1e-12); assert.equal(proof.realModelRequests, 0); assert.equal(proof.gameCalls, 0);
				assert.equal(proof.summary.readOnlySummaryVerified, true); assert.equal(proof.summary.normalizedTokens, 240); assert.equal(proof.summary.estimatedUsd, proof.estimatedUsd); assert.deepEqual(proof.summary.taskEndContext, original.expected.task.context);
				}
				await writeFile(join(caseProof, phase + "-application-proof.json"), JSON.stringify(proof), { flag: "wx" }); phases.push(proof);
			}
			if (developmentContext) assert.deepEqual(phases[1].totals, phases[0].totals);
			const after = await usageRecoveryState(directory, caseId, { role: "development" }); assert.deepEqual(after, before, "DEVELOPMENT_USAGE_ORIGINAL_ROWS_OR_PI_CHANGED");
			assert.deepEqual(await developmentWorkspaceState(directory), workspaceBefore, "DEVELOPMENT_USAGE_SOURCE_CHANGED_AFTER_RESTART"); assert.equal(await developmentGitHash(toolchain.git), toolchain.gitSha256);
			await writeFile(join(caseProof, "after-reopen.private.json"), JSON.stringify(after), { flag: "wx" });
			cases.push({ ...phases[0], developmentUsageScenario: developmentContext ? "continue-compact-and-reopen" : "read-file-and-reopen", developmentUsageRecovery: phases[1], noPackagedChildrenRemain: true, originalRowsAndPiPreserved: true, sourceFilesUnchanged: true, externalGitRequired: true, gitVersion: toolchain.gitVersion, gitSha256: toolchain.gitSha256 });
			continue;
		}
		await launch(directory, caseEnvironment, caseProof, ["--portable-smoke", (mcpLoss ? "--portable-mcp-loss=" : "--portable-runtime-loss=") + scenario]);
		const proof = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
		assert.equal(proof.runId, caseId); assert.equal(proof[mcpLoss ? "mcpLossScenario" : "runtimeScenario"], scenario); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit);
		for (const key of ["packaged", "visibleRenderer", "rendererNodeDisabled", "externalProviderAndDevelopmentRejected", "syntheticFactoryOnly"]) assert.equal(proof[key], true, key);
		assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
		if (mcpLoss) {
			if (manifest.modelUsage === 1) { assert.equal(proof.modelUsage?.normalizedTokens, 360); assert.equal(proof.modelUsage?.reportedResponses, 3); assert.ok(Math.abs(proof.modelUsage?.estimatedUsd - 0.001155) < 1e-12); assert.equal(proof.modelUsage?.retainedAcrossUiReloadAndMcpLoss, true); }
			for (const key of ["originalMcpExitObserved", "originalIdentityRetained", "newExecutionDisabledDuringLoss", "explicitOriginalReconciliationOnly", "noModelOrCommitReplay", "runtimeRetained", "ownServerExitConfirmed"]) assert.equal(proof[key], true, key);
			assert.equal(proof.originalAcceptedActionReconciled, scenario === "accepted"); assert.equal(proof.unknownCommitRemainsBlocked, scenario === "lost-ack"); assert.equal(proof.syntheticGameCommits, 1); assert.equal(proof.syntheticPrepareCalls, 1); assert.equal(proof.syntheticModelRequests, 3); assert.equal(proof.replacementMcpCount, scenario === "accepted" ? 1 : 0);
			const base = join(directory, "runtime-fixtures/m3-smoke", caseId), world = JSON.parse(await readFile(join(base, "synthetic-research-world.json"), "utf8")); assert.equal(world.runId, caseId); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.launches, scenario === "accepted" ? 2 : 1); assert.equal(world.resultReads, scenario === "accepted" ? 2 : 0);
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
			const expected = { tasks: state.tasks, events: state.events }, marker = { version: 1, kind: "synthetic-model-usage-recovery", runId: caseId, scenario, expected, sha256: modelUsageRecoveryHash(expected) };
			await writeFile(join(caseProof, "before-reopen.private.json"), JSON.stringify(before), { flag: "wx" });
			await writeFile(join(directory, modelUsageRecoveryFile), JSON.stringify(marker), { flag: "wx" });
			await launch(directory, caseEnvironment, caseProof, ["--portable-smoke"], "reopen-");
			modelUsageRecovery = JSON.parse(await readFile(join(directory, "model-usage-recovery-proof.json"), "utf8"));
			assert.equal(modelUsageRecovery.runId, caseId); assert.equal(modelUsageRecovery.scenario, scenario); assert.equal(modelUsageRecovery.sourceRevision, manifest.sourceRevision); assert.equal(modelUsageRecovery.piCommit, manifest.piCommit); assert.equal(modelUsageRecovery.expectedSha256, marker.sha256);
			for (const key of ["packaged", "syntheticOnly", "wholeApplicationRestartVerified", "originalTaskAndUsageRetained", "usageVisibleAfterRestartAndUiReload", "noMcpSelected", "noProbeAllocated", "newExecutionRejected"]) assert.equal(modelUsageRecovery[key], true);
			assert.equal(modelUsageRecovery.unknownCommitRemainsBlocked, scenario === "lost-ack"); assert.equal(modelUsageRecovery.modelUsage.normalizedTokens, 360); assert.equal(modelUsageRecovery.modelUsage.reportedResponses, 3); assert.ok(Math.abs(modelUsageRecovery.modelUsage.estimatedUsd - 0.001155) < 1e-12);
			if (manifest.modelUsageSummary === 1) { assert.equal(modelUsageRecovery.summary.readOnlySummaryVerified, true); assert.equal(modelUsageRecovery.summary.normalizedTokens, 360); assert.equal(modelUsageRecovery.summary.estimatedUsd, modelUsageRecovery.modelUsage.estimatedUsd); assert.deepEqual(modelUsageRecovery.summary.taskEndContext, marker.expected.tasks[0].details.context); }
			assert.equal(modelUsageRecovery.gameCalls, 0); assert.equal(modelUsageRecovery.realModelRequests, 0);
			const after = await usageRecoveryState(directory, caseId); assert.deepEqual(after, before, "MODEL_USAGE_RESTART_CHANGED_ORIGINAL_ROWS_OR_PI");
			await writeFile(join(caseProof, "after-reopen.private.json"), JSON.stringify(after), { flag: "wx" }); await writeFile(join(caseProof, "model-usage-recovery.json"), JSON.stringify(modelUsageRecovery), { flag: "wx" });
		}
		cases.push({ ...proof, noPackagedChildrenRemain: true, ...(modelUsageRecovery ? { modelUsageRecovery } : {}) });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, outsideSourceCheckout: true, actualPackagedApplication: true, applicationRuns: cases.length + cases.filter(value => value.modelUsageRecovery || value.developmentUsageRecovery).length, cases, bundleUnchanged: true, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false, cleanWindowsVmVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local", proofFolder + "-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify({ [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, cases: cases.map(value => value[developmentUsage ? "developmentUsageScenario" : mcpLoss ? "mcpLossScenario" : "runtimeScenario"]), gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
