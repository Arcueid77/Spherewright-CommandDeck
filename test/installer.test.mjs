import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, realpath, rm, mkdir } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { makeInstallerScript, installerIdentity, productionInstallerId, verifyInstaller, verifyInstallerToolchain, installerExecutable, installerManifestName, validateInstalledSmokeSource } from "../scripts/installer-files.mjs";
import { bundleHash } from "../scripts/desktop-bundle-files.mjs";

const template = await readFile(new URL("../packaging/commanddeck.iss.in", import.meta.url), "utf8");
const manifest = { appVersion: "0.0.1", sourceRevision: "a".repeat(40), files: [{ path: "file with {braces}.txt" }, { path: "resources/app/main.mjs" }] };
const options = { template, manifest, source: process.platform === "win32" ? "C:\\bundle" : "/bundle", output: process.platform === "win32" ? "C:\\output" : "/output", license: process.platform === "win32" ? "C:\\LICENSE" : "/LICENSE" };
const testId = "11111111-2222-3333-4444-555555555555";
async function fixture(t, prefix = "commanddeck-installer-test-") {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	t.after(async () => { const path = await realpath(root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith(prefix)); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return root;
}

test("installer identities separate product registration from explicit isolated verification", () => {
	assert.equal(installerIdentity(), productionInstallerId); assert.notEqual(installerIdentity(testId), productionInstallerId);
	assert.equal(installerIdentity(testId), "SWCD.Test." + testId); assert.ok(installerIdentity(testId).length < 48);
	for (const id of ["", "../product", "'injection", "a".repeat(36)]) assert.throws(() => installerIdentity(id), /TEST_ID_INVALID/);
	const script = makeInstallerScript({ ...options, testId });
	assert.ok(script.includes("AppId=" + installerIdentity(testId)));
	assert.ok(script.includes("Isolated test builds never create user shortcuts")); assert.ok(!script.includes('Name: "{autoprograms}'));
	assert.ok(script.includes("installer-test-scope.txt")); assert.ok(script.includes("DECKTESTROOT")); assert.ok(script.includes("if not TestScopeValid"));
});

test("installer uses exact versioned members, per-user permissions and non-destructive process/exit policy", () => {
	const script = makeInstallerScript(options);
	assert.ok(script.includes("PrivilegesRequired=lowest")); assert.ok(script.includes("CloseApplications=no")); assert.ok(script.includes("RestartApplications=no"));
	assert.ok(script.includes("releases\\" + manifest.sourceRevision)); assert.ok(script.includes("file with {{braces}.txt"));
	assert.equal(script.split(/\r?\n/).filter(line => line.startsWith("Source: ")).length, manifest.files.length + 1);
	assert.ok(!script.includes("[UninstallDelete]")); assert.ok(!script.includes("[InstallDelete]")); assert.ok(!script.includes("[Run]")); assert.ok(!script.includes("{userappdata}"));
	assert.ok(script.includes("Processes.ItemIndex")); assert.ok(script.includes("INSTALL_PROCESS_IDENTITY_UNAVAILABLE")); assert.ok(!/TerminateProcess|taskkill|Stop-Process|restartreplace/i.test(script));
});

test("installer generator rejects path/version/template injection and duplicate members", () => {
	for (const changed of [{ source: options.source + '\n[Run]' }, { manifest: { ...manifest, appVersion: '1.2.3\nPrivilegesRequired=admin' } }, { manifest: { ...manifest, sourceRevision: '../bad' } }, { manifest: { ...manifest, files: [{ path: '../outside' }] } }, { manifest: { ...manifest, files: [{ path: 'FILE' }, { path: 'file' }] } }, { template: '@@UNKNOWN@@' }]) assert.throws(() => makeInstallerScript({ ...options, ...changed }));
});

test("installer manifests bind both payload and builder sources and detect modified executable/script", async t => {
	const root = await fixture(t), executable = Buffer.from("installer-fixture"), script = Buffer.from("source-fixture");
	await writeFile(join(root, installerExecutable), executable); await writeFile(join(root, "commanddeck.iss"), script);
	const value = { version: 1, kind: "commanddeck-windows-installer", runtimeIdentifier: "win-x64", sourceRevision: "a".repeat(40), builderRevision: "b".repeat(40), piCommit: "c".repeat(40), appId: installerIdentity(testId), testIdentity: testId, executable: installerExecutable, bytes: executable.length, sha256: bundleHash(executable), scriptSha256: bundleHash(script), bundleManifestSha256: "d".repeat(64), perUser: true, userProfilesIncluded: false };
	await writeFile(join(root, installerManifestName), JSON.stringify(value)); assert.equal((await verifyInstaller(root)).sourceRevision, value.sourceRevision);
	await writeFile(join(root, installerExecutable), "changed"); await assert.rejects(verifyInstaller(root), /PAYLOAD_CHANGED/); await writeFile(join(root, installerExecutable), executable);
	await writeFile(join(root, "commanddeck.iss"), "changed"); await assert.rejects(verifyInstaller(root), /PAYLOAD_CHANGED/); await writeFile(join(root, "commanddeck.iss"), script);
	await writeFile(join(root, installerManifestName), JSON.stringify({ ...value, appId: productionInstallerId })); await assert.rejects(verifyInstaller(root), /MANIFEST_INVALID/);
});

test("direct installed checks admit only the exact revision below a marked temporary installer scope", async t => {
	const scope = await fixture(t, "commanddeck-installer-smoke-"), revision = "a".repeat(40), payload = join(scope, "install/releases", revision), marker = join(scope, "installer-test-scope.txt");
	await mkdir(payload, { recursive: true }); await writeFile(marker, testId);
	assert.equal(await validateInstalledSmokeSource(payload, revision), scope);
	await assert.rejects(validateInstalledSmokeSource(payload, "b".repeat(40)), /SCOPE_INVALID/);
	await writeFile(marker, "invalid"); await assert.rejects(validateInstalledSmokeSource(payload, revision), /SCOPE_INVALID/);
	const outside = await fixture(t); await assert.rejects(validateInstalledSmokeSource(outside, revision), /SCOPE_INVALID/);
});

test("pinned compiler group rejects added or modified files rather than silently accepting a local compiler", async t => {
	const root = await fixture(t), tool = join(root, "compiler"); await mkdir(tool); const bytes = Buffer.from("compiler"); await writeFile(join(tool, "ISCC.exe"), bytes);
	const lock = { version: "7.1.0", files: [{ path: "ISCC.exe", bytes: bytes.length, sha256: bundleHash(bytes) }] };
	assert.equal(await verifyInstallerToolchain(tool, lock), join(tool, "ISCC.exe"));
	await writeFile(join(tool, "extra.iss"), "injected"); await assert.rejects(verifyInstallerToolchain(tool, lock), /TOOLCHAIN_CHANGED/); await rm(join(tool, "extra.iss"));
	await writeFile(join(tool, "ISCC.exe"), "changed"); await assert.rejects(verifyInstallerToolchain(tool, lock), /TOOLCHAIN_CHANGED/);
});
