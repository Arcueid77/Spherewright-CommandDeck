import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { portableRuntimeScenarios, portableMcpScenarios } from "../apps/desktop/portable-mode.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
const mcpLoss = args[0] === "--mcp-loss"; if (mcpLoss) args.shift();
const scenarios = mcpLoss ? portableMcpScenarios : portableRuntimeScenarios, proofFolder = mcpLoss ? "packaged-mcp-loss" : "packaged-runtime-loss", proofKind = mcpLoss ? "packagedMcpLossSmoke" : "packagedRuntimeLossSmoke";
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_RUNTIME_FAULT_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1); assert.equal(manifest[mcpLoss ? "portableMcpFaults" : "portableRuntimeFaults"], 1, "PACKAGED_FAULT_MODE_UNSUPPORTED_REBUILD_REQUIRED");
assert.ok(manifest.files.some(file => file.path === "resources/app/test/fixtures/research-mcp-server.mjs"));
const proofRoot = join(root, ".local", proofFolder, runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const path = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(path); return path; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const scenario of scenarios) {
		const directory = await temporary(), caseId = randomUUID(), caseProof = join(proofRoot, scenario); await mkdir(caseProof);
		await writeFile(join(caseProof, "context.private.json"), JSON.stringify({ runId, caseId, scenario, directory, copy, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke", (mcpLoss ? "--portable-mcp-loss=" : "--portable-runtime-loss=") + scenario], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
		let code, signal; try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
		await writeFile(join(caseProof, "exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
		let remaining; const until = performance.now() + 25000;
		do {
			const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
			const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env, timeoutMs: Math.min(20000, budget) });
			await writeFile(join(caseProof, "process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
			if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
		} while (performance.now() < until);
		assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
		const proof = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
		assert.equal(proof.runId, caseId); assert.equal(proof[mcpLoss ? "mcpLossScenario" : "runtimeScenario"], scenario); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit);
		for (const key of ["packaged", "visibleRenderer", "rendererNodeDisabled", "externalProviderAndDevelopmentRejected", "syntheticFactoryOnly"]) assert.equal(proof[key], true, key);
		assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
		if (mcpLoss) {
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
		cases.push({ ...proof, noPackagedChildrenRemain: true });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, outsideSourceCheckout: true, actualPackagedApplication: true, applicationRuns: cases.length, cases, bundleUnchanged: true, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false, cleanWindowsVmVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local", proofFolder + "-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify({ [proofKind]: "passed", runId, sourceRevision: manifest.sourceRevision, cases: cases.map(value => value[mcpLoss ? "mcpLossScenario" : "runtimeScenario"]), gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
