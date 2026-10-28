import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { diagnosticSmokeFailure, diagnosticSmokeStages } from "../apps/desktop/diagnostic-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), runId = randomUUID(), args = process.argv.slice(2), packaged = args.length > 0;
if (process.platform !== "win32" || packaged && (args.length !== 2 || args[0] !== "--source")) throw new Error("UNEXPECTED_DIAGNOSTIC_SMOKE_ARGUMENTS");
const source = packaged ? await realpath(resolve(root, args[1])) : null, manifest = source ? await verifyBundle(source) : null;
if (packaged) { assert.equal(manifest.portableDiagnostics, 1, "PACKAGED_DIAGNOSTIC_MODE_UNSUPPORTED_REBUILD_REQUIRED"); assert.equal(manifest.portableDiagnosticProgress, 1, "PACKAGED_DIAGNOSTIC_PROGRESS_REBUILD_REQUIRED"); assert.equal(manifest.nativeProcessObserver, 1); }
const prefix = packaged ? "commanddeck-desktop-smoke-" : "commanddeck-diagnostics-smoke-";
const directory = await realpath(await mkdtemp(join(tmpdir(), prefix))), evidence = join(root, packaged ? ".local/packaged-diagnostics" : ".local/diagnostic-smoke", runId);
await mkdir(evidence, { recursive: true });
await writeFile(join(evidence, "context.private.json"), JSON.stringify({ runId, directory, packaged, sourceRevision: manifest?.sourceRevision ?? null }), { flag: "wx" });
let child, copyRoot, copy, passed = false, output = "", timedOut = false, exitCode, signal, remaining;
try {
	if (packaged) { copyRoot = await realpath(await mkdtemp(join(tmpdir(), prefix))); copy = join(copyRoot, "bundle"); await copyBundleTree(source, copy); await verifyBundle(copy); }
	const executable = packaged ? join(copy, bundleExecutable) : join(root, "node_modules/electron/dist/electron.exe");
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
	const environment = syntheticMcpEnvironment({ ...inherited, ...(packaged ? { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId } : {}), COMMANDDECK_SMOKE_RUN_ID: runId, COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT: directory, COMMANDDECK_PI_CONFIG_DIR: join(directory, "no-user-provider-configuration") });
	child = spawn(executable, packaged ? ["--portable-smoke", "--portable-diagnostics"] : [root, "--smoke", "--smoke-diagnostics"], { cwd: packaged ? directory : root, env: environment, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
	try { [exitCode, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
	await writeFile(join(evidence, "exit.private.json"), JSON.stringify({ exitCode, signal, timedOut, output }), { flag: "wx" });
	const observer = join(packaged ? join(copy, "resources/app") : root, "artifacts/native/CommandDeck.NativeHost.exe");
	const deadline = performance.now() + 25000;
	do {
		const budget = Math.floor(deadline - performance.now()); if (budget <= 0) break;
		const observation = await observePackagedProcesses({ executable: observer, roots: [dirname(executable), directory], env: environment, timeoutMs: Math.min(20000, budget) });
		await writeFile(join(evidence, "process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
		if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < deadline);
	assert.equal(remaining, 0); assert.equal(timedOut, false);
	assert.equal(exitCode, 0, signal ?? "DIAGNOSTIC_APPLICATION_FAILED");
	const proofBytes = await readFile(join(directory, packaged ? "application-proof.json" : "diagnostic-application-proof.private.json")), proof = JSON.parse(proofBytes);
	assert.deepEqual(proof.testStagesReached, diagnosticSmokeStages, "DIAGNOSTIC_SMOKE_PROGRESS_INCOMPLETE");
	assert.equal(proof.runId, runId); for (const key of ["previewMatchesSavedBytes", "cancelledPickerWritesNothing", "existingDestinationPreserved", "changedOptionsDiscardPreview", "reloadInvalidatesPreview", "newPreviewAfterReload", "diagnosticAfterRuntimeExit", "runtimeExitObserved", "noMcpAllocated", "noTaskCreatedOrReplayed"]) assert.equal(proof[key], true, key);
	const exported = await readFile(join(directory, "diagnostic-export.json")), report = JSON.parse(exported);
	assert.equal(createHash("sha256").update(exported).digest("hex"), proof.previewSha256); assert.equal(exported.length, proof.previewBytes); assert.equal(report.build.packaged, packaged); assert.equal(proof.realGameCalls, 0); assert.equal(proof.realModelRequests, 0); assert.equal(proof.physicalInputVerified, false);
	if (packaged) {
		assert.equal(proof.packaged, true); assert.equal(proof.packageMetadataMatchesBundle, true); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(report.build.sourceRevision, manifest.sourceRevision); assert.equal(report.build.piCommit, manifest.piCommit);
		await verifyBundle(copy); await verifyBundle(source);
	}
	await writeFile(join(evidence, "application-proof.private.json"), proofBytes, { flag: "wx" });
	await writeFile(join(evidence, "diagnostic-export.private.json"), exported, { flag: "wx" });
	await writeFile(join(root, packaged ? ".local/packaged-diagnostics-smoke.json" : ".local/desktop-smoke-diagnostics.json"), JSON.stringify({ ...proof, usesSourceCheckout: !packaged, noOwnedProcessesRemain: true, processObserver: "native-v1", packagedVerification: packaged, bundleUnchanged: packaged, outsideSourceCheckout: packaged, developerToolPathExcluded: packaged, cleanWindowsVmVerified: false }, null, 2));
	passed = true; console.log(JSON.stringify({ diagnosticDesktopSmoke: "passed", runId, packaged, sourceRevision: manifest?.sourceRevision ?? null, stagesReached: proof.testStagesReached, noRealGameOrModelCalls: true, nativeSavePickerResponseMocked: true }));
} catch (error) {
	const failure = diagnosticSmokeFailure({ packaged, exitCode, timedOut, remaining, output });
	await writeFile(join(evidence, "failure.json"), JSON.stringify(failure), { flag: "wx" });
	console.error("DIAGNOSTIC_SMOKE_FAILURE", JSON.stringify(failure));
	throw error;
} finally {
	if (passed) for (const target of [directory, copyRoot].filter(Boolean)) { const canonical = await realpath(target); assert.equal(canonical, target); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith(prefix)); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
