import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, appendFile, mkdir, mkdtemp, realpath, lstat, readdir, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { verifyInstaller, installerExecutable } from "./installer-files.mjs";
import { verifyBundle, bundleHash, bundleManifestName } from "./desktop-bundle-files.mjs";
import { readPortableHistory } from "../apps/desktop/portable-history.mjs";
import { installedProfileOwnerFile, validateInstallerUpgradePair, assertInstallerRegistration } from "./installer-upgrade-state.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || args.length !== 4 || args[0] !== "--baseline" || args[2] !== "--candidate") throw new Error("EXPLICIT_ISOLATED_INSTALLER_PAIR_REQUIRED");
const baselineSource = await realpath(resolve(root, args[1])), candidateSource = await realpath(resolve(root, args[3]));
const baseline = await verifyInstaller(baselineSource), candidate = await verifyInstaller(candidateSource); validateInstallerUpgradePair(baseline, candidate);
const git = (...arguments_) => execFileSync("git", ["-c", "core.fsmonitor=false", ...arguments_], { cwd: root, encoding: "utf8", windowsHide: true, stdio: "pipe" }).trim();
const driverRevision = git("rev-parse", "HEAD"); assert.match(driverRevision, /^[a-f0-9]{40}$/);
function verifyDriver() { assert.equal(git("rev-parse", "HEAD"), driverRevision, "UPGRADE_DRIVER_REVISION_CHANGED"); assert.equal(git("status", "--porcelain=v1", "--untracked-files=normal"), "", "UPGRADE_REQUIRES_CLEAN_DRIVER_SOURCE"); }
verifyDriver();
const runId = randomUUID(), proofRoot = join(root, ".local/installer-upgrade", runId), scope = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-installer-smoke-"))), installation = join(scope, "install");
await mkdir(proofRoot, { recursive: true }); await writeFile(join(scope, "installer-test-scope.txt"), baseline.testIdentity, { flag: "wx" });
await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, driverRevision, scope, installation, baselineSource, candidateSource, baselineRevision: baseline.sourceRevision, candidateRevision: candidate.sourceRevision, testIdentity: baseline.testIdentity }, null, 2), { flag: "wx" });
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const switches = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART", "/NOCLOSEAPPLICATIONS", "/NOFORCECLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS", "/DECKTESTID=" + baseline.testIdentity, "/DECKTESTROOT=" + scope];
let profile, profileRunId, history, passed = false; const stages = [];
const payload = manifest => join(installation, "releases", manifest.sourceRevision);

async function run(stage, command, arguments_) {
	verifyDriver();
	let output = ""; const child = spawn(command, arguments_, { cwd: scope, env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	const completion = once(child, "close"); completion.catch(() => {});
	child.stdout.on("data", bytes => { output = (output + bytes).slice(-65536); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-65536); });
	await appendFile(join(proofRoot, "processes.private.jsonl"), JSON.stringify({ stage, pid: child.pid, command, startedUtc: new Date().toISOString() }) + "\n");
	const [code, signal] = await completion; await writeFile(join(proofRoot, stage + ".private.json"), JSON.stringify({ code, signal, output }), { flag: "wx" }); return { code, output };
}
async function registration(stage, manifest) {
	const result = await run(stage + "-registration", join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "scripts/read-installer-registration.ps1"), "-TestIdentity", baseline.testIdentity]);
	assert.equal(result.code, 0, "Registry state is unknown"); const value = JSON.parse(result.output.trim()); assertInstallerRegistration(value, installation, manifest); return value;
}
async function checkPayload(manifest) {
	const value = await verifyBundle(payload(manifest)); assert.equal(value.sourceRevision, manifest.sourceRevision); assert.equal(value.piCommit, manifest.piCommit); assert.equal(value.nativeProcessObserver, 1);
	assert.equal(bundleHash(await readFile(join(payload(manifest), bundleManifestName))), manifest.bundleManifestSha256);
	assert.ok(value.files.some(file => file.path === "resources/app/apps/desktop/portable-history.mjs"), "CLOSED_HISTORY_REOPEN_UNSUPPORTED_REBUILD_REQUIRED");
}
async function snapshot(directory) {
	const files = []; let total = 0;
	async function walk(folder, prefix = "") {
		for (const name of (await readdir(folder)).sort()) {
			const full = join(folder, name), info = await lstat(full), path = prefix + name; assert.equal(info.isSymbolicLink(), false);
			if (info.isDirectory()) await walk(full, path + "/");
			else { assert.ok(info.isFile() && files.length < 30000 && info.size <= 512 * 1024 * 1024 && total + info.size <= 2 * 1024 * 1024 * 1024); const bytes = await readFile(full); files.push({ path, bytes: bytes.length, sha256: bundleHash(bytes) }); total += bytes.length; }
		}
	}
	await walk(directory); return { files, sha256: bundleHash(Buffer.from(JSON.stringify(files))) };
}
async function install(stage, source, manifest) {
	const before = profile ? await snapshot(profile) : null;
	const result = await run(stage, join(source, installerExecutable), [...switches, "/DIR=" + installation, "/LOG=" + join(proofRoot, stage + ".private.log")]); assert.equal(result.code, 0);
	await checkPayload(manifest); await registration(stage, manifest);
	if (before) assert.deepEqual(await snapshot(profile), before, "Installer modified the retained profile");
}
async function launch(stage, manifest, previousRevision = null) {
	let extra = ["--reopen-history"];
	if (previousRevision) {
		const file = join(scope, "profile-context-" + stage + ".json");
		await writeFile(file, JSON.stringify({ version: 1, kind: "installed-closed-history-reopen", phase: stage, scope, directory: profile, runId: profileRunId, targetRevision: manifest.sourceRevision, previousRevision, expectedHistorySha256: history.sha256 }), { flag: "wx" });
		extra = ["--resume-profile", file];
	}
	const result = await run(stage + "-application", process.execPath, [join(root, "scripts/portable-desktop-smoke.mjs"), "--installed-source", payload(manifest), ...extra]); assert.equal(result.code, 0);
	const line = result.output.trim().split(/\r?\n/).findLast(line => line.startsWith('{"portableDesktopSmoke":')); assert.ok(line); const summary = JSON.parse(line);
	assert.equal(summary.installedExecutable, true); assert.equal(summary.sourceRevision, manifest.sourceRevision); assert.equal(summary.closedHistoryReopened, true); assert.equal(summary.applicationRuns, previousRevision ? 1 : 2);
	if (previousRevision) { assert.equal(summary.runId, profileRunId); assert.equal(summary.resumedPhase, stage); }
	else {
		profileRunId = summary.runId;
		const context = JSON.parse(await readFile(join(root, ".local/portable-desktop", profileRunId, "application-exit.private.json"), "utf8"));
		assert.equal(context.code, 0); assert.equal(context.timedOut, false); assert.equal(context.installedSource, payload(manifest));
		profile = await realpath(context.profileDirectory); assert.equal(dirname(profile).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(profile).startsWith("commanddeck-desktop-smoke-"));
		history = await readPortableHistory({ root: profile, runId: profileRunId }); assert.ok(history);
		await writeFile(join(profile, installedProfileOwnerFile), JSON.stringify({ version: 1, kind: "isolated-installer-profile", scope, testIdentity: baseline.testIdentity, runId: profileRunId }), { flag: "wx" });
	}
	const application = JSON.parse(await readFile(join(profile, "application-proof.json"), "utf8"));
	assert.equal(application.runId, profileRunId); assert.equal(application.sourceRevision, manifest.sourceRevision); assert.equal(application.history?.closedHistorySha256, history.sha256);
	assert.equal((await readPortableHistory({ root: profile, runId: profileRunId })).sha256, history.sha256);
	const after = await snapshot(profile), value = { stage, sourceRevision: manifest.sourceRevision, applicationRuns: summary.applicationRuns, samePhysicalProfile: true, closedHistorySha256: history.sha256, files: after.files.length, profileSha256: after.sha256 };
	stages.push(value); await writeFile(join(proofRoot, stage + "-proof.json"), JSON.stringify(value), { flag: "wx" });
}
async function removeOwn(directory, prefix) {
	const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith(prefix)); await rm(canonical, { recursive: true, maxRetries: 5, retryDelay: 100 });
}

try {
	await registration("preflight", null); await install("baseline-install", baselineSource, baseline);
	const retained = join(installation, "unmanaged-upgrade-test.txt"), retainedBytes = Buffer.from("Unregistered file retained across version changes and uninstall."); await writeFile(retained, retainedBytes, { flag: "wx" });
	await launch("baseline", baseline);
	await install("upgrade-install", candidateSource, candidate); await checkPayload(baseline); await launch("upgrade", candidate, baseline.sourceRevision);
	await install("rollback-install", baselineSource, baseline); await checkPayload(candidate); await launch("rollback", baseline, candidate.sourceRevision);
	await install("return-to-new-install", candidateSource, candidate); await checkPayload(baseline); await launch("return-to-new", candidate, baseline.sourceRevision);
	const beforeRemoval = await snapshot(profile), removal = await run("uninstall", join(installation, "unins000.exe"), [...switches, "/LOG=" + join(proofRoot, "uninstall.private.log")]); assert.equal(removal.code, 0);
	const until = performance.now() + 10000;
	for (const file of [payload(baseline), payload(candidate), join(installation, "unins000.exe"), join(installation, "unins000.dat")]) {
		while (true) { try { await lstat(file); } catch (error) { if (error.code === "ENOENT") break; throw error; } assert.ok(performance.now() < until, "Registered version payload remains"); await new Promise(resolve => setTimeout(resolve, 100)); }
	}
	await registration("uninstalled", null); assert.deepEqual(await snapshot(profile), beforeRemoval); assert.deepEqual(await readFile(retained), retainedBytes);
	await verifyInstaller(baselineSource); await verifyInstaller(candidateSource); verifyDriver();
	const proof = { installerUpgradeSmoke: "passed", runId, driverRevision, driverSourceUnchanged: true, baselineRevision: baseline.sourceRevision, candidateRevision: candidate.sourceRevision, baselineInstallerSha256: baseline.sha256, candidateInstallerSha256: candidate.sha256, isolatedRegistration: true, explicitVersionPairOnly: true, samePhysicalIsolatedProfile: true, closedSyntheticHistorySha256: history.sha256, stages, applicationRuns: 5, upgradePassed: true, compatibleRollbackPassed: true, returnToCandidatePassed: true, installedPayloadsUnchanged: true, installerOperationsPreserveProfileBytes: true, normalUninstallRemovesBothReleases: true, unknownInstallFilePreserved: true, profilePreservedAfterUninstall: true, profileSchemaMigrationVerified: false, cleanWindowsVmVerified: false, gameCalls: 0, realModelRequests: 0 };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/installer-upgrade-smoke.json"), JSON.stringify(proof, null, 2)); passed = true; console.log(JSON.stringify(proof));
} finally {
	if (passed) { assert.equal(await readFile(join(scope, "installer-test-scope.txt"), "utf8"), baseline.testIdentity); await removeOwn(profile, "commanddeck-desktop-smoke-"); await removeOwn(scope, "commanddeck-installer-smoke-"); }
}
