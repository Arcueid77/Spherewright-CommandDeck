import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { portableStorageScenarios, runtimeStorageScenarios, storageFaultBoundary } from "../apps/desktop/portable-mode.mjs";
import { usageRecoveryState } from "./model-usage-recovery-state.mjs";
import { readGit } from "../apps/desktop/workspace.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_STORAGE_BUNDLE_REQUIRED");
const controllerRevision = (await readGit(root, ["rev-parse", "HEAD"])).trim(), controllerFile = fileURLToPath(import.meta.url);
const controllerHash = async () => createHash("sha256").update(await readFile(controllerFile)).digest("hex"), controllerSha256 = await controllerHash();
assert.equal((await readGit(root, ["status", "--porcelain"])).trim(), "", "STORAGE_CONTROLLER_REQUIRES_CLEAN_SOURCE");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.portableStorageFaults, 1, "PACKAGED_STORAGE_MODE_UNSUPPORTED_REBUILD_REQUIRED"); assert.equal(manifest.nativeProcessObserver, 1);
assert.equal(manifest.portableRuntimeStorageFaults, 1, "PACKAGED_RUNTIME_STORAGE_MODE_UNSUPPORTED_REBUILD_REQUIRED");
const proofRoot = join(root, ".local/packaged-storage", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(directory); return directory; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const scenario of portableStorageScenarios) {
		const boundary = storageFaultBoundary(scenario), runtimeLoss = runtimeStorageScenarios.includes(scenario);
		const directory = await temporary(), caseId = randomUUID(), evidence = join(proofRoot, scenario); await mkdir(evidence);
		await writeFile(join(evidence, "context.private.json"), JSON.stringify({ runId, caseId, scenario, directory, copy, sourceRevision: manifest.sourceRevision, controllerRevision, controllerSha256 }), { flag: "wx" });
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		const env = syntheticMcpEnvironment({ ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
		const phaseProofs = []; let beforeState, originalBytes;
		for (const resume of [false, true]) {
			const phase = resume ? "resume" : "fault", child = spawn(join(copy, bundleExecutable), ["--portable-smoke", "--portable-storage-fault=" + scenario, ...(resume ? ["--portable-storage-resume"] : [])], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
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
			assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, 0, "STORAGE_APPLICATION_" + phase.toUpperCase() + "_FAILED");
			const proofBytes = await readFile(join(directory, "storage-" + phase + "-application.json")), proof = JSON.parse(proofBytes);
			assert.equal(proof.runId, caseId); assert.equal(proof.storageScenario, scenario); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit);
			for (const key of ["packaged", "visibleRenderer", "rendererNodeDisabled", "syntheticFactoryOnly", "noModelOrCommitReplay", "noProbeAllocated"]) assert.equal(proof[key], true, key);
			assert.equal(proof.syntheticModelRequests, resume ? 0 : 3); assert.equal(proof.syntheticPrepareCalls, 1); assert.equal(proof.syntheticGameCommits, boundary === "before-send" ? 0 : 1); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
			if (!resume) for (const key of ["storageBlocked", "developmentFrozen", "restoredWritabilityDoesNotUnlock", "uiReloadRetainsFreeze", "diagnosticShowsStorageFailure"]) assert.equal(proof[key], true, key);
			else { assert.equal(proof.originalRecordsRetainedOnOpen, true); assert.equal(proof.unknownActionRemainsBlocked, boundary === "receipt"); assert.equal(proof.onlyOriginalAcceptedActionReconciled, boundary === "terminal"); }
			if (runtimeLoss && !resume) { for (const key of ["runtimeExitObserved", "runtimeExitedBeforeStorageAttempt", "originalDurableIntentRetained", "noRuntimeRestart"]) assert.equal(proof[key], true, key); assert.equal(proof.runtimeExitBoundary, boundary); }
			if (runtimeLoss && resume) { assert.equal(proof.originalRuntimeLoss, true); assert.equal(proof.newApplicationRuntimeAvailable, true); }
			await writeFile(join(evidence, phase + "-application-proof.json"), proofBytes, { flag: "wx" }); phaseProofs.push(proof);
			const state = await usageRecoveryState(directory, caseId);
			await writeFile(join(evidence, phase + "-state.private.json"), JSON.stringify(state), { flag: "wx" });
			await writeFile(join(evidence, phase + "-pi-history.private.json"), JSON.stringify(state.pi), { flag: "wx" });
			if (!resume) { beforeState = state; originalBytes = await readFile(join(directory, "storage-original.private.json")); await writeFile(join(evidence, "original.private.json"), originalBytes, { flag: "wx" }); }
			else {
				assert.deepEqual(state.pi, beforeState.pi, "ORIGINAL_PI_HISTORY_CHANGED_ON_RESUME"); assert.deepEqual(state.vault, beforeState.vault, "ORIGINAL_VAULT_CHANGED_ON_RESUME");
				assert.deepEqual(state.rows.game_task_details, beforeState.rows.game_task_details, "ORIGINAL_TASK_DETAILS_CHANGED_ON_RESUME");
				if (boundary === "receipt") assert.deepEqual(state, beforeState, "ORIGINAL_STORAGE_STATE_CHANGED_ON_RESUME");
				if (boundary === "before-send") {
					assert.equal(beforeState.rows.game_tasks.length, 1); assert.equal(beforeState.rows.game_tasks[0].state, "awaiting_approval"); assert.deepEqual(beforeState.rows.game_intents, []);
					const cancelled = structuredClone(beforeState); cancelled.rows.game_tasks[0].state = "cancelled";
					assert.deepEqual(state, cancelled, "UNCOMMITTED_TASK_CLOSE_CHANGED_MORE_THAN_CANCELLATION");
				}
				assert.deepEqual(await readFile(join(directory, "storage-original.private.json")), originalBytes);
			}
		}
		const original = JSON.parse(originalBytes), world = JSON.parse(await readFile(join(directory, "runtime-fixtures/m3-smoke", caseId, "synthetic-research-world.json"), "utf8"));
		assert.equal(world.commits, boundary === "before-send" ? 0 : 1); assert.equal(world.prepares, 1); assert.equal(world.launches, boundary === "terminal" ? 2 : 1); assert.equal(world.resultReads, boundary === "terminal" ? 2 : 0);
		const db = new DatabaseSync(join(directory, "supervisor-profile/supervisor", "game-smoke-" + caseId, "game-tasks.sqlite"), { readOnly: true });
		try {
			const tasks = db.prepare("SELECT id,scope,state FROM game_tasks").all(); assert.equal(tasks.length, 1); assert.equal(tasks[0].id, original.task.id); assert.deepEqual(JSON.parse(tasks[0].scope), original.task.scope);
			assert.equal(tasks[0].state, boundary === "before-send" ? "cancelled" : boundary === "receipt" ? "intent_recorded" : "completed");
			const intents = db.prepare("SELECT * FROM game_intents").all();
			if (boundary === "before-send") assert.deepEqual(intents, []);
			else { assert.equal(intents.length, 1); const intent = intents[0]; assert.equal(intent.id, original.task.intent.intentId); assert.equal(intent.idempotency_key, original.task.intent.idempotencyKey); assert.equal(intent.action_id, original.task.intent.actionId); assert.deepEqual(intent.acceptance ? JSON.parse(intent.acceptance) : null, original.task.intent.acceptance); assert.equal(intent.state, boundary === "receipt" ? "recorded" : "completed"); }
			const events = db.prepare("SELECT sequence,kind,body FROM game_task_events ORDER BY sequence").all().map(({ body, ...value }) => ({ ...value, ...JSON.parse(body) })); assert.deepEqual(events.slice(0, original.events.length), original.events);
		} finally { db.close(); }
		await writeFile(join(evidence, "world.private.json"), JSON.stringify(world), { flag: "wx" });
		cases.push({ storageScenario: scenario, applicationRuns: 2, phases: phaseProofs, independentExitObservedAfterEachRun: true, originalPiHistoryUnchanged: true, durableOriginalVerifiedAfterExit: true, originalRecordSha256: original.sha256 });
	}
	await verifyBundle(copy); await verifyBundle(source);
	assert.equal((await readGit(root, ["rev-parse", "HEAD"])).trim(), controllerRevision); assert.equal(await controllerHash(), controllerSha256);
	const proof = { packagedStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, controllerRevision, controllerSha256, piCommit: manifest.piCommit, cases, applicationRuns: cases.reduce((sum, value) => sum + value.applicationRuns, 0), actualPackagedApplication: true, outsideSourceCheckout: true, developerToolPathExcluded: true, bundleUnchanged: true, fault: "sqlite-query-only", osDiskFullVerified: false, cleanWindowsVmVerified: false, fullRecoveryMatrixVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-storage-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify({ packagedStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: proof.applicationRuns, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
