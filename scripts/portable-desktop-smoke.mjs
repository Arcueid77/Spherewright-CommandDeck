import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { validateInstalledSmokeSource } from "./installer-files.mjs";
import { seedPortableHistory } from "./portable-history-fixture.mjs";
import { readPortableHistory } from "../apps/desktop/portable-history.mjs";
import { readInstalledProfileContext } from "./installer-upgrade-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || ![2, 3, 4].includes(args.length) || !["--source", "--installed-source"].includes(args[0]) || args.length === 3 && args[2] !== "--reopen-history" || args.length === 4 && (args[0] !== "--installed-source" || args[2] !== "--resume-profile")) throw new Error("EXPLICIT_WINDOWS_PORTABLE_DESKTOP_REQUIRED");
const reopenHistory = args[2] === "--reopen-history";
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
if (manifest.nativeProcessObserver !== 1) throw new Error("PACKAGED_PROCESS_OBSERVER_UNSUPPORTED_REBUILD_REQUIRED");
const installed = args[0] === "--installed-source";
if (installed) await validateInstalledSmokeSource(source, manifest.sourceRevision);
const resumed = args[2] === "--resume-profile" ? await readInstalledProfileContext(resolve(root, args[3]), source, manifest.sourceRevision) : null;
const runId = resumed?.runId ?? randomUUID(), directory = resumed?.directory ?? await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = installed ? source : join(directory, "bundle");
const proofRoot = join(root, ".local/portable-desktop", runId); await mkdir(proofRoot, { recursive: true });
await writeFile(join(root, ".local/portable-desktop-application.json"), JSON.stringify({ runId, sourceRevision: manifest.sourceRevision, applicationProofAvailable: false, wholeBundlePassed: false }, null, 2));
let child, exitConfirmed = false, remaining = null, verified = false;
try {
	if (!installed) await copyBundleTree(source, copy); await verifyBundle(copy);
	let history = resumed?.history ?? null;
	for (const phase of resumed ? [resumed.phase] : reopenHistory ? ["fresh", "reopen"] : ["fresh"]) {
	const phaseProofRoot = phase === "fresh" ? proofRoot : join(proofRoot, phase); await mkdir(phaseProofRoot, { recursive: !resumed });
	exitConfirmed = false; remaining = null;
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
	Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COREHOST_TRACE: "1", COREHOST_TRACEFILE: join(directory, "runtime.trace.private.log"), COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId, COMMANDDECK_SMOKE_RUN_ID: runId });
	if (resumed) {
		const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, resumed.installation], env, timeoutMs: 20000 });
		await writeFile(join(phaseProofRoot, "before-process-observation.private.json"), JSON.stringify(observation, null, 2), { flag: "wx" }); assert.equal(observation.count, 0, "Existing installed/profile processes block a resumed launch");
		for (const name of ["application-proof.json", "runtime.trace.private.log"]) {
			const from = join(directory, name), to = join(directory, phase + "-before-" + name);
			assert.equal((await realpath(from)).toLowerCase(), from.toLowerCase());
			await assert.rejects(realpath(to), { code: "ENOENT" }); await rename(from, to);
		}
	}
	child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
	let code, signal; try { [code, signal] = await once(child, "exit"); exitConfirmed = true; } finally { clearTimeout(timer); }
	await writeFile(join(phaseProofRoot, "application-exit.private.json"), JSON.stringify({ runId, phase, sourceRevision: manifest.sourceRevision, profileDirectory: directory, installedSource: installed ? source : null, code, signal, timedOut, output }, null, 2), { flag: "wx" });
	const applicationExit = { applicationExitCode: code, applicationSignal: signal, applicationTimedOut: timedOut };
	await writeFile(join(root, ".local/portable-desktop-application.json"), JSON.stringify({ runId, sourceRevision: manifest.sourceRevision, applicationProofAvailable: false, wholeBundlePassed: false, ...applicationExit }, null, 2));
	let application;
	try {
		application = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
		assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit);
		await writeFile(join(phaseProofRoot, "application-proof.json"), JSON.stringify(application, null, 2), { flag: "wx" });
		await writeFile(join(root, ".local/portable-desktop-application.json"), JSON.stringify({ ...application, ...applicationExit, applicationProofAvailable: true, wholeBundlePassed: false, verificationStage: "application-only" }, null, 2));
	} catch (error) { if (error.code !== "ENOENT") throw error; }
	const until = performance.now() + 25000;
	do {
		const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
		const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: installed ? [directory, copy] : [directory], env, timeoutMs: Math.min(20000, budget) });
		await writeFile(join(phaseProofRoot, "process-observation.private.json"), JSON.stringify(observation, null, 2));
		remaining = observation.count;
		if (remaining === 0) break;
		await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < until);
	assert.equal(remaining, 0, "Packaged children remain alive");
	assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
	assert.ok(application, "Packaged application did not write its completion proof");
	assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit);
	if (manifest.desktopTray === 1) for (const field of ["supervisorTrayRetainedAcrossReload", "nativeTrayMenuRestoresMinimizedUi", "exitRequestedThroughTray"]) assert.equal(application[field], true, field);
	if (manifest.powerLifecycle === 1) {
		for (const field of ["synthesizedPowerMonitorEvents", "rejectedAdmissionWhileSuspended", "reloadRetainsPowerGate", "wakeCheckFailureStaysBlockedUntilUiRetry", "noModelOrTaskReplay", "originalNativeBindingRetained"]) assert.equal(application.powerLifecycle?.[field], true, field);
		assert.equal(application.powerLifecycle.cycles.length, 2); assert.equal(application.powerLifecycle.actualOsSleepVerified, false);
		assert.equal(application.powerLifecycle.cycles[1].explicitRetryRequired, true);
	}
	if (manifest.eventJournal === 1) {
		for (const field of ["localEventJournal", "recordingRowsRetained", "bookmarkNavigation", "historicalReplayReadOnly", "replayExecutionActionsRejected", "uiReloadRetainsJournal", "noModelOrTaskReplay", "originalNativeStateRetained"]) assert.equal(application.eventJournal?.[field], true, field);
		assert.equal(application.eventJournal.bookmarkCount, 1); assert.equal(application.eventJournal.videoRecordingVerified, false);
		if (phase === "reopen") assert.equal(application.eventJournal.previousAppRecordingReopened, true);
	}
	if (phase === "reopen" || resumed) { assert.equal(application.closedHistoryReopened, true); assert.equal(application.emptyIsolatedWorkspace, false); assert.equal(application.history?.closedHistorySha256, history.sha256); assert.equal((await readPortableHistory({ root: directory, runId })).sha256, history.sha256); }
	const trace = await readFile(join(directory, "runtime.trace.private.log")), text = trace.toString().toLowerCase();
	for (const file of ["hostfxr.dll", "coreclr.dll", "System.Windows.Forms.dll"]) assert.ok(text.includes(join(copy, "resources/app/artifacts/native", file).toLowerCase()), "App-local native runtime missing: " + file);
	assert.ok(text.includes("portable-command-cache"));
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { ...application, processObserver: "native-v1", installedExecutable: installed, profileRetainedForInstallerVerification: installed, outsideSourceCheckout: true, developerToolsAbsentFromPath: true, noExternalNodeTestChild: true, sharedDotnetRootsUnavailable: true, appLocalNativeAndCommandRuntimesObserved: true, bundleUnchanged: true, noPackagedChildrenRemain: true, files: manifest.files.length, bytes: manifest.bytes, traceSha256: bundleHash(trace) };
	await writeFile(join(phaseProofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
	await writeFile(join(phaseProofRoot, "runtime.trace.private.log"), trace, { flag: "wx" });
	await writeFile(join(root, ".local/portable-desktop-smoke.json"), JSON.stringify(proof, null, 2));
	if (reopenHistory && phase === "fresh") {
		history = await seedPortableHistory({ directory, bundle: copy, runId });
		assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
		for (const name of ["application-proof.json", "runtime.trace.private.log"]) await rename(join(directory, name), join(directory, "fresh-" + name));
	} else verified = true;
	}
	console.log(JSON.stringify({ portableDesktopSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, installedExecutable: installed, outsideSourceCheckout: true, files: manifest.files.length, closedHistoryReopened: reopenHistory || Boolean(resumed), resumedPhase: resumed?.phase ?? null, applicationRuns: reopenHistory ? 2 : 1, gameCalls: 0, realModelRequests: 0, cleanWindowsVmVerified: false, installerVerified: false }));
} finally {
	// On an unconfirmed exit retain the candidate for diagnosis; never remove a
	// live executable or kill an adopted process to make the test look clean.
	if (!installed && verified && exitConfirmed && remaining === 0) {
		const canonical = await realpath(directory);
		assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-"));
		await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
