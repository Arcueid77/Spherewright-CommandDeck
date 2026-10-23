import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { seedLegacyRecovery, readLegacyBaseRows } from "./legacy-recovery-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_LEGACY_RECOVERY_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1); assert.ok(manifest.files.some(file => file.path === "resources/app/apps/desktop/portable-recovery.mjs"), "LEGACY_RECOVERY_MODE_UNSUPPORTED_REBUILD_REQUIRED");
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), proofRoot = join(root, ".local/legacy-recovery", runId); await mkdir(proofRoot, { recursive: true });
let passed = false; const phases = [];
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	const seed = await seedLegacyRecovery(directory, runId), before = readLegacyBaseRows(seed.file); assert.equal(before.version, 1); assert.deepEqual(before.rows, seed.rows);
	await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, directory, copy, file: seed.file, sourceRevision: manifest.sourceRevision, legacySourceRevision: seed.expected.legacySourceRevision, legacySourceBlob: seed.expected.legacySourceBlob }), { flag: "wx" });
	for (const phase of ["migrate", "reopen"]) {
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
		const application = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
		assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit); assert.equal(application.legacyPendingRecovery?.originalPendingSha256, seed.expected.sha256); assert.equal(application.pendingDisplayedWithExecutionDisabled, true); assert.equal(application.noProbeAllocated, true); assert.equal(application.syntheticModelRequests, 0); assert.equal(application.syntheticTools, 0); assert.equal(application.gameCalls, 0); assert.equal(application.realModelRequests, 0);
		const actual = readLegacyBaseRows(seed.file); assert.equal(actual.version, 2); assert.deepEqual(actual.rows, before.rows, "Migration/reopen changed an original v1 record");
		await writeFile(join(phaseRoot, "application-proof.json"), JSON.stringify(application), { flag: "wx" });
		phases.push({ phase, schemaVersion: actual.version, samePhysicalProfile: true, originalBaseRowsSha256: bundleHash(Buffer.from(JSON.stringify(actual.rows))), originalPendingSha256: seed.expected.sha256, developmentFrozen: true, noProbeAllocated: true, noPackagedChildrenRemain: true });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { legacyRecoverySmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, legacySourceRevision: seed.expected.legacySourceRevision, legacySourceBlob: seed.expected.legacySourceBlob, actualPackagedApplication: true, outsideSourceCheckout: true, applicationRuns: 2, schemaMigration: "1-to-2", originalPendingRetained: true, developmentFrozenAcrossRestart: true, approvalAndTokenNotReused: true, noModelOrToolReplay: true, phases, bundleUnchanged: true, syntheticModelRequests: 0, gameCalls: 0, realModelRequests: 0, originalActionReconciled: false, fullRecoveryMatrixVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/legacy-recovery-smoke.json"), JSON.stringify(proof, null, 2)); passed = true; console.log(JSON.stringify(proof));
} finally {
	if (passed) { const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
