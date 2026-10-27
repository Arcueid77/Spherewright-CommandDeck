import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rename, readdir, lstat, rm } from "node:fs/promises";
import { join, resolve, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { verifyBundle, copyBundleTree, bundleExecutable, bundleHash } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";
import { ledgerPresenceConfiguration } from "../apps/desktop/ledger-presence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_LEDGER_EVIDENCE_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source); assert.equal(manifest.profileLedgerPresence, 1, "PROFILE_LEDGER_PRESENCE_UNSUPPORTED_REBUILD_REQUIRED"); assert.equal(manifest.portableStorageFaults, 1);
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), proofRoot = join(root, ".local/packaged-ledger-evidence", runId); await mkdir(proofRoot, { recursive: true });
const caseId = randomUUID(), profile = join(directory, "supervisor-profile/supervisor"), config = ledgerPresenceConfiguration(caseId), game = join(profile, config.stores[0].file), workbench = join(profile, config.stores[1].file), marker = join(profile, config.marker);
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$|PATH$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const env = syntheticMcpEnvironment({ ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, caseId, directory, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
let passed = false; const cases = [];
async function launch(phase, resume, expectedCode) {
	const child = spawn(join(copy, bundleExecutable), ["--portable-smoke", "--portable-storage-fault=receipt", ...(resume ? ["--portable-storage-resume"] : [])], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000); let code, signal;
	try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
	await writeFile(join(proofRoot, phase + "-exit.private.json"), JSON.stringify({ code, signal, timedOut, output }), { flag: "wx" });
	let remaining; const deadline = performance.now() + 25000;
	do {
		const budget = Math.floor(deadline - performance.now()); if (budget <= 0) break;
		const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory], env, timeoutMs: Math.min(20000, budget) });
		await writeFile(join(proofRoot, phase + "-process-observation.private.json"), JSON.stringify(observation)); remaining = observation.count;
		if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < deadline);
	assert.equal(remaining, 0); assert.equal(timedOut, false); assert.equal(code, expectedCode, "LEDGER_EVIDENCE_APPLICATION_" + phase.toUpperCase() + "_FAILED");
}
async function piInventory() {
	const base = join(profile, config.sessions), pending = [base], files = []; let count = 0;
	while (pending.length) {
		const parent = pending.pop();
		for (const name of await readdir(parent)) {
			assert.ok(++count <= 512); const path = join(parent, name), info = await lstat(path); assert.equal(info.isSymbolicLink(), false); assert.equal((await realpath(path)).toLowerCase(), path.toLowerCase());
			if (info.isDirectory()) pending.push(path);
			else { assert.ok(info.isFile() && info.nlink === 1 && info.size <= 8388608); files.push({ path: relative(base, path).replaceAll("\\", "/"), bytes: info.size, sha256: bundleHash(await readFile(path)) }); }
		}
	}
	files.sort((a, b) => a.path.localeCompare(b.path)); assert.ok(files.some(file => file.path.endsWith(".jsonl"))); return files;
}
function gameRows() {
	const db = new DatabaseSync(game, { readOnly: true });
	try { return Object.fromEntries(["game_tasks", "game_intents", "game_gate", "game_task_details", "game_task_events"].map(table => [table, db.prepare("SELECT * FROM " + table + " ORDER BY rowid").all().map(row => ({ ...row }))])); } finally { db.close(); }
}
async function archive(file, phase) {
	const bytes = await readFile(file), destination = join(proofRoot, phase + "-application-proof.json"); await writeFile(destination, bytes, { flag: "wx" }); assert.deepEqual(await readFile(destination), bytes);
	const retained = join(directory, phase + "-application-proof.retained.json"); await assert.rejects(lstat(retained), { code: "ENOENT" }); await rename(file, retained); return JSON.parse(bytes);
}
async function move(from, to) { assert.equal((await realpath(from)).toLowerCase(), from.toLowerCase()); await assert.rejects(lstat(to), { code: "ENOENT" }); await rename(from, to); }
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	await launch("original", false, 0);
	const original = JSON.parse(await readFile(join(directory, "storage-original.private.json"), "utf8")), originalBytes = await readFile(join(directory, "storage-original.private.json")), originalRows = gameRows();
	const originalPi = await piInventory(), originalMarker = await readFile(marker), worldFile = join(directory, "runtime-fixtures/m3-smoke", caseId, "synthetic-research-world.json"), originalWorld = await readFile(worldFile);
	assert.equal(original.task.intent.state, "recorded"); assert.equal(original.task.intent.actionId, null); assert.equal(JSON.parse(originalWorld).commits, 1); assert.equal(JSON.parse(originalWorld).launches, 1);
	await archive(join(directory, "storage-fault-application.json"), "original"); await writeFile(join(proofRoot, "original-rows.private.json"), JSON.stringify(originalRows), { flag: "wx" }); await writeFile(join(proofRoot, "original-pi.private.json"), JSON.stringify(originalPi), { flag: "wx" });
	for (const kind of ["game-missing", "workbench-missing", "game-empty", "guard-corrupt", "guard-and-game-missing"]) {
		const saved = [], placeholders = [], baseline = new Map();
		for (const file of [game, workbench, marker]) baseline.set(file, await readFile(file));
		const selected = kind === "workbench-missing" ? [workbench] : kind === "guard-corrupt" ? [marker] : kind === "guard-and-game-missing" ? [game, marker] : [game];
		for (let index = 0; index < selected.length; index++) { const file = selected[index], retained = join(directory, kind + "-" + index + "-original.retained"); await move(file, retained); saved.push({ file, retained }); }
		if (kind === "game-empty") { await writeFile(game, "", { flag: "wx" }); placeholders.push(game); }
		if (kind === "guard-corrupt") { await writeFile(marker, '{"version":', { flag: "wx" }); placeholders.push(marker); }
		const expectedCode = kind === "guard-corrupt" ? "PROFILE_LEDGER_GUARD_INVALID" : "PROFILE_LEDGER_EVIDENCE_MISSING";
		await writeFile(join(directory, "startup-failure-case.json"), JSON.stringify({ version: 1, runId: caseId, code: expectedCode }));
		await launch(kind + "-blocked", true, 1);
		const blocked = await archive(join(directory, "startup-blocked-proof.json"), kind + "-blocked"); assert.equal(blocked.runId, caseId); assert.equal(blocked.code, expectedCode);
		for (const key of ["visibleBlockedWindow", "rendererNodeDisabled", "noPreloadBridge", "noPageScripts", "profileLockHeld", "usesRequestedPortableProfile"]) assert.equal(blocked[key], true, key); assert.equal(blocked.runtimeStoppedBeforeNotice, false);
		for (const { file, retained } of saved) { assert.deepEqual(await readFile(retained), baseline.get(file)); if (!placeholders.includes(file)) await assert.rejects(lstat(file), { code: "ENOENT" }); }
		for (const [file, bytes] of baseline) if (!selected.includes(file)) assert.deepEqual(await readFile(file), bytes, "UNRELATED_LEDGER_CHANGED_DURING_REJECTION");
		if (kind === "game-empty") assert.equal((await lstat(game)).size, 0); if (kind === "guard-corrupt") assert.equal(await readFile(marker, "utf8"), '{"version":');
		assert.deepEqual(await piInventory(), originalPi); assert.deepEqual(await readFile(worldFile), originalWorld);
		for (let index = 0; index < placeholders.length; index++) await move(placeholders[index], join(directory, kind + "-" + index + "-placeholder.retained"));
		for (const { file, retained } of saved) await move(retained, file);
		await launch(kind + "-restored", true, 0);
		const restored = await archive(join(directory, "storage-resume-application.json"), kind + "-restored"); assert.equal(restored.runId, caseId); assert.equal(restored.sourceRevision, manifest.sourceRevision); assert.equal(restored.unknownActionRemainsBlocked, true); assert.equal(restored.originalRecordsRetainedOnOpen, true); assert.equal(restored.noModelOrCommitReplay, true); assert.equal(restored.syntheticModelRequests, 0); assert.equal(restored.syntheticGameCommits, 1); assert.equal(restored.gameCalls, 0); assert.equal(restored.realModelRequests, 0);
		assert.deepEqual(gameRows(), originalRows); assert.deepEqual(await piInventory(), originalPi); assert.deepEqual(await readFile(marker), originalMarker); assert.deepEqual(await readFile(worldFile), originalWorld); assert.deepEqual(await readFile(join(directory, "storage-original.private.json")), originalBytes);
		cases.push({ kind, rejectedBeforeTaskStores: true, noReplacementLedgerOrInventory: true, independentExitObservedAfterBothRuns: true, originalRowsAndPiUnchanged: true, sameProfileRestored: true, originalUnknownIntentRemainsFrozen: true });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { packagedLedgerEvidenceSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, cases, applicationRuns: 1 + cases.length * 2, syntheticModelRequests: 3, syntheticPrepareCalls: 1, syntheticGameCommits: 1, realModelRequests: 0, gameCalls: 0, originalPendingRecordSha256: bundleHash(Buffer.from(JSON.stringify(originalRows))), bundleUnchanged: true, nativeConfirmationMocked: true, fullProfileMigrationVerified: false, fullRecoveryMatrixVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-ledger-evidence-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedLedgerEvidenceSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: proof.applicationRuns, syntheticGameCommits: 1, gameCalls: 0, realModelRequests: 0 }));
} finally {
	if (passed) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
