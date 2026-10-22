import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bundleHash } from "./desktop-bundle-files.mjs";
import { verifyInstallerToolchain } from "./installer-files.mjs";

if (process.platform !== "win32" || process.argv.length !== 2) throw new Error("WINDOWS_INSTALLER_TOOLCHAIN_REQUIRED");
const root = fileURLToPath(new URL("../", import.meta.url)), lock = JSON.parse(await readFile(join(root, "packaging/inno-setup-lock.json"), "utf8"));
if (lock.url !== "https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe" || lock.distributionSha256 !== "0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f") throw new Error("INSTALLER_DOWNLOAD_PIN_INVALID");
const parent = join(root, ".local/toolchains"), downloads = join(parent, "downloads"), target = join(parent, "innosetup-7.1.0-x64"), archive = join(downloads, "innosetup-7.1.0-x64.exe");
await mkdir(downloads, { recursive: true });
for (const path of [parent, downloads]) if ((await realpath(path)).toLowerCase() !== path.toLowerCase() || (await lstat(path)).isSymbolicLink()) throw new Error("INSTALLER_DOWNLOAD_ROOT_REDIRECTED");
let bytes;
try { const info = await lstat(archive); if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error("INSTALLER_DOWNLOAD_INVALID"); bytes = await readFile(archive); }
catch (error) {
	if (error.code !== "ENOENT") throw error;
	const response = await fetch(lock.url, { signal: AbortSignal.timeout(120000) });
	if (!response.ok || Number(response.headers.get("content-length")) > 32 * 1024 * 1024) throw new Error("INSTALLER_DOWNLOAD_FAILED");
	const chunks = []; let received = 0;
	for await (const chunk of response.body) { received += chunk.length; if (received > 32 * 1024 * 1024) throw new Error("INSTALLER_DOWNLOAD_LIMIT"); chunks.push(chunk); }
	bytes = Buffer.concat(chunks); if (bundleHash(bytes) !== lock.distributionSha256) throw new Error("INSTALLER_DOWNLOAD_HASH_MISMATCH");
	await writeFile(archive, bytes, { flag: "wx" });
}
if (bundleHash(bytes) !== lock.distributionSha256) throw new Error("INSTALLER_DOWNLOAD_HASH_MISMATCH");
const powershell = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
const signatureScript = '$ErrorActionPreference="Stop"; $signature=Get-AuthenticodeSignature -LiteralPath $env:COMMANDDECK_COMPILER_DISTRIBUTION; [pscustomobject]@{status=[string]$signature.Status;subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress';
// PowerShell 7's inherited module path can select incompatible modules in the
// Windows PowerShell 5 process. Let that process use its own system defaults.
const signatureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command", signatureScript], { env: { ...signatureEnv, COMMANDDECK_COMPILER_DISTRIBUTION: archive }, windowsHide: true, maxBuffer: 8192 });
const signature = JSON.parse(stdout);
if (signature.status !== "Valid" || !signature.subject.startsWith("CN=Pyrsys B.V.,")) throw new Error("INSTALLER_DISTRIBUTION_SIGNATURE_INVALID");
let exists = false; try { await lstat(target); exists = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
if (!exists) {
	await new Promise((resolve, reject) => {
		const args = ["/CURRENTUSER", "/PORTABLE=1", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/SP-", "/NORESTART", "/NOICONS", "/NOCLOSEAPPLICATIONS", "/NOFORCECLOSEAPPLICATIONS", "/NORESTARTAPPLICATIONS", "/DIR=" + target];
		const child = spawn(archive, args, { cwd: parent, windowsHide: true, shell: false, stdio: "ignore" });
		child.once("error", () => reject(new Error("INSTALLER_TOOLCHAIN_EXTRACT_START_FAILED")));
		child.once("close", code => code === 0 ? resolve() : reject(new Error("INSTALLER_TOOLCHAIN_EXTRACT_FAILED")));
	});
}
await verifyInstallerToolchain(target, lock);
console.log(JSON.stringify({ installerToolchain: "verified", version: lock.version, distributionSha256: lock.distributionSha256, files: lock.files.length, portable: true, registeredInstallation: false }));
