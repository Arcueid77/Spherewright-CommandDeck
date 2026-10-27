import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, rename, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { seedLegacyRecovery, readLegacyBaseRows } from "./legacy-recovery-fixture.mjs";
import { seedFullProfileHistory, readProfileWorkbenchRows } from "./full-profile-fixture.mjs";
import { portableProfileFile, profileHash, inventoryProfilePi } from "../apps/desktop/portable-profile.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), rawArgs = process.argv.slice(2), fullProfile = rawArgs.includes("--full-profile"), args = rawArgs.filter(arg => arg !== "--full-profile");
if (rawArgs.length !== (fullProfile ? 3 : 2)) throw new Error("EXPLICIT_WINDOWS_LEGACY_RECOVERY_BUNDLE_REQUIRED");
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_LEGACY_RECOVERY_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1); assert.ok(manifest.files.some(file => file.path === "resources/app/apps/desktop/portable-recovery.mjs"), "LEGACY_RECOVERY_MODE_UNSUPPORTED_REBUILD_REQUIRED");
if (fullProfile) assert.equal(manifest.portableFullProfile, 1, "FULL_PROFILE_MODE_UNSUPPORTED_REBUILD_REQUIRED");
const controllerRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true }).trim(); assert.match(controllerRevision, /^[a-f0-9]{40}$/);
const resultName = fullProfile ? "full-profile-migration" : "legacy-recovery";
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), proofRoot = join(root, ".local", resultName, runId); await mkdir(proofRoot, { recursive: true });
let passed = false; const phases = [];
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	let seed, before, fullSeed;
	if (fullProfile) await writeFile(join(directory, portableProfileFile), JSON.stringify({ version: 1, kind: "synthetic-full-profile-migration", runId, phase: "bootstrap" }), { flag: "wx" });
	else { seed = await seedLegacyRecovery(directory, runId); before = readLegacyBaseRows(seed.file); assert.equal(before.version, 1); assert.deepEqual(before.rows, seed.rows); }
	await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, directory, copy, sourceRevision: manifest.sourceRevision, controllerRevision, fullProfile }), { flag: "wx" });
	for (const phase of fullProfile ? ["bootstrap", "migrate", "reopen"] : ["migrate", "reopen"]) {
		const phaseRoot = join(proofRoot, phase); await mkdir(phaseRoot);
		if (phase === "reopen") {
			const original = join(directory, "application-proof.json"); assert.equal((await realpath(original)).toLowerCase(), original.toLowerCase());
			await rename(original, join(directory, "migration-application-proof.json"));
		}
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId, COMMANDDECK_SMOKE_RUN_ID: runId });
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
		let code, signal; try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
		await writeFile(join(phaseRoot, "exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
		let remaining; const until = performance.now() + 25000;
		do {
			const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
			const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory], env, timeoutMs: Math.min(20000, budget) });
			await writeFile(join(phaseRoot, "process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count; if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
		} while (performance.now() < until);
		assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
		const applicationBytes = await readFile(join(directory, "application-proof.json")), application = JSON.parse(applicationBytes);
		assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit); assert.equal(application.gameCalls, 0); assert.equal(application.realModelRequests, 0);
		if (phase === "bootstrap") {
			assert.equal(application.emptyIsolatedWorkspace, true); assert.equal(application.syntheticModelRequests, 2); assert.equal(application.fullProfileBootstrap?.nativeCiphertextCreated, true); assert.equal(application.fullProfileBootstrap.realRendererLayoutPersisted, true);
			await writeFile(join(phaseRoot, "application-proof.private.json"), applicationBytes, { flag: "wx" });
			await rename(join(directory, "application-proof.json"), join(directory, "bootstrap-application-proof.retained.json"));
			fullSeed = await seedFullProfileHistory({ context: { root: directory, runId }, applicationRoot: join(copy, "resources/app"), bootstrap: application }); seed = fullSeed.legacy;
			before = readLegacyBaseRows(seed.file); assert.equal(before.version, 1); assert.deepEqual(before.rows, seed.rows);
			await writeFile(join(proofRoot, "original-profile.private.json"), JSON.stringify(fullSeed), { flag: "wx" });
			phases.push({ phase, independentExitObserved: true, actualProtectedVaultCreated: true, actualRendererLayoutCaptured: true, syntheticModelRequests: 2, originalProfileSha256: fullSeed.caseValue.sha256 });
			continue;
		}
		for (const stage of ["before-reload", "after-reload"]) {
			const file = join(directory, `legacy-recovery-ui-${child.pid}-${stage}.private.json`), info = await lstat(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 65536);
			const bytes = await readFile(file), diagnostic = JSON.parse(bytes); assert.equal(diagnostic.phase, stage); assert.equal(diagnostic.completed, true); assert.equal(diagnostic.activatedAfterLayoutReady, true); assert.equal(diagnostic.ui.panelPresent, true); assert.ok(diagnostic.ui.stage.includes("等待核销") && diagnostic.ui.stage.includes("冻结")); assert.ok(diagnostic.ui.receipts.some(text => text.includes(seed.expected.intent.actionId))); assert.deepEqual(diagnostic.renderer.errors, []);
			await writeFile(join(phaseRoot, `ui-${stage}.private.json`), bytes, { flag: "wx" });
		}
		assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit); assert.equal(application.legacyPendingRecovery?.originalPendingSha256, seed.expected.sha256); assert.equal(application.pendingDisplayedWithNewExecutionDisabled, true); assert.equal(application.originalActionQueryEntryRetained, true); assert.equal(application.layoutReadyBeforePanelActivation, true); assert.equal(application.noProbeAllocated, true); assert.equal(application.syntheticModelRequests, 0); assert.equal(application.syntheticTools, 0); assert.equal(application.gameCalls, 0); assert.equal(application.realModelRequests, 0);
		const actual = readLegacyBaseRows(seed.file); assert.equal(actual.version, 2); assert.deepEqual(actual.rows, before.rows, "Migration/reopen changed an original v1 record");
		if (fullProfile) {
			const full = application.fullProfileMigration; assert.equal(full?.expectedProfileSha256, fullSeed.caseValue.sha256); assert.equal(full.nativeVaultDecrypted, true); assert.equal(full.ciphertextPreserved, true); assert.equal(full.completePiFileSetPreserved, true);
			assert.deepEqual(await inventoryProfilePi({ root: directory, runId }), fullSeed.caseValue.expected.pi);
			assert.deepEqual(readProfileWorkbenchRows(join(directory, "supervisor-profile/supervisor/m1-smoke-" + runId, "workbench.sqlite")), fullSeed.workbenchRows, "FULL_PROFILE_ORIGINAL_WORKBENCH_RECORD_CHANGED");
			assert.equal(profileHash(await readFile(fullSeed.workspaceFile)), fullSeed.workspaceSha256, "FULL_PROFILE_UNSENT_EDITOR_WAS_WRITTEN_TO_DISK");
			assert.equal(application.legacyPendingRecovery.profile.developmentTasks, 2); assert.equal(application.legacyPendingRecovery.profile.invocations, 1); assert.equal(application.legacyPendingRecovery.profile.changes, 1); assert.equal(application.legacyPendingRecovery.profile.references, 1);
		}
		await writeFile(join(phaseRoot, "application-proof.json"), JSON.stringify(application), { flag: "wx" });
		phases.push({ phase, schemaVersion: actual.version, samePhysicalProfile: true, originalBaseRowsSha256: bundleHash(Buffer.from(JSON.stringify(actual.rows))), originalPendingSha256: seed.expected.sha256, developmentFrozen: true, noProbeAllocated: true, noPackagedChildrenRemain: true });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { [fullProfile ? "fullProfileMigrationSmoke" : "legacyRecoverySmoke"]: "passed", runId, sourceRevision: manifest.sourceRevision, controllerRevision, piCommit: manifest.piCommit, legacySourceRevision: seed.expected.legacySourceRevision, legacySourceBlob: seed.expected.legacySourceBlob, actualPackagedApplication: true, outsideSourceCheckout: true, applicationRuns: fullProfile ? 3 : 2, schemaMigration: "1-to-2", originalPendingRetained: true, developmentFrozenAcrossRestart: true, approvalAndTokenNotReused: true, noModelOrToolReplay: true, phases, ...(fullProfile ? { compositeSyntheticProfile: true, allOriginalWorkbenchRecordsRetained: true, uiValuesComparedAsStructuredJson: true, unsentEditorNotWrittenToDisk: true, nativeProtectedVaultRetainedAndDecrypted: true, allThreePiNamespacesRetained: true, profileSha256: fullSeed.caseValue.sha256 } : {}), bundleUnchanged: true, syntheticModelRequests: fullProfile ? 2 : 0, gameCalls: 0, realModelRequests: 0, originalActionReconciled: false, fullRecoveryMatrixVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local", resultName + "-smoke.json"), JSON.stringify(proof, null, 2)); passed = true; console.log(JSON.stringify({ [fullProfile ? "fullProfileMigrationSmoke" : "legacyRecoverySmoke"]: "passed", runId, sourceRevision: manifest.sourceRevision, controllerRevision, applicationRuns: proof.applicationRuns, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) { const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
