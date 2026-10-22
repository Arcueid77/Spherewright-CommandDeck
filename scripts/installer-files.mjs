import { readFile, lstat, realpath, readdir } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { bundleHash, bundleExecutable, bundleManifestName, bundleRelative } from "./desktop-bundle-files.mjs";

export const installerExecutable = "Spherewright-CommandDeck-Setup.exe";
export const installerManifestName = "commanddeck-installer.json";
export const productionInstallerId = "Spherewright.CommandDeck";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function installerIdentity(testId = null) {
	if (testId !== null && !uuid.test(testId)) throw new Error("INSTALLER_TEST_ID_INVALID");
	// Keep the complete UUID and stay below Inno's uninstall-key shortening
	// threshold. Product registration retains its existing stable identity.
	return testId === null ? productionInstallerId : "SWCD.Test." + testId;
}

export async function validateInstalledSmokeSource(source, revision) {
	if (!/^[a-f0-9]{40}$/.test(revision ?? "") || !isAbsolute(source) || (await realpath(source)).toLowerCase() !== source.toLowerCase()) throw new Error("INSTALLED_SMOKE_SCOPE_INVALID");
	const scope = dirname(dirname(dirname(source)));
	if (dirname(scope).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(scope).startsWith("commanddeck-installer-smoke-") || source.toLowerCase() !== join(scope, "install/releases", revision).toLowerCase()) throw new Error("INSTALLED_SMOKE_SCOPE_INVALID");
	const path = join(scope, "installer-test-scope.txt"), info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size !== 36 || !uuid.test(await readFile(path, "utf8"))) throw new Error("INSTALLED_SMOKE_SCOPE_INVALID");
	return scope;
}

function literal(value) {
	if (typeof value !== "string" || !value || /["\x00-\x1f]/.test(value)) throw new Error("INSTALLER_LITERAL_INVALID");
	return value.replaceAll("{", "{{");
}

export function makeInstallerScript({ template, source, output, license, manifest, testId = null }) {
	const appId = installerIdentity(testId);
	if (![source, output, license].every(isAbsolute) || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") || !/^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(manifest.appVersion ?? "") || manifest.appVersion.split(".").some(part => Number(part) > 65535) || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 30000) throw new Error("INSTALLER_SOURCE_INVALID");
	const payload = "{app}\\releases\\" + manifest.sourceRevision;
	const seen = new Set(), files = [...manifest.files.map(file => file.path), bundleManifestName].map(path => {
		bundleRelative(path); const key = path.toLowerCase(); if (seen.has(key)) throw new Error("INSTALLER_MEMBER_DUPLICATE"); seen.add(key);
		const windowsPath = path.replaceAll("/", "\\"), parent = windowsPath.includes("\\") ? windowsPath.slice(0, windowsPath.lastIndexOf("\\")) : "";
		return 'Source: "' + literal(join(source, path)) + '"; DestDir: "' + payload + (parent ? "\\" + literal(parent) : "") + '"; Flags: ignoreversion';
	});
	const replacements = {
		APP_ID: appId, TEST_LABEL: testId ? " (isolated test)" : "", APP_VERSION: manifest.appVersion,
		SHORT_REVISION: manifest.sourceRevision.slice(0, 12), REVISION: manifest.sourceRevision,
		OUTPUT: literal(output), LICENSE: literal(license), TEST_ID: testId ?? "", FILES: files.join("\r\n"),
		ICONS: testId ? "; Isolated test builds never create user shortcuts." : 'Name: "{autoprograms}\\Spherewright CommandDeck"; Filename: "' + payload + "\\" + bundleExecutable + '"; WorkingDir: "' + payload + '"; AppUserModelID: "Spherewright.CommandDeck"',
	};
	const script = template.replace(/@@([A-Z_]+)@@/g, (_, key) => {
		if (!Object.hasOwn(replacements, key)) throw new Error("INSTALLER_TEMPLATE_INVALID"); return replacements[key];
	});
	if (script.includes("@@")) throw new Error("INSTALLER_TEMPLATE_INVALID");
	return script;
}

export async function verifyInstaller(root) {
	async function member(name, limit) {
		const path = join(root, name), info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error("INSTALLER_MEMBER_INVALID");
		return readFile(path);
	}
	const manifest = JSON.parse(await member(installerManifestName, 16384));
	if (manifest.version !== 1 || manifest.kind !== "commanddeck-windows-installer" || manifest.runtimeIdentifier !== "win-x64" || !/^[a-f0-9]{40}$/.test(manifest.sourceRevision ?? "") || !/^[a-f0-9]{40}$/.test(manifest.builderRevision ?? "") || !/^[a-f0-9]{40}$/.test(manifest.piCommit ?? "") || manifest.appId !== installerIdentity(manifest.testIdentity) || manifest.executable !== installerExecutable || !/^[a-f0-9]{64}$/.test(manifest.bundleManifestSha256 ?? "") || manifest.perUser !== true || manifest.userProfilesIncluded !== false) throw new Error("INSTALLER_MANIFEST_INVALID");
	for (const [name, expected, limit] of [[installerExecutable, manifest.sha256, 1024 * 1024 * 1024], ["commanddeck.iss", manifest.scriptSha256, 32 * 1024 * 1024]]) {
		const bytes = await member(name, limit);
		if (!/^[a-f0-9]{64}$/.test(expected ?? "") || bundleHash(bytes) !== expected || (name === installerExecutable && bytes.length !== manifest.bytes)) throw new Error("INSTALLER_PAYLOAD_CHANGED");
	}
	return manifest;
}

export async function verifyInstallerToolchain(root, lock) {
	if (lock.version !== "7.1.0" || !Array.isArray(lock.files) || !lock.files.length || lock.files.length > 512) throw new Error("INSTALLER_TOOLCHAIN_LOCK_INVALID");
	if ((await realpath(root)).toLowerCase() !== root.toLowerCase() || (await lstat(root)).isSymbolicLink()) throw new Error("INSTALLER_TOOLCHAIN_REDIRECTED");
	const files = [];
	async function walk(directory, prefix = "") {
		for (const name of (await readdir(directory)).sort()) {
			const path = prefix + name; bundleRelative(path); const full = join(directory, name), info = await lstat(full);
			if (info.isSymbolicLink()) throw new Error("INSTALLER_TOOLCHAIN_LINK_REJECTED");
			if (info.isDirectory()) await walk(full, path + "/");
			else if (info.isFile() && info.size <= 64 * 1024 * 1024 && files.length < 512) files.push({ path, bytes: info.size, sha256: bundleHash(await readFile(full)) });
			else throw new Error("INSTALLER_TOOLCHAIN_LIMIT");
		}
	}
	await walk(root);
	if (JSON.stringify(files) !== JSON.stringify(lock.files)) throw new Error("INSTALLER_TOOLCHAIN_CHANGED");
	return join(root, "ISCC.exe");
}
