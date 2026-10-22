import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { verifyBundle, copyBundleTree, bundleHash, bundleExecutable } from "./desktop-bundle-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_WINDOWS_PORTABLE_DESKTOP_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), runId = randomUUID();
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle");
let child, exitConfirmed = false, remaining = null, verified = false;
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
	Object.assign(env, { PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COREHOST_TRACE: "1", COREHOST_TRACEFILE: join(directory, "runtime.trace.private.log"), COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId, COMMANDDECK_SMOKE_RUN_ID: runId });
	child = spawn(join(copy, bundleExecutable), ["--portable-smoke"], { cwd: directory, env, windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
	let output = ""; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
	let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 90000);
	let code, signal; try { [code, signal] = await once(child, "exit"); exitConfirmed = true; } finally { clearTimeout(timer); }
	const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
	const scan = '$ErrorActionPreference="Stop"; $prefix=$env:COMMANDDECK_PORTABLE_SCAN_ROOT.TrimEnd([char]92)+[char]92; $count=0; foreach($item in @(Get-Process -Name Spherewright-CommandDeck,CommandDeck.NativeHost,CommandDeck.CommandHost -ErrorAction SilentlyContinue)){ $path=$null; try{$path=$item.Path}catch{}; if(!$path){if(Get-Process -Id $item.Id -ErrorAction SilentlyContinue){throw "PACKAGE_PROCESS_IDENTITY_UNAVAILABLE"};continue}; if($path.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){$count++} }; Write-Output $count';
	const until = performance.now() + 8000;
	do {
		const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command", scan], { env: { ...env, COMMANDDECK_PORTABLE_SCAN_ROOT: directory }, windowsHide: true, timeout: 5000, maxBuffer: 4096 }); remaining = Number(stdout.trim());
		if (remaining === 0) break;
		await new Promise(resolve => setTimeout(resolve, 200));
	} while (performance.now() < until);
	assert.equal(remaining, 0, "Packaged children remain alive");
	assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
	const application = JSON.parse(await readFile(join(directory, "application-proof.json"), "utf8"));
	assert.equal(application.runId, runId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.piCommit, manifest.piCommit);
	const trace = await readFile(join(directory, "runtime.trace.private.log")), text = trace.toString().toLowerCase();
	for (const file of ["hostfxr.dll", "coreclr.dll", "System.Windows.Forms.dll"]) assert.ok(text.includes(join(copy, "resources/app/artifacts/native", file).toLowerCase()), "App-local native runtime missing: " + file);
	assert.ok(text.includes("portable-command-cache"));
	await verifyBundle(copy); await verifyBundle(source);
	const proof = { ...application, outsideSourceCheckout: true, developerToolsAbsentFromPath: true, noExternalNodeTestChild: true, sharedDotnetRootsUnavailable: true, appLocalNativeAndCommandRuntimesObserved: true, bundleUnchanged: true, noPackagedChildrenRemain: true, files: manifest.files.length, bytes: manifest.bytes, traceSha256: bundleHash(trace) };
	const proofRoot = join(root, ".local/portable-desktop", runId); await mkdir(proofRoot, { recursive: true });
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
	await writeFile(join(proofRoot, "runtime.trace.private.log"), trace, { flag: "wx" });
	await writeFile(join(root, ".local/portable-desktop-smoke.json"), JSON.stringify(proof, null, 2));
	verified = true;
	console.log(JSON.stringify({ portableDesktopSmoke: "passed", sourceRevision: manifest.sourceRevision, outsideSourceCheckout: true, files: manifest.files.length, gameCalls: 0, realModelRequests: 0, cleanWindowsVmVerified: false, installerVerified: false }));
} finally {
	// On an unconfirmed exit retain the candidate for diagnosis; never remove a
	// live executable or kill an adopted process to make the test look clean.
	if (verified && exitConfirmed && remaining === 0) {
		const canonical = await realpath(directory);
		assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-"));
		await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
