import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, readFile, writeFile, lstat, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyBundle, bundleExecutable } from "./desktop-bundle-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length && (args.length !== 2 || args[0] !== "--source")) throw new Error("WINDOWS_PROFILE_LOCK_CHECK_REQUIRED");
const source = args.length ? await realpath(resolve(root, args[1])) : null, manifest = source ? await verifyBundle(source) : null, runId = randomUUID();
const context = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), supervisor = join(context, "supervisor-profile/supervisor"), proofRoot = join(root, ".local/profile-lock", runId);
await mkdir(supervisor, { recursive: true }); await mkdir(proofRoot, { recursive: true });
const packageFile = JSON.parse(await readFile(source ? join(source, "resources/app/package.json") : join(root, "package.json"), "utf8")), appName = packageFile.productName ?? packageFile.name;
await writeFile(join(context, "lock-test.json"), JSON.stringify({ runId, appName }), { flag: "wx" });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ context, source, supervisor, runId }, null, 2), { flag: "wx" });
const electron = join(root, "node_modules/electron/dist/electron.exe"), env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
Object.assign(env, { COMMANDDECK_PROFILE_LOCK_TEST_ROOT: context, COMMANDDECK_PI_CONFIG_DIR: join(context, "no-provider-configuration"), COMMANDDECK_SMOKE_RUN_ID: runId, COMMANDDECK_PORTABLE_ROOT: context, COMMANDDECK_PORTABLE_RUN_ID: runId });
const holder = spawn(electron, [join(root, "test/fixtures/profile-lock-holder.mjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), holderExit = once(holder, "close"); holderExit.catch(() => {});
let holderOutput = ""; holder.stdout.on("data", bytes => holderOutput = (holderOutput + bytes).slice(-16384)); holder.stderr.on("data", bytes => holderOutput = (holderOutput + bytes).slice(-16384));
let stopped = false, passed = false;
try {
	const deadline = performance.now() + 20000; let ownership;
	while (true) { try { ownership = JSON.parse(await readFile(join(context, "holder-ready.json"), "utf8")); break; } catch (error) { if (error.code !== "ENOENT") throw error; assert.equal(holder.exitCode, null); assert.ok(performance.now() < deadline, "PROFILE_LOCK_HOLDER_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50)); } }
	assert.equal(ownership.pid, holder.pid); assert.equal(ownership.runId, runId); assert.equal(ownership.held, true);
	const database = join(supervisor, "game-smoke-" + runId, "game-tasks.sqlite"); await assert.rejects(lstat(database), { code: "ENOENT" });
	let command, commandArgs;
	if (source) { command = join(source, bundleExecutable); commandArgs = ["--portable-smoke"]; }
	else {
		const entry = join(context, "secondary-entry.mjs");
		await writeFile(entry, 'import { app } from "electron";\napp.setName(' + JSON.stringify(appName) + ');\napp.setPath("userData",' + JSON.stringify(join(context, "supervisor-profile")) + ');\nawait import(' + JSON.stringify(pathToFileURL(join(root, "apps/desktop/main.mjs")).href) + ');\n', { flag: "wx" });
		command = electron; commandArgs = [entry, "--smoke"];
	}
	const child = spawn(command, commandArgs, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }), exit = once(child, "exit"), closed = once(child, "close"); closed.catch(() => {});
	let output = "", timedOut = false; child.stdout.on("data", bytes => output = (output + bytes).slice(-16384)); child.stderr.on("data", bytes => output = (output + bytes).slice(-16384));
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000); let code;
	try { [code] = await exit; } finally { clearTimeout(timer); }
	const ledgerCreated = await lstat(database).then(info => info.isFile(), error => { if (error.code === "ENOENT") return false; throw error; });
	assert.equal(holder.exitCode, null);
	await writeFile(join(context, "holder-close.txt"), runId, { flag: "wx" }); const [holderCode] = await holderExit; stopped = true;
	await closed;
	await writeFile(join(proofRoot, "result.private.json"), JSON.stringify({ code, timedOut, ledgerCreated, output, holderOutput, holderCode }, null, 2), { flag: "wx" });
	assert.equal(holderCode, 0); assert.equal(timedOut, false); assert.equal(code, 1); assert.ok(output.includes("SMOKE_INSTANCE_ALREADY_RUNNING")); assert.equal(ledgerCreated, false, "Secondary startup touched the task ledger before rejecting this profile");
	if (source) await verifyBundle(source);
	const proof = { profileLockSmoke: "passed", runId, sourceRevision: manifest?.sourceRevision ?? null, packaged: Boolean(source), actualOsLockHolder: true, secondaryRejectedBeforeLedgerCreation: true, existingProfileLayoutRetained: true, holderNormalExit: true, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/profile-lock-smoke.json"), JSON.stringify(proof, null, 2)); passed = true; console.log(JSON.stringify(proof));
} finally {
	if (!stopped && holder.exitCode === null) { await writeFile(join(context, "holder-close.txt"), runId, { flag: "wx" }).catch(error => { if (error.code !== "EEXIST") throw error; }); await holderExit; }
	if (passed) { const canonical = await realpath(context); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
