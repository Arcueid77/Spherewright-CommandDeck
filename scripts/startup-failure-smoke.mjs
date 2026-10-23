import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, realpath, readFile, writeFile, readdir, lstat, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_STARTUP_FAILURE_BUNDLE_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
assert.equal(manifest.nativeProcessObserver, 1);
const proofRoot = join(root, ".local/startup-failure", runId); await mkdir(proofRoot, { recursive: true });
const directories = [], cases = []; let passed = false;
async function temporary() { const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))); directories.push(directory); return directory; }
const copyRoot = await temporary(), copy = join(copyRoot, "bundle");
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const [kind, code] of [["future-schema", "GAME_LEDGER_SCHEMA_UNSUPPORTED"], ["unknown-schema", "GAME_LEDGER_SCHEMA_UNKNOWN"], ["corrupt-ledger", "STARTUP_STORAGE_UNAVAILABLE"], ["malformed-v1", "STARTUP_STORAGE_UNAVAILABLE"]]) {
		const directory = await temporary(), caseId = randomUUID(), profile = join(directory, "supervisor-profile/supervisor"), ledgerRoot = join(profile, "game-smoke-" + caseId), file = join(ledgerRoot, "game-tasks.sqlite");
		await mkdir(ledgerRoot, { recursive: true });
		if (kind === "corrupt-ledger") await writeFile(file, "Synthetic invalid SQLite header; never user data.", { flag: "wx" });
		else {
			const database = new DatabaseSync(file);
			try {
				if (kind === "malformed-v1") database.exec("CREATE TABLE game_tasks(id TEXT PRIMARY KEY,scope TEXT,state TEXT,preview_hash TEXT,preview_boot TEXT,expires_at INTEGER,approval_id TEXT,approval_at INTEGER); CREATE TABLE game_intents(id TEXT PRIMARY KEY,task_id TEXT,idempotency_key TEXT,state TEXT,action_id TEXT,acceptance TEXT); CREATE TABLE game_gate(id INTEGER,intent_id TEXT,reason TEXT); PRAGMA user_version=1;");
				else database.exec(kind === "future-schema" ? "PRAGMA user_version=999;" : "CREATE TABLE synthetic_unknown(value TEXT); INSERT INTO synthetic_unknown VALUES('preserve');");
			} finally { database.close(); }
		}
		const before = await readFile(file), members = await readdir(ledgerRoot);
		await writeFile(join(directory, "startup-failure-case.json"), JSON.stringify({ version: 1, runId: caseId, code }), { flag: "wx" });
		await writeFile(join(proofRoot, kind + "-context.private.json"), JSON.stringify({ caseId, directory, copy, file }), { flag: "wx" });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: caseId, COMMANDDECK_SMOKE_RUN_ID: caseId });
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-8192); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-8192); });
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, 45000);
		let exitCode, signal; try { [exitCode, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
		await writeFile(join(proofRoot, kind + "-exit.private.json"), JSON.stringify({ exitCode, signal, timedOut, output }), { flag: "wx" });
		assert.equal(timedOut, false); assert.equal(exitCode, 1);
		const until = performance.now() + 25000; let remaining;
		do {
			const budget = Math.floor(until - performance.now()); if (budget <= 0) break;
			const observation = await observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory, copy], env, timeoutMs: Math.min(20000, budget) });
			await writeFile(join(proofRoot, kind + "-processes.private.json"), JSON.stringify(observation)); remaining = observation.count;
			if (remaining === 0) break; await new Promise(resolve => setTimeout(resolve, 200));
		} while (performance.now() < until);
		assert.equal(remaining, 0);
		const proof = JSON.parse(await readFile(join(directory, "startup-blocked-proof.json"), "utf8"));
		assert.equal(proof.runId, caseId); assert.equal(proof.code, code); assert.equal(proof.visibleBlockedWindow, true); assert.equal(proof.rendererNodeDisabled, true); assert.equal(proof.noPreloadBridge, true); assert.equal(proof.noPageScripts, true);
		assert.deepEqual(await readFile(file), before); assert.deepEqual(await readdir(ledgerRoot), members);
		await assert.rejects(lstat(join(profile, "m1-smoke-" + caseId)), { code: "ENOENT" });
		const result = { kind, code, visibleBlockedWindow: true, originalLedgerBytesPreserved: true, noLedgerSidecarsAdded: true, noDevelopmentStoreCreated: true, noPackagedChildrenRemain: true, ledgerSha256: bundleHash(before) };
		cases.push(result); await writeFile(join(proofRoot, kind + "-proof.json"), JSON.stringify(result, null, 2), { flag: "wx" });
	}
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { startupFailureSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, outsideSourceCheckout: true, bundleUnchanged: true, cases, gameCalls: 0, realModelRequests: 0, fullRecoveryMatrixVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/startup-failure-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify(proof));
} finally {
	if (passed) for (const directory of directories.reverse()) { const canonical = await realpath(directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
