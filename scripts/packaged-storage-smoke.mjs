import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { portableStorageScenarios } from "../apps/desktop/portable-mode.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_STORAGE_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.portableStorageFaults, 1, "PACKAGED_STORAGE_MODE_UNSUPPORTED_REBUILD_REQUIRED"); assert.equal(manifest.nativeProcessObserver, 1);
const proofRoot = join(root, ".local/packaged-storage", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(directory); return directory; }
async function agentInventory(base) {
	const pending = [base], files = []; let entries = 0;
	while (pending.length) {
		const parent = pending.pop(); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++entries <= 512); const path = join(parent, name), info = await lstat(path); assert.equal(info.isSymbolicLink(), false);
			if (info.isDirectory()) pending.push(path);
			else { assert.ok(info.isFile() && info.nlink === 1 && info.size <= 8388608); files.push({ path: relative(base, path).replaceAll("\\", "/"), bytes: info.size, sha256: createHash("sha256").update(await readFile(path)).digest("hex") }); }
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path)); assert.ok(files.some(file => file.path.endsWith(".jsonl"))); return files;
}
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const scenario of portableStorageScenarios) {
		const directory = await temporary(), caseId = randomUUID(), evidence = join(proofRoot, scenario); await mkdir(evidence);
		await writeFile(join(evidence, "context.private.json"), JSON.stringify({ runId, caseId, scenario, directory, copy, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		const env = syntheticMcpEnvironment({ ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
		const phaseProofs = []; let beforePi, originalBytes;
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
			assert.equal(proof.syntheticModelRequests, resume ? 0 : 3); assert.equal(proof.syntheticPrepareCalls, 1); assert.equal(proof.syntheticGameCommits, scenario === "before-send" ? 0 : 1); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
			if (!resume) for (const key of ["storageBlocked", "developmentFrozen", "restoredWritabilityDoesNotUnlock", "uiReloadRetainsFreeze", "diagnosticShowsStorageFailure"]) assert.equal(proof[key], true, key);
			else { assert.equal(proof.originalRecordsRetainedOnOpen, true); assert.equal(proof.unknownActionRemainsBlocked, scenario === "receipt"); assert.equal(proof.onlyOriginalAcceptedActionReconciled, scenario === "terminal"); }
			await writeFile(join(evidence, phase + "-application-proof.json"), proofBytes, { flag: "wx" }); phaseProofs.push(proof);
			const pi = await agentInventory(join(directory, "supervisor-profile/supervisor", "game-agent-smoke-" + caseId));
			await writeFile(join(evidence, phase + "-pi-history.private.json"), JSON.stringify(pi), { flag: "wx" });
			if (!resume) { beforePi = pi; originalBytes = await readFile(join(directory, "storage-original.private.json")); await writeFile(join(evidence, "original.private.json"), originalBytes, { flag: "wx" }); }
			else { assert.deepEqual(pi, beforePi, "ORIGINAL_PI_HISTORY_CHANGED_ON_RESUME"); assert.deepEqual(await readFile(join(directory, "storage-original.private.json")), originalBytes); }
		}
		const original = JSON.parse(originalBytes), world = JSON.parse(await readFile(join(directory, "runtime-fixtures/m3-smoke", caseId, "synthetic-research-world.json"), "utf8"));
		assert.equal(world.commits, scenario === "before-send" ? 0 : 1); assert.equal(world.prepares, 1); assert.equal(world.launches, scenario === "terminal" ? 2 : 1); assert.equal(world.resultReads, scenario === "terminal" ? 2 : 0);
		const db = new DatabaseSync(join(directory, "supervisor-profile/supervisor", "game-smoke-" + caseId, "game-tasks.sqlite"), { readOnly: true });
		try {
			const tasks = db.prepare("SELECT id,scope,state FROM game_tasks").all(); assert.equal(tasks.length, 1); assert.equal(tasks[0].id, original.task.id); assert.deepEqual(JSON.parse(tasks[0].scope), original.task.scope);
			assert.equal(tasks[0].state, scenario === "before-send" ? "cancelled" : scenario === "receipt" ? "intent_recorded" : "completed");
			const intents = db.prepare("SELECT * FROM game_intents").all();
			if (scenario === "before-send") assert.deepEqual(intents, []);
			else { assert.equal(intents.length, 1); const intent = intents[0]; assert.equal(intent.id, original.task.intent.intentId); assert.equal(intent.idempotency_key, original.task.intent.idempotencyKey); assert.equal(intent.action_id, original.task.intent.actionId); assert.deepEqual(intent.acceptance ? JSON.parse(intent.acceptance) : null, original.task.intent.acceptance); assert.equal(intent.state, scenario === "receipt" ? "recorded" : "completed"); }
			const events = db.prepare("SELECT sequence,kind,body FROM game_task_events ORDER BY sequence").all().map(({ body, ...value }) => ({ ...value, ...JSON.parse(body) })); assert.deepEqual(events.slice(0, original.events.length), original.events);
		} finally { db.close(); }
		await writeFile(join(evidence, "world.private.json"), JSON.stringify(world), { flag: "wx" });
		cases.push({ storageScenario: scenario, applicationRuns: 2, phases: phaseProofs, independentExitObservedAfterEachRun: true, originalPiHistoryUnchanged: true, durableOriginalVerifiedAfterExit: true, originalRecordSha256: original.sha256 });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { packagedStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, cases, applicationRuns: 6, actualPackagedApplication: true, outsideSourceCheckout: true, developerToolPathExcluded: true, bundleUnchanged: true, fault: "sqlite-query-only", osDiskFullVerified: false, cleanWindowsVmVerified: false, fullRecoveryMatrixVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-storage-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify({ packagedStorageSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: 6, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
