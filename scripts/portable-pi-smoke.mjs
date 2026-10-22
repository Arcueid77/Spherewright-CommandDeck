import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, writeFile, realpath, rm } from "node:fs/promises";
import { dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { readGit } from "../apps/desktop/workspace.mjs";
import { materializePiRuntime } from "./pi-runtime-tree.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), pin = "71023aec1546d6d677a65669c5665c0927ce0dd0";
const args = process.argv.slice(2);
if (process.platform !== "win32" || args.some(arg => arg !== "--require-clean-source") || args.length > 1) throw new Error("WINDOWS_PORTABLE_PI_SMOKE_REQUIRED");
const revision = (await readGit(root, ["rev-parse", "HEAD"])).trim(), status = await readGit(root, ["status", "--porcelain"]);
if (args.includes("--require-clean-source") && status.trim()) throw new Error("PORTABLE_PI_REQUIRES_CLEAN_SOURCE");
assert.equal((await readGit(join(root, "vendor/pi"), ["rev-parse", "HEAD"])).trim(), pin);
assert.equal((await readGit(join(root, "vendor/pi"), ["status", "--porcelain"])).trim(), "");
const directory = await mkdtemp(join(tmpdir(), "commanddeck-portable-pi-")), runId = randomUUID();
let child;
try {
	const sourceDistance = relative(await realpath(root), await realpath(directory));
	assert.ok(isAbsolute(sourceDistance) || sourceDistance === ".." || sourceDistance.startsWith(".." + sep), "Portable fixture must be outside the checkout");
	const tree = join(directory, "vendor/pi"); await mkdir(dirname(tree), { recursive: true });
	const inventory = await materializePiRuntime(join(root, "vendor/pi"), tree);
	const app = join(directory, "apps/desktop"); await mkdir(app, { recursive: true });
	const appFiles = [];
	for (const file of (await readdir(join(root, "apps/desktop"))).filter(name => /\.(?:mjs|cjs)$/.test(name)).sort()) {
		const bytes = await readFile(join(root, "apps/desktop", file));
		await writeFile(join(app, file), bytes, { flag: "wx" });
		appFiles.push({ path: file, sha256: createHash("sha256").update(bytes).digest("hex") });
	}
	// The temporary tree has no source-checkout ancestor, links, Git, dev tools on
	// PATH, external Node module search path or user model/provider configuration.
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
	Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-runtime"), DOTNET_ROOT_X64: join(directory, "no-runtime") });
	child = spawn(process.execPath, ["--no-global-search-paths", join(app, "runtime.mjs"), "--offline"], { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "", timedOut = false;
	child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65536) child.kill(); });
	child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16384); });
	const timer = setTimeout(() => { timedOut = true; child.kill(); }, 30000);
	let code, signal;
	try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
	assert.equal(timedOut, false); assert.equal(code, 0, "Portable SDK process failed: " + (signal ?? stderr));
	const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
	assert.equal(result.sourceCommit, pin); assert.equal(result.requestCount, 2); assert.equal(result.executed, 1); assert.equal(result.gameCalls, 0);
	assert.deepEqual(result.active, ["deck_echo"]); assert.deepEqual(result.callable, ["deck_echo"]);
	assert.equal((await readGit(root, ["rev-parse", "HEAD"])).trim(), revision);
	assert.equal(await readGit(root, ["status", "--porcelain"]), status);
	const proof = { runId, sourceRevision: revision, cleanSource: !status.trim(), piCommit: pin, packages: inventory.packages, fileCount: inventory.files.length, bytes: inventory.bytes, applicationFiles: appFiles, inventorySha256: createHash("sha256").update(JSON.stringify(inventory.files)).digest("hex"), outsideSourceCheckout: true, linksShipped: 0, developerToolsAbsentFromPath: true, globalNodeSearchDisabled: true, hostNodeUsedAsTestRunner: true, sourceCheckoutRequiredAtRuntime: false, syntheticModelRequests: result.requestCount, syntheticTools: result.executed, realModelRequests: 0, gameCalls: 0, fullElectronBundleVerified: false, cleanWindowsVmVerified: false };
	const output = join(root, ".local/portable-pi", runId); await mkdir(output, { recursive: true });
	await writeFile(join(output, "inventory.json"), JSON.stringify(inventory, null, 2), { flag: "wx" });
	await writeFile(join(output, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
	await writeFile(join(root, ".local/portable-pi-smoke.json"), JSON.stringify(proof, null, 2));
	console.log(JSON.stringify({ portablePiSmoke: "passed", packages: inventory.packages.length, files: inventory.files.length, forkPackages: inventory.packages.filter(item => item.fork).length, outsideSourceCheckout: true, gameCalls: 0, realModelRequests: 0, fullElectronBundleVerified: false }));
} finally {
	if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
	const canonical = await realpath(directory);
	assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
	assert.ok(basename(canonical).startsWith("commanddeck-portable-pi-"));
	await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
