import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, appendFile, mkdir, mkdtemp, realpath, lstat, readdir, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyInstaller, installerExecutable } from "./installer-files.mjs";
import { verifyBundle, bundleManifestName, bundleHash } from "./desktop-bundle-files.mjs";
import { NativeClient } from "../apps/desktop/native-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_ISOLATED_INSTALLER_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyInstaller(source);
if (manifest.testIdentity === null) throw new Error("PRODUCTION_INSTALLER_NOT_ALLOWED_IN_AUTOMATED_SMOKE");
const runId = randomUUID(), proofRoot = join(root, ".local/installer", runId), scope = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-installer-smoke-"))), installation = join(scope, "install"), payload = join(installation, "releases", manifest.sourceRevision);
await mkdir(proofRoot, { recursive: true }); await writeFile(join(scope, "installer-test-scope.txt"), manifest.testIdentity, { flag: "wx" });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, testIdentity: manifest.testIdentity, source, scope, installation, payload, sourceRevision: manifest.sourceRevision, builderRevision: manifest.builderRevision }, null, 2), { flag: "wx" });
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const switches = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART", "/NOCLOSEAPPLICATIONS", "/NOFORCECLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS", "/DECKTESTID=" + manifest.testIdentity, "/DECKTESTROOT=" + scope];
const executable = join(source, installerExecutable), uninstaller = join(installation, "unins000.exe"), registry = join(process.env.SystemRoot, "System32/reg.exe"), key = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\" + manifest.appId + "_is1";
const profiles = [];
let fixture, fixtureStopped = false, passed = false;

async function run(stage, command, arguments_) {
	let output = ""; const child = spawn(command, arguments_, { cwd: scope, env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	const completion = once(child, "close"); completion.catch(() => {});
	child.stdout.on("data", bytes => { output = (output + bytes).slice(-65536); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-65536); });
	await appendFile(join(proofRoot, "processes.private.jsonl"), JSON.stringify({ stage, pid: child.pid, command, startedUtc: new Date().toISOString() }) + "\n");
	const [code, signal] = await completion;
	await writeFile(join(proofRoot, stage + ".private.json"), JSON.stringify({ code, signal, output }, null, 2), { flag: "wx" }); return { code, output };
}
async function checkPayload() {
	const bundle = await verifyBundle(payload); assert.equal(bundle.sourceRevision, manifest.sourceRevision); assert.equal(bundle.piCommit, manifest.piCommit);
	assert.equal(bundleHash(await readFile(join(payload, bundleManifestName))), manifest.bundleManifestSha256);
	assert.equal(bundle.nativeProcessObserver, 1);
	return bundle;
}
async function registered(stage) {
	const current = await run(stage + "-hkcu", registry, ["query", "HKCU\\" + key, "/v", "InstallLocation", "/reg:64"]);
	assert.equal(current.code, 0); assert.ok(current.output.toLowerCase().includes(installation.toLowerCase()));
	const machine = await run(stage + "-hklm", registry, ["query", "HKLM\\" + key, "/reg:64"]); assert.equal(machine.code, 1);
}
async function snapshot(directory) {
	const files = []; let total = 0;
	async function walk(folder, prefix = "") {
		for (const name of (await readdir(folder)).sort()) {
			const full = join(folder, name), info = await lstat(full), path = prefix + name;
			assert.equal(info.isSymbolicLink(), false);
			if (info.isDirectory()) await walk(full, path + "/");
			else { assert.ok(info.isFile() && files.length < 30000 && info.size <= 512 * 1024 * 1024 && total + info.size <= 2 * 1024 * 1024 * 1024); const bytes = await readFile(full); files.push({ path, bytes: bytes.length, sha256: bundleHash(bytes) }); total += bytes.length; }
		}
	}
	await walk(directory); return { files, sha256: bundleHash(Buffer.from(JSON.stringify(files))) };
}
async function launchInstalled(stage) {
	const result = await run(stage, process.execPath, [join(root, "scripts/portable-desktop-smoke.mjs"), "--installed-source", payload, "--reopen-history"]); assert.equal(result.code, 0, "Installed application failed: " + stage);
	const line = result.output.trim().split(/\r?\n/).findLast(line => line.startsWith('{"portableDesktopSmoke":'));
	assert.ok(line); const summary = JSON.parse(line); assert.equal(summary.installedExecutable, true); assert.equal(summary.sourceRevision, manifest.sourceRevision); assert.equal(summary.closedHistoryReopened, true); assert.equal(summary.applicationRuns, 2);
	const context = JSON.parse(await readFile(join(root, ".local/portable-desktop", summary.runId, "application-exit.private.json"), "utf8"));
	assert.equal(context.installedSource, payload); assert.equal(context.code, 0); assert.equal(context.timedOut, false);
	const profile = await realpath(context.profileDirectory); assert.equal(dirname(profile).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(profile).startsWith("commanddeck-desktop-smoke-"));
	profiles.push({ path: profile, ...await snapshot(profile) });
}
async function profilesUnchanged() { for (const profile of profiles) assert.deepEqual(await snapshot(profile.path), { files: profile.files, sha256: profile.sha256 }); }
async function removeOwnTemporary(directory, prefix) {
	const canonical = await realpath(directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith(prefix)); await rm(canonical, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

try {
	const first = await run("install", executable, [...switches, "/DIR=" + installation, "/LOG=" + join(proofRoot, "install.private.log")]); assert.equal(first.code, 0); await checkPayload(); await registered("installed");
	const retained = join(installation, "unmanaged-test.txt"), retainedBytes = Buffer.from("This unregistered test file must survive uninstall."); await writeFile(retained, retainedBytes, { flag: "wx" });
	fixture = new NativeClient(["--fixture"], join(payload, "resources/app/artifacts/native/CommandDeck.NativeHost.exe")); await fixture.ready;
	const blockedInstall = await run("running-install-refused", executable, [...switches, "/DIR=" + installation, "/LOG=" + join(proofRoot, "running-install-refused.private.log")]); assert.notEqual(blockedInstall.code, 0); assert.equal(fixture.child.exitCode, null); await checkPayload();
	const blockedUninstall = await run("running-uninstall-refused", uninstaller, switches); assert.notEqual(blockedUninstall.code, 0); assert.equal(fixture.child.exitCode, null); await registered("refused-uninstall");
	const exit = once(fixture.child, "exit"); fixture.child.stdin.write("close\n"); const [fixtureCode] = await exit; assert.equal(fixtureCode, 0); fixtureStopped = true;
	await launchInstalled("installed-application");
	const repair = await run("repair", executable, [...switches, "/DIR=" + installation, "/LOG=" + join(proofRoot, "repair.private.log")]); assert.equal(repair.code, 0); await checkPayload(); await profilesUnchanged(); await registered("repaired");
	await launchInstalled("repaired-application"); await profilesUnchanged();
	const removal = await run("uninstall", uninstaller, [...switches, "/LOG=" + join(proofRoot, "uninstall.private.log")]); assert.equal(removal.code, 0);
	const until = performance.now() + 10000;
	for (const path of [payload, uninstaller, join(installation, "unins000.dat")]) {
		while (true) { try { await lstat(path); } catch (error) { if (error.code === "ENOENT") break; throw error; } assert.ok(performance.now() < until, "Registered installer files remain"); await new Promise(resolve => setTimeout(resolve, 100)); }
	}
	const gone = await run("uninstalled-hkcu", registry, ["query", "HKCU\\" + key, "/reg:64"]); assert.equal(gone.code, 1);
	assert.deepEqual(await readFile(retained), retainedBytes); await profilesUnchanged(); await verifyInstaller(source);
	const proof = { installerSmoke: "passed", runId, sourceRevision: manifest.sourceRevision, builderRevision: manifest.builderRevision, piCommit: manifest.piCommit, installerSha256: manifest.sha256, testIdentity: manifest.testIdentity, isolatedRegistration: true, perUserRegistryOnly: true, actualInstalledExecutable: true, installedApplicationRuns: 4, closedSyntheticHistoryReopened: true, runningInstallAndUninstallRefused: true, noProcessForceTermination: true, sameCandidateRepairPassed: true, normalUninstallPassed: true, unknownInstallFilePreserved: true, actualIsolatedProfilesPreserved: true, profiles: profiles.map(profile => ({ files: profile.files.length, sha256: profile.sha256 })), sourceInstallerUnchanged: true, upgradeVerified: false, rollbackVerified: false, cleanWindowsVmVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/installer-smoke.json"), JSON.stringify(proof, null, 2));
	passed = true; console.log(JSON.stringify(proof));
} finally {
	if (fixture && !fixtureStopped && fixture.child.exitCode === null) { const exit = once(fixture.child, "exit"); fixture.child.stdin.write("close\n"); await exit; fixtureStopped = true; }
	// Failure retains its files, registry identity and process history for a
	// targeted recovery; never erase evidence or adopt an unrelated installation.
	if (passed) {
		assert.equal(await readFile(join(scope, "installer-test-scope.txt"), "utf8"), manifest.testIdentity);
		for (const profile of profiles) await removeOwnTemporary(profile.path, "commanddeck-desktop-smoke-");
		await removeOwnTemporary(scope, "commanddeck-installer-smoke-");
	}
}
