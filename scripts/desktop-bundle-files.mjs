import { lstat, readdir, readFile, mkdir, writeFile, realpath } from "node:fs/promises";
import { dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

export const bundleManifestName = "commanddeck-bundle.json";
export const bundleExecutable = "Spherewright-CommandDeck.exe";
export const bundleHash = bytes => createHash("sha256").update(bytes).digest("hex");
export function bundleRelative(value) {
	if (typeof value !== "string" || !value || value.length > 1800 || value.includes("\\") || isAbsolute(value)) throw new Error("BUNDLE_PATH_INVALID");
	for (const part of value.split("/")) if (!part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error("BUNDLE_PATH_INVALID");
	if (value.split("/").some(part => /^(?:\.git|\.local|\.pi|userdata|\.npmrc|\.env(?:\..*)?)$/i.test(part)) || /(?:^|\/)(?:Assembly-CSharp|UnityEngine(?:\.[^/]*)?|BepInEx(?:\.[^/]*)?)\.dll$/i.test(value)) throw new Error("BUNDLE_PRIVATE_PAYLOAD_REJECTED");
	return value;
}

export async function inventoryBundle(root) {
	const files = [], names = new Set(); let total = 0;
	async function walk(directory, prefix = "") {
		for (const name of (await readdir(directory)).sort()) {
			const path = prefix + name; bundleRelative(path);
			if (names.has(path.toLowerCase())) throw new Error("BUNDLE_CASE_COLLISION"); names.add(path.toLowerCase());
			const source = join(directory, name), info = await lstat(source);
			if (info.isSymbolicLink()) throw new Error("BUNDLE_PAYLOAD_LINK_REJECTED");
			if (info.isDirectory()) await walk(source, path + "/");
			else {
				if (path === bundleManifestName) continue;
				if (!info.isFile() || info.size > 512 * 1024 * 1024 || files.length >= 30000 || total + info.size > 2 * 1024 * 1024 * 1024) throw new Error("BUNDLE_PAYLOAD_LIMIT");
				const bytes = await readFile(source); if (bytes.length !== info.size) throw new Error("BUNDLE_PAYLOAD_CHANGED");
				files.push({ path, bytes: bytes.length, sha256: bundleHash(bytes) }); total += bytes.length;
			}
		}
	}
	const info = await lstat(root); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("BUNDLE_ROOT_INVALID");
	await walk(root); return { files, bytes: total };
}

export async function copyBundleTree(source, target, { skip = () => false, path = "" } = {}) {
	const info = await lstat(source);
	if (info.isSymbolicLink()) throw new Error("BUNDLE_PAYLOAD_LINK_REJECTED");
	if (info.isDirectory()) {
		await mkdir(target, { recursive: true });
		for (const name of (await readdir(source)).sort()) {
			const child = path ? path + "/" + name : name; bundleRelative(child);
			if (!skip(child)) await copyBundleTree(join(source, name), join(target, name), { skip, path: child });
		}
	} else {
		if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("BUNDLE_PAYLOAD_LIMIT");
		await mkdir(dirname(target), { recursive: true }); await writeFile(target, await readFile(source), { flag: "wx" });
	}
}

// NuGet's empty RID targets are metadata, not new dependencies. Derive them
// only in the frozen build copy; all committed package pins stay byte-for-byte.
export function ridLockedCopy(bytes) {
	const value = JSON.parse(bytes), dependencies = value.dependencies;
	if (value.version !== 1 || !dependencies || Object.keys(dependencies).some(key => ![".NETFramework,Version=v4.7.2", "net8.0-windows7.0", ".NETFramework,Version=v4.7.2/win-x64", "net8.0-windows7.0/win-x64"].includes(key))) throw new Error("NATIVE_LOCK_FORMAT_UNSUPPORTED");
	for (const target of [".NETFramework,Version=v4.7.2", "net8.0-windows7.0"]) {
		if (!Object.hasOwn(dependencies, target)) throw new Error("NATIVE_LOCK_TARGET_MISSING");
		const rid = target + "/win-x64";
		if (Object.hasOwn(dependencies, rid) && !isDeepStrictEqual(dependencies[rid], {})) throw new Error("NATIVE_RID_DEPENDENCIES_REQUIRE_REVIEW");
		dependencies[rid] = {};
	}
	return Buffer.from(JSON.stringify(value, null, 2));
}

export async function verifyBundle(root) {
	const path = join(root, bundleManifestName), info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error("BUNDLE_MANIFEST_INVALID");
	const value = JSON.parse(await readFile(path, "utf8"));
	if (value.version !== 1 || value.kind !== "commanddeck-windows-portable" || value.runtimeIdentifier !== "win-x64" || !/^[a-f0-9]{40}$/.test(value.sourceRevision ?? "") || !/^[a-f0-9]{40}$/.test(value.piCommit ?? "") || value.executable !== bundleExecutable || value.selfContained !== true || !Array.isArray(value.files) || !value.files.length || value.files.length > 30000) throw new Error("BUNDLE_MANIFEST_INVALID");
	const seen = new Set();
	for (const file of value.files) {
		bundleRelative(file.path); const key = file.path.toLowerCase();
		if (seen.has(key) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256 ?? "")) throw new Error("BUNDLE_MANIFEST_INVALID"); seen.add(key);
	}
	for (const required of [bundleExecutable, "resources/app/package.json", "resources/app/apps/desktop/main.mjs", "resources/app/dist/renderer/index.html", "resources/app/artifacts/native/CommandDeck.NativeHost.exe", "resources/app/artifacts/native/hostfxr.dll", "resources/app/artifacts/native/System.Windows.Forms.dll", "resources/app/artifacts/commands/command-host-cohort.json", "resources/app/vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js"]) if (!seen.has(required.toLowerCase())) throw new Error("BUNDLE_REQUIRED_PAYLOAD_MISSING");
	if (value.rendererNotices !== undefined) {
		const notices = value.rendererNotices, file = value.files.find(file => file.path === "resources/app/dist/renderer/THIRD-PARTY-LICENSES.md");
		if (!file || notices?.path !== file.path || notices.sha256 !== file.sha256 || !Array.isArray(notices.packages) || notices.packages.length !== 5 || new Set(notices.packages.map(pkg => pkg.name)).size !== 5 || notices.packages.some(pkg => !["dockview-core", "dockview-react", "react-dom", "react", "scheduler"].includes(pkg.name) || typeof pkg.version !== "string" || typeof pkg.license !== "string" || !/^[a-f0-9]{64}$/.test(pkg.sourceLicenseSha256 ?? ""))) throw new Error("BUNDLE_RENDERER_NOTICES_INVALID");
	}
	if (value.frameworkNotices !== undefined) {
		if (!Array.isArray(value.nativeFrameworks) || value.nativeFrameworks.length !== 2) throw new Error("BUNDLE_FRAMEWORK_NOTICES_INVALID");
		for (const folder of ["native", "commands"]) {
			const records = value.frameworkNotices?.[folder], expected = ["LICENSE-Microsoft.NETCore.App.txt", "THIRD-PARTY-NOTICES-Microsoft.NETCore.App.txt", ...(folder === "native" ? ["LICENSE-Microsoft.WindowsDesktop.App.txt"] : [])];
			if (!Array.isArray(records) || records.length !== expected.length || new Set(records.map(record => record.name)).size !== expected.length) throw new Error("BUNDLE_FRAMEWORK_NOTICES_INVALID");
			for (const record of records) {
				const file = value.files.find(file => file.path === "resources/app/artifacts/" + folder + "/" + record.name);
				const sourceName = record.framework === "Microsoft.WindowsDesktop.App" ? "LICENSE" : record.name.startsWith("THIRD-") ? "THIRD-PARTY-NOTICES.TXT" : "LICENSE.TXT";
				if (!expected.includes(record.name) || !file || file.sha256 !== record.sha256 || file.bytes !== record.bytes || !["Microsoft.NETCore.App", "Microsoft.WindowsDesktop.App"].includes(record.framework) || record.packageId !== record.framework + ".Runtime.win-x64" || !value.nativeFrameworks.some(framework => framework.name === record.framework && framework.version === record.version) || !record.name.endsWith("-" + record.framework + ".txt") || record.sourceName !== sourceName) throw new Error("BUNDLE_FRAMEWORK_NOTICES_INVALID");
			}
		}
	}
	const actual = await inventoryBundle(root);
	if (!isDeepStrictEqual(actual.files, value.files) || actual.bytes !== value.bytes) throw new Error("BUNDLE_PAYLOAD_CHANGED");
	return value;
}
