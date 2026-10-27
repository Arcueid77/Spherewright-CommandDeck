import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile, mkdir, readdir, lstat, rm, rename } from "node:fs/promises";
import { join, resolve, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { verifyBundle, copyBundleTree, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { validateActionUpgradePair, actionUpgradeStages } from "./action-upgrade-state.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 4 || args[0] !== "--baseline" || args[2] !== "--candidate") throw new Error("EXPLICIT_ACTION_UPGRADE_PAIR_REQUIRED");
const paths = { baseline: await realpath(resolve(root, args[1])), candidate: await realpath(resolve(root, args[3])) };
const manifests = { baseline: await verifyBundle(paths.baseline), candidate: await verifyBundle(paths.candidate) }; validateActionUpgradePair(manifests.baseline, manifests.candidate);
const git = (...values) => execFileSync("git", ["-c", "core.fsmonitor=false", ...values], { cwd: root, windowsHide: true, encoding: "utf8", stdio: "pipe" }).trim();
const driverRevision = git("rev-parse", "HEAD"); assert.match(driverRevision, /^[a-f0-9]{40}$/);
function driverUnchanged() { assert.equal(git("rev-parse", "HEAD"), driverRevision); assert.equal(git("status", "--porcelain=v1", "--untracked-files=normal"), "", "ACTION_UPGRADE_REQUIRES_CLEAN_DRIVER"); }
driverUnchanged();
const proofRoot = join(root, ".local/packaged-action-upgrade", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const value = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(value); return value; }
const copiesRoot = await temporary(), copies = { baseline: join(copiesRoot, "baseline"), candidate: join(copiesRoot, "candidate") };
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, driverRevision, paths, copiesRoot, pair: Object.fromEntries(Object.entries(manifests).map(([role, value]) => [role, value.sourceRevision])) }), { flag: "wx" });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function originalPi(directory) {
	const pending = [directory], files = []; let entries = 0;
	while (pending.length) {
		const parent = pending.pop(); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++entries <= 512); const file = join(parent, name), info = await lstat(file); assert.ok(!info.isSymbolicLink());
			if (info.isDirectory()) pending.push(file);
			else { assert.ok(info.isFile() && info.nlink === 1 && info.size <= 8388608); files.push({ path: relative(directory, file).replaceAll("\\", "/"), bytes: info.size, sha256: hash(await readFile(file)) }); }
		}
	}
	assert.ok(files.some(file => file.path.endsWith(".jsonl"))); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
function gameRows(file) {
	const database = new DatabaseSync(file, { readOnly: true });
	try { assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2); return Object.fromEntries(["game_tasks", "game_intents", "game_gate", "game_task_details", "game_task_events"].map(table => [table, database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all().map(row => ({ ...row }))])); }
	finally { database.close(); }
}
try {
	for (const role of ["baseline", "candidate"]) { await copyBundleTree(paths[role], copies[role]); await verifyBundle(copies[role]); }
	for (const scenario of ["terminal", "receipt"]) {
		const directory = await temporary(), caseId = randomUUID(), evidence = join(proofRoot, scenario); await mkdir(evidence);
		await writeFile(join(evidence, "context.private.json"), JSON.stringify({ directory, caseId, scenario }), { flag: "wx" });
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		const env = syntheticMcpEnvironment({ ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
		let original, originalBytes, pi, completedRows; const stages = [];
		for (const stage of actionUpgradeStages(scenario)) {
			driverUnchanged();
			const { phase, role } = stage, argv = stage.ordinary ? ["--portable-smoke"] : ["--portable-smoke", "--portable-storage-fault=" + scenario, ...(stage.resume ? ["--portable-storage-resume"] : [])];
			const child = spawn(join(copies[role], bundleExecutable), argv, { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
			let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
			const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000); let code, signal;
			try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
			await writeFile(join(evidence, phase + "-exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
			let remaining; const deadline = performance.now() + 25000;
			do {
				const budget = Math.floor(deadline - performance.now()); if (budget <= 0) break;
				const observation = await observePackagedProcesses({ executable: join(copies.candidate, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [copiesRoot, directory], env, timeoutMs: Math.min(20000, budget) });
				await writeFile(join(evidence, phase + "-process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count; if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
			} while (performance.now() < deadline);
			assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, 0, "ACTION_UPGRADE_APPLICATION_" + phase.toUpperCase() + "_FAILED");
			const proofFile = join(directory, stage.ordinary ? "application-proof.json" : "storage-" + (stage.resume ? "resume" : "fault") + "-application.json"), proofBytes = await readFile(proofFile), proof = JSON.parse(proofBytes);
			assert.equal(proof.runId, caseId); assert.equal(proof.sourceRevision, manifests[role].sourceRevision); assert.equal(proof.piCommit, manifests[role].piCommit); assert.equal(proof.packaged, true); assert.equal(proof.visibleRenderer, true); assert.equal(proof.rendererNodeDisabled, true); assert.equal(proof.gameCalls, 0); assert.equal(proof.realModelRequests, 0);
			if (stage.ordinary) { assert.equal(proof.syntheticModelRequests, 2); assert.equal(proof.noModelReplay, true); }
			else {
				assert.equal(proof.storageScenario, scenario); assert.equal(proof.phase, stage.resume ? "resume" : "fault"); assert.equal(proof.syntheticFactoryOnly, true); assert.equal(proof.syntheticModelRequests, stage.resume ? 0 : 3); assert.equal(proof.syntheticPrepareCalls, 1); assert.equal(proof.syntheticGameCommits, 1); assert.equal(proof.noModelOrCommitReplay, true); assert.equal(proof.noProbeAllocated, true);
				if (stage.resume) { assert.equal(proof.originalRecordsRetainedOnOpen, true); assert.equal(proof.unknownActionRemainsBlocked, scenario === "receipt"); assert.equal(proof.onlyOriginalAcceptedActionReconciled, scenario === "terminal"); }
				else { assert.equal(proof.storageBlocked, true); assert.equal(proof.developmentFrozen, true); assert.equal(proof.uiReloadRetainsFreeze, true); }
			}
			await writeFile(join(evidence, phase + "-application-proof.private.json"), proofBytes, { flag: "wx" });
			const retainedProof = join(directory, "retained-" + phase + "-" + basename(proofFile)); await assert.rejects(lstat(retainedProof), { code: "ENOENT" }); await rename(proofFile, retainedProof);
			const rows = gameRows(join(directory, "supervisor-profile/supervisor/game-smoke-" + caseId, "game-tasks.sqlite")), currentPi = await originalPi(join(directory, "supervisor-profile/supervisor/game-agent-smoke-" + caseId));
			if (phase === "fault") { originalBytes = await readFile(join(directory, "storage-original.private.json")); original = JSON.parse(originalBytes); pi = currentPi; await writeFile(join(evidence, "original.private.json"), originalBytes, { flag: "wx" }); }
			else { assert.deepEqual(currentPi, pi, "ACTION_UPGRADE_ORIGINAL_PI_CHANGED"); assert.deepEqual(await readFile(join(directory, "storage-original.private.json")), originalBytes); }
			assert.equal(rows.game_tasks.length, 1); assert.equal(rows.game_intents.length, 1); const task = rows.game_tasks[0], intent = rows.game_intents[0], expected = original.task.intent;
			assert.equal(task.id, original.task.id); assert.deepEqual(JSON.parse(task.scope), original.task.scope); assert.equal(intent.id, expected.intentId); assert.equal(intent.task_id, task.id); assert.equal(intent.idempotency_key, expected.idempotencyKey); assert.equal(intent.action_id, expected.actionId); assert.deepEqual(intent.acceptance ? JSON.parse(intent.acceptance) : null, expected.acceptance); assert.deepEqual(rows.game_gate, []);
			assert.equal(task.state, scenario === "receipt" ? "intent_recorded" : phase === "fault" ? "accepted" : "completed"); assert.equal(intent.state, scenario === "receipt" ? "recorded" : phase === "fault" ? "accepted" : "completed");
			const events = rows.game_task_events.map(({ sequence, kind, body }) => ({ sequence, kind, ...JSON.parse(body) })); assert.deepEqual(events.slice(0, original.events.length), original.events);
			if (scenario === "terminal" && phase !== "fault") { assert.deepEqual(JSON.parse(intent.terminal).afterQueue, [99, 100]); if (completedRows) assert.deepEqual(rows, completedRows, "ACTION_UPGRADE_CLOSED_RECEIPT_CHANGED"); else completedRows = rows; }
			else if (scenario === "receipt") { assert.equal(intent.terminal, null); if (phase === "fault") completedRows = rows; else assert.deepEqual(rows, completedRows, "ACTION_UPGRADE_UNKNOWN_RECORD_CHANGED"); }
			const worldBytes = await readFile(join(directory, "runtime-fixtures/m3-smoke", caseId, "synthetic-research-world.json")), world = JSON.parse(worldBytes);
			assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.launches, scenario === "terminal" && phase !== "fault" ? 2 : 1); assert.equal(world.resultReads, scenario === "terminal" ? phase === "fault" ? 1 : 2 : 0); assert.equal(world.key, expected.idempotencyKey);
			await writeFile(join(evidence, phase + "-database.private.json"), JSON.stringify(rows), { flag: "wx" }); await writeFile(join(evidence, phase + "-world.private.json"), worldBytes, { flag: "wx" }); await writeFile(join(evidence, phase + "-pi.private.json"), JSON.stringify(currentPi), { flag: "wx" });
			stages.push({ phase, role, sourceRevision: manifests[role].sourceRevision, independentExitObserved: true, originalTaskAndKeyRetained: true, originalAcceptanceRetained: true, originalGameAgentPiUnchanged: true, syntheticModelRequests: proof.syntheticModelRequests, preparesAcrossAllStarts: world.prepares, commitsAcrossAllStarts: world.commits, originalActionResultReads: world.resultReads, unresolved: scenario === "receipt" });
		}
		cases.push({ scenario, stages, applicationRuns: stages.length, onlyOriginalActionReconciled: scenario === "terminal", ordinaryReopenRetainsClosedReceipt: scenario === "terminal", lostPersistedReceiptStaysBlockedThroughRollback: scenario === "receipt" });
	}
	for (const role of ["baseline", "candidate"]) { await verifyBundle(copies[role]); await verifyBundle(paths[role]); } driverUnchanged();
	const proof = { packagedActionUpgradeSmoke: "passed", runId, driverRevision, baselineRevision: manifests.baseline.sourceRevision, candidateRevision: manifests.candidate.sourceRevision, piCommit: manifests.candidate.piCommit, applicationRuns: 6, cases, actualPackagedApplications: true, outsideSourceCheckout: true, unchangedSyntheticServiceProtocol: true, unchangedSourceAndCopiedBundles: true, nativeConfirmationMocked: true, physicalInputVerified: false, semanticReleaseUpgradeVerified: false, realGameRestartVerified: false, fullRecoveryMatrixVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-action-upgrade-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedActionUpgradeSmoke: "passed", runId, driverRevision, baselineRevision: proof.baselineRevision, candidateRevision: proof.candidateRevision, applicationRuns: 6, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
