import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, lstat, realpath, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, relative, isAbsolute, dirname, delimiter, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { readGit } from "../apps/desktop/workspace.mjs";
import { sealCommandHost } from "../apps/desktop/command-cohort.mjs";
import { materializePiRuntime } from "./pi-runtime-tree.mjs";
import { bundleExecutable, bundleManifestName, bundleHash, copyBundleTree, inventoryBundle, ridLockedCopy, verifyBundle, desktopPackageMetadata } from "./desktop-bundle-files.mjs";
import { verifyRendererNotices } from "./renderer-notices.mjs";
import { copyFrameworkNotices } from "./framework-notices.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), pin = "71023aec1546d6d677a65669c5665c0927ce0dd0";
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--output") throw new Error("EXPLICIT_WINDOWS_BUNDLE_OUTPUT_REQUIRED");
const artifactRoot = resolve(root, "artifacts"), output = resolve(root, args[1]), name = relative(artifactRoot, output);
if (isAbsolute(name) || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(name) || name.includes("..") || name.endsWith(".") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("NEW_BUNDLE_ARTIFACT_DIRECTORY_REQUIRED");
await mkdir(artifactRoot, { recursive: true });
if ((await realpath(artifactRoot)).toLowerCase() !== artifactRoot.toLowerCase()) throw new Error("BUNDLE_ARTIFACT_ROOT_REDIRECTED");
const revision = (await readGit(root, ["rev-parse", "HEAD"])).trim();
async function sourceCheck() {
	if ((await readGit(root, ["rev-parse", "HEAD"])).trim() !== revision || (await readGit(root, ["status", "--porcelain"])).trim() || (await readGit(join(root, "vendor/pi"), ["rev-parse", "HEAD"])).trim() !== pin || (await readGit(join(root, "vendor/pi"), ["status", "--porcelain"])).trim()) throw new Error("BUNDLE_REQUIRES_CLEAN_PINNED_SOURCE");
}
await sourceCheck();
try { await lstat(output); throw new Error("BUNDLE_OUTPUT_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const packageFile = JSON.parse(await readFile(join(root, "package.json"), "utf8")), lock = await readFile(join(root, "package-lock.json")), piLock = await readFile(join(root, "vendor/pi/package-lock.json"));
const electronVersion = (await readFile(join(root, "node_modules/electron/dist/version"), "utf8")).trim();
if (electronVersion !== packageFile.devDependencies.electron || JSON.parse(lock).packages["node_modules/electron"].version !== electronVersion) throw new Error("BUNDLE_ELECTRON_PIN_MISMATCH");
let dotnet;
for (const entry of (Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "").split(delimiter)) {
	if (!isAbsolute(entry)) continue;
	try { const candidate = await realpath(join(entry, "dotnet.exe")), path = relative(root, candidate); if (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)) continue; if ((await lstat(candidate)).isFile()) { dotnet = candidate; break; } } catch {}
}
if (!dotnet || !process.env.npm_execpath) throw new Error("BUNDLE_BUILD_TOOLCHAIN_REQUIRED");
async function run(executable, commandArgs, capture = false) {
	return new Promise((resolve, reject) => {
		const child = spawn(executable, commandArgs, { cwd: root, shell: false, windowsHide: true, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" }); let text = "";
		if (capture) { child.stdout.on("data", bytes => { text += bytes; if (text.length > 65536) child.kill(); }); child.stderr.on("data", () => {}); }
		child.once("error", () => reject(new Error("BUNDLE_BUILD_START_FAILED"))); child.once("close", code => code === 0 ? resolve(text.trim()) : reject(new Error("BUNDLE_BUILD_FAILED")));
	});
}
const sdkVersion = (await run(dotnet, ["--version"], true)).split(/\r?\n/).at(-1);
await run(process.execPath, [process.env.npm_execpath, "run", "pi:verify"]);
await run(process.execPath, [process.env.npm_execpath, "run", "build:renderer"]);
const rendererNotices = await verifyRendererNotices(root, join(root, "dist/renderer/THIRD-PARTY-LICENSES.md"), JSON.parse(lock));
await sourceCheck(); await mkdir(output);
const stage = join(root, ".local/bundle-build", randomUUID()), app = join(output, "resources/app"); await mkdir(stage, { recursive: true });
const nativeFiles = (await readGit(root, ["ls-files", "-z", "--", "native/"])).split("\0").filter(Boolean), inputs = [];
if (nativeFiles.some(path => /(?:^|\/)Directory\.(?:Build\.(?:props|targets)|Packages\.props)$/.test(path))) throw new Error("BUNDLE_NATIVE_BUILD_LAYOUT_CHANGED");
for (const name of ["Directory.Build.props", "Directory.Build.targets"]) await writeFile(join(stage, name), "<Project />", { flag: "wx" });
for (const path of nativeFiles) {
	if (!/^(?:native\/)(?:CommandDeck\.(?:NativeHost|CommandHost|Windowing|AdapterBridge)\/)/.test(path)) continue;
	const bytes = await readGit(root, ["show", revision + ":" + path], { bytes: true }), destination = join(stage, path);
	await mkdir(dirname(destination), { recursive: true });
	const outputBytes = path.endsWith("/packages.lock.json") ? ridLockedCopy(bytes.toString("utf8")) : bytes;
	await writeFile(destination, outputBytes, { flag: "wx" }); inputs.push({ path, sourceSha256: bundleHash(bytes), buildCopySha256: bundleHash(outputBytes) });
}
await copyBundleTree(join(root, "node_modules/electron/dist"), output, { skip: path => {
	if (path === "resources/app.asar" || path === "resources/app") throw new Error("BUNDLE_UNEXPECTED_ELECTRON_APPLICATION");
	return path === "resources/default_app.asar";
} });
await rename(join(output, "electron.exe"), join(output, bundleExecutable));
try { await lstat(join(output, "electron_wer.dll")); await rename(join(output, "electron_wer.dll"), join(output, "Spherewright-CommandDeck_wer.dll")); } catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(app, { recursive: true });
await writeFile(join(app, "package.json"), JSON.stringify(desktopPackageMetadata(packageFile), null, 2), { flag: "wx" });
await copyBundleTree(join(root, "apps/desktop"), join(app, "apps/desktop"));
await mkdir(join(app, "test/fixtures"), { recursive: true });
await copyBundleTree(join(root, "test/fixtures/research-mcp-server.mjs"), join(app, "test/fixtures/research-mcp-server.mjs"));
await copyBundleTree(join(root, "dist/renderer"), join(app, "dist/renderer"));
await copyBundleTree(join(root, "LICENSE"), join(app, "LICENSE"));
const frameworkNotices = {};
for (const [project, folder] of [["NativeHost", "native"], ["CommandHost", "commands"]]) {
	await run(dotnet, ["publish", join(stage, "native", "CommandDeck." + project, "CommandDeck." + project + ".csproj"), "-c", "Release", "-f", "net8.0-windows", "-r", "win-x64", "--self-contained", "true", "-p:RestoreLockedMode=true", "-p:DirectoryBuildPropsPath=" + join(stage, "Directory.Build.props"), "-p:DirectoryBuildTargetsPath=" + join(stage, "Directory.Build.targets"), "-p:DebugType=None", "-p:DebugSymbols=false", "-p:InformationalVersion=" + packageFile.version + "+" + revision, "-p:IncludeSourceRevisionInInformationalVersion=false", "--nologo", "-o", join(app, "artifacts", folder)]);
	frameworkNotices[folder] = await copyFrameworkNotices({ assets: JSON.parse(await readFile(join(stage, "native", "CommandDeck." + project, "obj/project.assets.json"), "utf8")), runtimeConfig: JSON.parse(await readFile(join(app, "artifacts", folder, "CommandDeck." + project + ".runtimeconfig.json"), "utf8")), output: join(app, "artifacts", folder) });
}
const assets = JSON.parse(await readFile(join(stage, "native/CommandDeck.NativeHost/obj/project.assets.json"), "utf8"));
const newtonsoft = assets.libraries?.["Newtonsoft.Json/13.0.4"];
if (!newtonsoft || newtonsoft.path !== "newtonsoft.json/13.0.4") throw new Error("BUNDLE_NATIVE_LICENSE_PIN_MISMATCH");
let license;
for (const folder of Object.keys(assets.packageFolders ?? {})) {
	try { license = await readFile(join(folder, newtonsoft.path, "LICENSE.md")); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
}
if (!license) throw new Error("BUNDLE_NATIVE_LICENSE_MISSING");
await mkdir(join(app, "licenses")); await writeFile(join(app, "licenses/Newtonsoft.Json-LICENSE.md"), license, { flag: "wx" });
for (const input of inputs.filter(file => file.path.endsWith("/packages.lock.json"))) if (bundleHash(await readFile(join(stage, input.path))) !== input.buildCopySha256) throw new Error("BUNDLE_NATIVE_LOCK_CHANGED");
const command = await sealCommandHost(join(app, "artifacts/commands"), revision, { sdkVersion }); if (!command.selfContained) throw new Error("BUNDLE_COMMAND_RUNTIME_MISSING");
const nativeConfig = JSON.parse(await readFile(join(app, "artifacts/native/CommandDeck.NativeHost.runtimeconfig.json"), "utf8"));
if (!nativeConfig.runtimeOptions?.includedFrameworks?.some(item => item.name === "Microsoft.WindowsDesktop.App") || nativeConfig.runtimeOptions.framework || nativeConfig.runtimeOptions.frameworks) throw new Error("BUNDLE_NATIVE_RUNTIME_MISSING");
await mkdir(join(app, "vendor")); const pi = await materializePiRuntime(join(root, "vendor/pi"), join(app, "vendor/pi"));
await sourceCheck();
if (bundleHash(await readFile(join(root, "package-lock.json"))) !== bundleHash(lock) || bundleHash(await readFile(join(root, "vendor/pi/package-lock.json"))) !== bundleHash(piLock)) throw new Error("BUNDLE_DEPENDENCY_LOCK_CHANGED");
const inventory = await inventoryBundle(output);
const manifest = { version: 1, kind: "commanddeck-windows-portable", runtimeIdentifier: "win-x64", executable: bundleExecutable, selfContained: true, nativeProcessObserver: 1, nativeCommandProcessObserver: 1, portableRuntimeFaults: 1, portableMcpFaults: 1, portableDiagnostics: 1, portableStorageFaults: 1, portableCommandFaults: 2, writableLedgerStartup: 1, profileLedgerPresence: 1, portableFullProfile: 1, desktopTray: 1, powerLifecycle: 1, eventJournal: 1, portableJournalInterruption: 1, portableVideoArchive: 1, videoPlaybackUi: 1, videoRecordingControls: 1, encodedPrivacyFixture: 2, videoAnnotations: 1, videoEventTimeline: 2, sourceRevision: revision, piCommit: pin, appVersion: packageFile.version, electronVersion, sdkVersion, rootDependencyLockSha256: bundleHash(lock), piDependencyLockSha256: bundleHash(piLock), nativeInputs: inputs, nativeFrameworks: nativeConfig.runtimeOptions.includedFrameworks, frameworkNotices, rendererNotices, piPackages: pi.packages, ...inventory };
manifest.modelUsage = 1;
manifest.modelUsageRecovery = 1;
manifest.modelUsageSummary = 1;
manifest.developmentContextManagement = 1;
manifest.portableDevelopmentContext = 1;
manifest.portableDevelopmentContextInterruption = 1;
manifest.portableDevelopmentProviderContext = 1;
manifest.portableDevelopmentUsage = 1;
await writeFile(join(output, bundleManifestName), JSON.stringify(manifest, null, 2), { flag: "wx" }); await verifyBundle(output);
console.log(JSON.stringify({ desktopBundle: "created", sourceRevision: revision, piCommit: pin, files: inventory.files.length, bytes: inventory.bytes, selfContained: true, installerBuilt: false, cleanWindowsVmVerified: false, gameCalls: 0 }));
