import { readFile, realpath, lstat, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, basename, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";

const packageName = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/;
const validPackage = name => typeof name === "string" && name.length <= 214 && packageName.test(name) && !name.split("/").some(part => [".", ".."].includes(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
const inside = (root, path) => {
	const value = relative(root.toLowerCase(), path.toLowerCase());
	return !isAbsolute(value) && value !== ".." && !value.startsWith(".." + sep);
};
const slash = path => path.replaceAll("\\", "/");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Follow Node's physical package ancestry, including nested versions. Only the
// build checkout's internal workspace links may be materialized; no link ships.
export async function collectPiRuntime(directory) {
	const root = await realpath(directory), records = new Map();
	async function locate(from, name) {
		if (!validPackage(name)) throw new Error("PI_RUNTIME_PACKAGE_NAME_INVALID");
		for (let at = from; inside(root, at); at = dirname(at)) {
			const candidate = join(at, "node_modules", ...name.split("/"));
			try {
				await lstat(join(candidate, "package.json"));
				const actual = await realpath(candidate);
				if (!inside(root, actual)) throw new Error("PI_RUNTIME_DEPENDENCY_ESCAPED");
				return actual;
			} catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
			if (at === root) break;
		}
		return null;
	}
	async function visit(path) {
		path = await realpath(path);
		if (!inside(root, path)) throw new Error("PI_RUNTIME_DEPENDENCY_ESCAPED");
		if (records.has(path)) return records.get(path);
		if (records.size >= 512) throw new Error("PI_RUNTIME_DEPENDENCY_LIMIT");
		const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
		if (!validPackage(manifest.name) || typeof manifest.version !== "string") throw new Error("PI_RUNTIME_PACKAGE_INVALID");
		const source = slash(relative(root, path)), internal = manifest.name.startsWith("@earendil-works/pi-");
		if (internal && (!/^packages\/[^/]+$/.test(source) || manifest.version !== "1.3.0")) throw new Error("PI_RUNTIME_FORK_PACKAGE_REQUIRED");
		const item = { path, source, manifest, internal, dependencies: [], absentOptional: [] };
		records.set(path, item);
		const dependencies = { ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies };
		for (const name of Object.keys(dependencies)) {
			const dependency = await locate(path, name);
			if (!dependency) {
				if (Object.hasOwn(manifest.optionalDependencies ?? {}, name) || manifest.peerDependenciesMeta?.[name]?.optional === true) { item.absentOptional.push(name); continue; }
				throw new Error("PI_RUNTIME_DEPENDENCY_MISSING: " + name);
			}
			const resolved = await visit(dependency);
			if (resolved.manifest.name !== name) throw new Error("PI_RUNTIME_DEPENDENCY_NAME_MISMATCH");
			item.dependencies.push({ name, path: dependency });
		}
		return item;
	}
	await visit(join(root, "packages/coding-agent"));
	const all = [...records.values()], internals = all.filter(item => item.internal);
	for (const item of all) {
		if (item.internal) item.target = "node_modules/" + item.manifest.name;
		else {
			const owner = internals.find(parent => item.source.startsWith(parent.source + "/node_modules/"));
			item.target = owner ? "node_modules/" + owner.manifest.name + item.source.slice(owner.source.length) : item.source;
			if (!item.target.startsWith("node_modules/") || item.target.split("/").some(part => [".", "..", ""].includes(part))) throw new Error("PI_RUNTIME_LAYOUT_UNSUPPORTED");
		}
	}
	const targets = new Map(all.map(item => [item.target.toLowerCase(), item]));
	if (targets.size !== all.length) throw new Error("PI_RUNTIME_LAYOUT_COLLISION");
	for (const item of all) for (const edge of item.dependencies) {
		let found;
		for (let at = item.target; ; at = slash(dirname(at))) {
			found = targets.get((at + "/node_modules/" + edge.name).toLowerCase());
			if (found || at === ".") break;
		}
		found ??= targets.get(("node_modules/" + edge.name).toLowerCase());
		if (found?.path !== edge.path) throw new Error("PI_RUNTIME_RESOLUTION_CHANGED");
	}
	return { root, packages: all };
}

export async function materializePiRuntime(source, target) {
	const plan = await collectPiRuntime(source);
	if (!isAbsolute(target)) throw new Error("PI_RUNTIME_OUTPUT_INVALID");
	// Windows temporary paths may contain an 8.3 alias. Bind the existing parent
	// once, then create and address the new physical root through that canonical
	// path. Never copy through a subsequently changed parent link.
	target = join(await realpath(dirname(target)), basename(target));
	if (inside(plan.root, target)) throw new Error("PI_RUNTIME_OUTPUT_INVALID");
	await mkdir(target); // A new physical directory only; never replace an old candidate.
	if ((await realpath(target)).toLowerCase() !== target.toLowerCase()) throw new Error("PI_RUNTIME_OUTPUT_REDIRECTED");
	const files = []; let bytesTotal = 0;
	async function copy(from, to, destination) {
		const info = await lstat(from);
		if (info.isSymbolicLink()) throw new Error("PI_RUNTIME_PAYLOAD_LINK_REJECTED");
		if (info.isDirectory()) {
			await mkdir(to, { recursive: true });
			for (const name of (await readdir(from)).sort()) {
				if (["node_modules", ".git", ".local", ".pi"].includes(name)) continue;
				if (name === ".npmrc" || /^\.env(?:\.|$)/i.test(name)) throw new Error("PI_RUNTIME_PRIVATE_PAYLOAD_REJECTED");
				if (/[<>:"|?*\x00-\x1f]/.test(name) || name.endsWith(".") || name.endsWith(" ") || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error("PI_RUNTIME_PAYLOAD_NAME_INVALID");
				await copy(join(from, name), join(to, name), destination + "/" + name);
			}
			return;
		}
		if (!info.isFile() || info.size > 128 * 1024 * 1024 || files.length >= 50000 || bytesTotal + info.size > 512 * 1024 * 1024) throw new Error("PI_RUNTIME_PAYLOAD_LIMIT");
		const bytes = await readFile(from); if (bytes.length !== info.size) throw new Error("PI_RUNTIME_PAYLOAD_CHANGED");
		await mkdir(dirname(to), { recursive: true });
		await writeFile(to, bytes, { flag: "wx" });
		files.push({ path: destination, bytes: bytes.length, sha256: hash(bytes) }); bytesTotal += bytes.length;
	}
	for (const item of plan.packages) {
		const to = join(target, item.target);
		if (!item.internal) await copy(item.path, to, item.target);
		else {
			// This embeds the SDK, not a second Pi CLI or extension/example loader.
			for (const name of (await readdir(item.path)).sort()) {
				if (!["package.json", "dist", "native", "schemas", "LICENSES"].includes(name) && !/^(?:LICENSE|COPYING|NOTICE|README|CHANGELOG)(?:\.|$)/i.test(name)) continue;
				await copy(join(item.path, name), join(to, name), item.target + "/" + name);
			}
			if (!files.some(file => file.path === item.target + "/dist/index.js")) throw new Error("PI_RUNTIME_BUILT_ENTRY_REQUIRED");
		}
	}
	await copy(join(plan.root, "LICENSE"), join(target, "LICENSE"), "LICENSE");
	return {
		packages: plan.packages.map(item => ({ name: item.manifest.name, version: item.manifest.version, path: item.target, fork: item.internal, absentOptional: item.absentOptional })),
		files, bytes: bytesTotal,
	};
}
