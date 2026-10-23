import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { bundleHash } from "./desktop-bundle-files.mjs";

export const rendererNoticePackages = ["dockview-core", "dockview-react", "react-dom", "react", "scheduler"];
const normalized = text => text.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n").trim();

async function boundedFile(path) {
	const info = await lstat(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 1024 * 1024) throw new Error("RENDERER_NOTICE_FILE_INVALID");
	return readFile(path);
}

export async function verifyRendererNotices(repository, path, lock) {
	const bytes = await boundedFile(path), text = normalized(bytes.toString("utf8")), packages = [], modules = await realpath(join(repository, "node_modules"));
	for (const name of rendererNoticePackages) {
		const directory = join(modules, name);
		if ((await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("RENDERER_NOTICE_PACKAGE_REDIRECTED");
		const pkg = JSON.parse(await boundedFile(join(directory, "package.json")));
		if (pkg.name !== name || typeof pkg.version !== "string" || pkg.version !== lock.packages?.["node_modules/" + name]?.version || typeof pkg.license !== "string" || !pkg.license || pkg.license.length > 200) throw new Error("RENDERER_NOTICE_PACKAGE_PIN_MISMATCH");
		const names = (await readdir(directory)).filter(name => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(name));
		if (names.length !== 1) throw new Error("RENDERER_NOTICE_SOURCE_AMBIGUOUS");
		const license = await boundedFile(join(directory, names[0])), full = normalized(license.toString("utf8"));
		if (full.length < 20 || !text.includes("## " + name + " - " + pkg.version + " (" + pkg.license + ")") || !text.includes(full)) throw new Error("RENDERER_COMPLETE_NOTICE_MISSING");
		packages.push({ name, version: pkg.version, license: pkg.license, sourceLicenseSha256: bundleHash(license) });
	}
	return { path: "resources/app/dist/renderer/THIRD-PARTY-LICENSES.md", sha256: bundleHash(bytes), packages };
}
