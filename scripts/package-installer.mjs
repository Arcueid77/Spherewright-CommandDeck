import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readGit } from "../apps/desktop/workspace.mjs";
import { bundleManifestName, bundleHash, verifyBundle } from "./desktop-bundle-files.mjs";
import { makeInstallerScript, verifyInstallerToolchain, installerIdentity, installerExecutable, installerManifestName, verifyInstaller } from "./installer-files.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2);
if (process.platform !== "win32" || ![4, 6].includes(args.length) || args[0] !== "--source" || args[2] !== "--output" || (args.length === 6 && args[4] !== "--test-id")) throw new Error("EXPLICIT_WINDOWS_INSTALLER_SOURCE_OUTPUT_REQUIRED");
const testIdentity = args[5] ?? null; installerIdentity(testIdentity);
const artifactRoot = resolve(root, "artifacts"), output = resolve(root, args[3]), name = relative(artifactRoot, output);
if (isAbsolute(name) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(name) || name.includes("..") || name.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("NEW_INSTALLER_ARTIFACT_DIRECTORY_REQUIRED");
await mkdir(artifactRoot, { recursive: true });
if ((await realpath(artifactRoot)).toLowerCase() !== artifactRoot.toLowerCase()) throw new Error("INSTALLER_ARTIFACT_ROOT_REDIRECTED");
try { await lstat(output); throw new Error("INSTALLER_OUTPUT_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const revision = (await readGit(root, ["rev-parse", "HEAD"])).trim();
async function sourceCheck() {
	if ((await readGit(root, ["rev-parse", "HEAD"])).trim() !== revision || (await readGit(root, ["status", "--porcelain"])).trim()) throw new Error("INSTALLER_REQUIRES_CLEAN_SOURCE");
}
await sourceCheck();
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source), bundleBytes = await readFile(join(source, bundleManifestName));
const lock = JSON.parse(await readFile(join(root, "packaging/inno-setup-lock.json"), "utf8"));
const compilerRoot = join(root, ".local/toolchains/innosetup-7.1.0-x64"), compiler = await verifyInstallerToolchain(compilerRoot, lock);
await mkdir(output);
const script = makeInstallerScript({ template: await readFile(join(root, "packaging/commanddeck.iss.in"), "utf8"), source, output, license: join(source, "resources/app/LICENSE"), manifest, testId: testIdentity });
await writeFile(join(output, "commanddeck.iss"), script, { flag: "wx" });
await new Promise((resolve, reject) => {
	const child = spawn(compiler, ["/Qp", join(output, "commanddeck.iss")], { cwd: root, windowsHide: true, shell: false, stdio: "inherit" });
	child.once("error", () => reject(new Error("INSTALLER_COMPILER_START_FAILED")));
	child.once("close", code => code === 0 ? resolve() : reject(new Error("INSTALLER_COMPILATION_FAILED")));
});
await sourceCheck(); await verifyBundle(source); await verifyInstallerToolchain(compilerRoot, lock);
const bytes = await readFile(join(output, installerExecutable));
const installer = { version: 1, kind: "commanddeck-windows-installer", runtimeIdentifier: "win-x64", appId: installerIdentity(testIdentity), testIdentity, appVersion: manifest.appVersion, sourceRevision: manifest.sourceRevision, builderRevision: revision, piCommit: manifest.piCommit, executable: installerExecutable, sha256: bundleHash(bytes), bytes: bytes.length, scriptSha256: bundleHash(Buffer.from(script)), bundleManifestSha256: bundleHash(bundleBytes), files: manifest.files.length, payloadBytes: manifest.bytes, compilerVersion: lock.version, compilerDistributionSha256: lock.distributionSha256, compilerLockSha256: bundleHash(Buffer.from(JSON.stringify(lock))), perUser: true, userProfilesIncluded: false, signed: false };
await writeFile(join(output, installerManifestName), JSON.stringify(installer, null, 2), { flag: "wx" }); await verifyInstaller(output);
console.log(JSON.stringify({ installer: "created", sourceRevision: manifest.sourceRevision, builderRevision: revision, testIdentity, bytes: bytes.length, perUser: true, signed: false, installed: false, cleanWindowsVmVerified: false, gameCalls: 0 }));
