import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, rename, lstat, readdir, open } from "node:fs/promises";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { seedLegacyRecovery, readLegacyBaseRows } from "./legacy-recovery-fixture.mjs";
import { seedPortableHistory } from "./portable-history-fixture.mjs";
import { assertOwnedReadonlyFile, denyOwnedFileWrites, restoreOwnedFileWrites } from "./readonly-storage-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_OS_STORAGE_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.writableLedgerStartup, 1, "PACKAGED_OS_STORAGE_MODE_UNSUPPORTED_REBUILD_REQUIRED");
assert.equal(manifest.nativeProcessObserver, 1); assert.ok(manifest.files.some(file => file.path === "resources/app/apps/desktop/startup-blocked.mjs")); assert.ok(manifest.files.some(file => file.path === "resources/app/apps/desktop/portable-recovery.mjs"));
const proofRoot = join(root, ".local/packaged-os-storage", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(directory); return directory; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, copyRoot, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const kind of ["legacy-game", "workbench-history"]) {
		const directory = await temporary(), caseId = randomUUID(), evidence = join(proofRoot, kind); await mkdir(evidence);
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$|PATH$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId, COMMANDDECK_SMOKE_RUN_ID: caseId });
		let exited = true, selectedFile, originalMode, legacy, history; const stages = [];
		async function launch(phase, expectedCode) {
			exited = false;
			const child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
			const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000); let code, signal;
			try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
			await writeFile(join(evidence, phase + "-exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
			let remaining; const deadline = performance.now() + 25000;
			do {
				const budget = Math.floor(deadline - performance.now()); if (budget <= 0) break;
				const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copyRoot], env, timeoutMs: Math.min(20000, budget) });
				await writeFile(join(evidence, phase + "-process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
				if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
			} while (performance.now() < deadline);
			assert.equal(remaining, 0); exited = true; assert.equal(timedOut, false); assert.equal(code, expectedCode, "OS_STORAGE_APPLICATION_" + phase.toUpperCase() + "_FAILED");
		}
		try {
			if (kind === "legacy-game") { legacy = await seedLegacyRecovery(directory, caseId); selectedFile = legacy.file; }
			else {
				await launch("fresh", 0);
				const initial = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8")); assert.equal(initial.runId, caseId); assert.equal(initial.emptyIsolatedWorkspace, true); assert.equal(initial.gameCalls, 0); assert.equal(initial.realModelRequests, 0); assert.equal(initial.syntheticModelRequests, 2);
				history = await seedPortableHistory({ directory, bundle: copy, runId: caseId });
				await rename(join(directory, "application-proof.json"), join(evidence, "fresh-application-proof.json"));
				selectedFile = join(directory, "supervisor-profile/supervisor", "m1-smoke-" + caseId, "workbench.sqlite"); stages.push({ phase: "fresh", independentExitObserved: true });
			}
			await writeFile(join(evidence, "context.private.json"), JSON.stringify({ runId, caseId, kind, directory, selectedFile, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
			const before = await readFile(selectedFile), originalMembers = await readdir(dirname(selectedFile));
			originalMode = await denyOwnedFileWrites({ root: directory, file: selectedFile });
			const denied = await assertOwnedReadonlyFile({ root: directory, file: selectedFile }); assert.deepEqual(await readFile(selectedFile), before);
			await writeFile(join(evidence, "os-denial.json"), JSON.stringify(denied), { flag: "wx" });
			await writeFile(join(directory, "startup-failure-case.json"), JSON.stringify({ version: 1, runId: caseId, code: "STARTUP_STORAGE_UNAVAILABLE" }), { flag: "wx" });
			for (const phase of ["blocked", "blocked-reopen"]) {
				await launch(phase, 1);
				const proofBytes = await readFile(join(directory, "startup-blocked-proof.json")), proof = JSON.parse(proofBytes);
				assert.equal(proof.runId, caseId); assert.equal(proof.code, "STARTUP_STORAGE_UNAVAILABLE");
				for (const key of ["visibleBlockedWindow", "rendererNodeDisabled", "noPreloadBridge", "noPageScripts", "profileLockHeld", "usesRequestedPortableProfile"]) assert.equal(proof[key], true, key);
				if (kind === "workbench-history") assert.equal(proof.runtimeStoppedBeforeNotice, true);
				assert.deepEqual(await readFile(selectedFile), before, "READONLY_LEDGER_BYTES_CHANGED");
				const members = await readdir(dirname(selectedFile)); assert.ok(members.every(name => originalMembers.includes(name) || [basename(selectedFile) + "-wal", basename(selectedFile) + "-shm"].includes(name)), "UNEXPECTED_LEDGER_CREATED");
				if (legacy) { const actual = readLegacyBaseRows(selectedFile); assert.equal(actual.version, 1); assert.deepEqual(actual.rows, legacy.rows); await assert.rejects(lstat(join(directory, "supervisor-profile/supervisor", "m1-smoke-" + caseId)), { code: "ENOENT" }); }
				await writeFile(join(evidence, phase + "-application-proof.json"), proofBytes, { flag: "wx" }); await rename(join(directory, "startup-blocked-proof.json"), join(directory, phase + "-proof.retained.json"));
				stages.push({ phase, blocked: true, independentExitObserved: true, originalLedgerSha256: bundleHash(before), originalLedgerBytesPreserved: true, ledgerMembers: members.map(name => name === basename(selectedFile) ? "database" : name.endsWith("-wal") ? "wal" : "shm") });
			}
			await restoreOwnedFileWrites({ root: directory, file: selectedFile, mode: originalMode }); originalMode = undefined;
			const writable = await open(selectedFile, "r+"); await writable.close(); assert.deepEqual(await readFile(selectedFile), before);
			await launch("restored", 0);
			const proofBytes = await readFile(join(directory, "application-proof.json")), proof = JSON.parse(proofBytes);
			assert.equal(proof.runId, caseId); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
			if (legacy) {
				const actual = readLegacyBaseRows(selectedFile); assert.equal(actual.version, 2); assert.deepEqual(actual.rows, legacy.rows);
				assert.equal(proof.legacyPendingRecovery.originalPendingSha256, legacy.expected.sha256); assert.equal(proof.pendingDisplayedWithNewExecutionDisabled, true); assert.equal(proof.originalActionQueryEntryRetained, true); assert.equal(proof.noProbeAllocated, true); assert.equal(proof.syntheticModelRequests, 0); assert.equal(proof.syntheticTools, 0);
			} else { assert.equal(proof.closedHistoryReopened, true); assert.equal(proof.history.closedHistorySha256, history.sha256); assert.equal(proof.noModelReplay, true); assert.equal(proof.syntheticModelRequests, 2); }
			await writeFile(join(evidence, "restored-application-proof.json"), proofBytes, { flag: "wx" });
			stages.push({ phase: "restored", independentExitObserved: true, writeAccessRestored: true, samePhysicalProfile: true, originalHistoryPreserved: true, originalPendingRemainsFrozen: Boolean(legacy) });
			cases.push({ kind, applicationRuns: stages.length, stages, actualOsWriteDenied: true, sqliteReadOnlyObserved: true, repeatedDeniedStartup: true, noAlternateProfile: true, noAutomaticTaskReplay: true, syntheticModelRequests: history ? 4 : 0, originalPendingReconciled: false });
		} finally {
			// Never make a file writable under an application whose exit is unknown.
			if (selectedFile && originalMode !== undefined && exited) await restoreOwnedFileWrites({ root: directory, file: selectedFile, mode: originalMode });
		}
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { packagedOsStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, fault: "windows-readonly-file-attribute", cases, applicationRuns: cases.reduce((count, value) => count + value.applicationRuns, 0), actualPackagedApplication: true, outsideSourceCheckout: true, developerToolsExcludedFromApplicationPath: true, bundleUnchanged: true, osDiskFullVerified: false, aclDenialVerified: false, fullProfileMigrationVerified: false, fullRecoveryMatrixVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-os-storage-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedOsStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: proof.applicationRuns, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
