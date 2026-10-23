import { readFile, lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { bundleHash } from "./desktop-bundle-files.mjs";

const layouts = {
	"Microsoft.NETCore.App": [["LICENSE.TXT", "LICENSE"], ["THIRD-PARTY-NOTICES.TXT", "THIRD-PARTY-NOTICES"]],
	"Microsoft.WindowsDesktop.App": [["LICENSE", "LICENSE"]],
};
async function sourceFile(path) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) throw new Error("FRAMEWORK_NOTICE_SOURCE_INVALID");
	return readFile(path);
}

// Runtime-pack notices are not publish assets. Copy the exact packages that
// produced this runtime, before sealing the helper's complete file group.
export async function copyFrameworkNotices({ assets, runtimeConfig, output }) {
	const frameworks = runtimeConfig.runtimeOptions?.includedFrameworks, folders = Object.keys(assets.packageFolders ?? {}), planned = [], seen = new Set();
	if (!Array.isArray(frameworks) || !frameworks.length || frameworks.length > 2 || !folders.length || folders.length > 16 || !folders.every(isAbsolute) || !isAbsolute(output) || (await realpath(output)).toLowerCase() !== output.toLowerCase()) throw new Error("FRAMEWORK_NOTICE_EVIDENCE_INVALID");
	for (const framework of frameworks) {
		if (!Object.hasOwn(layouts, framework.name) || !/^8\.\d+\.\d+$/.test(framework.version ?? "") || seen.has(framework.name)) throw new Error("FRAMEWORK_NOTICE_VERSION_UNSUPPORTED");
		seen.add(framework.name);
		const packageId = framework.name + ".Runtime.win-x64", version = framework.version;
		const declared = Object.values(assets.project?.frameworks ?? {}).some(target => target.downloadDependencies?.some(item => item.name?.toLowerCase() === packageId.toLowerCase() && item.version?.replaceAll(" ", "") === "[" + version + "," + version + "]"));
		if (!declared) throw new Error("FRAMEWORK_NOTICE_DOWNLOAD_PIN_MISSING");
		let directory;
		for (const folder of folders) {
			const path = join(folder, packageId.toLowerCase(), version);
			try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("FRAMEWORK_NOTICE_PACKAGE_INVALID"); directory = path; break; }
			catch (error) { if (error.code !== "ENOENT") throw error; }
		}
		if (!directory) throw new Error("FRAMEWORK_NOTICE_PACKAGE_MISSING");
		const xml = (await sourceFile(join(directory, packageId.toLowerCase() + ".nuspec"))).toString("utf8");
		if (xml.match(/<id>([^<]+)<\/id>/)?.[1]?.toLowerCase() !== packageId.toLowerCase() || xml.match(/<version>([^<]+)<\/version>/)?.[1] !== version) throw new Error("FRAMEWORK_NOTICE_PACKAGE_IDENTITY_MISMATCH");
		for (const [sourceName, label] of layouts[framework.name]) {
			const bytes = await sourceFile(join(directory, sourceName)), name = label + "-" + framework.name + ".txt";
			planned.push({ framework: framework.name, version, packageId, sourceName, name, bytes });
		}
	}
	const result = [];
	for (const file of planned) {
		await writeFile(join(output, file.name), file.bytes, { flag: "wx" });
		result.push({ framework: file.framework, version: file.version, packageId: file.packageId, sourceName: file.sourceName, name: file.name, bytes: file.bytes.length, sha256: bundleHash(file.bytes) });
	}
	return result;
}
