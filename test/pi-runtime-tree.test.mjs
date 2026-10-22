import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, lstat } from "node:fs/promises";
import { join, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { collectPiRuntime, materializePiRuntime } from "../scripts/pi-runtime-tree.mjs";

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), "commanddeck-pi-tree-")), source = join(directory, "source"), target = join(directory, "runtime");
	t.after(async () => {
		const canonical = await realpath(directory);
		assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(canonical).startsWith("commanddeck-pi-tree-"));
		await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	async function pkg(path, name, version, dependencies = {}, script = "export default 1;") {
		const location = join(source, path); await mkdir(join(location, "dist"), { recursive: true });
		await writeFile(join(location, "package.json"), JSON.stringify({ name, version, type: "module", main: "dist/index.js", dependencies }));
		await writeFile(join(location, "dist/index.js"), script); return location;
	}
	const agent = await pkg("packages/coding-agent", "@earendil-works/pi-coding-agent", "1.3.0", { "tree-leaf": "1", "@earendil-works/pi-ai": "1.3.0" }, 'import leaf from "tree-leaf"; import ai from "@earendil-works/pi-ai"; export default [leaf, ai];');
	const ai = await pkg("packages/ai", "@earendil-works/pi-ai", "1.3.0", { "tree-leaf": "2" }, 'import leaf from "tree-leaf"; export default leaf;');
	await pkg("node_modules/tree-leaf", "tree-leaf", "1.0.0");
	await pkg("packages/ai/node_modules/tree-leaf", "tree-leaf", "2.0.0", {}, "export default 2;");
	await mkdir(join(source, "node_modules/@earendil-works"), { recursive: true });
	for (const [name, path] of [["pi-coding-agent", agent], ["pi-ai", ai]]) await symlink(path, join(source, "node_modules/@earendil-works", name), process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(source, "LICENSE"), "fixture license\n");
	return { directory, source, target, agent, ai, pkg };
}
async function removeFixtureTree(f, path) {
	const canonical = await realpath(path), base = await realpath(f.directory), name = relative(base, canonical);
	assert.ok(name && !isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep));
	await rm(canonical, { recursive: true });
}

test("a physical portable Pi tree preserves fork identities and nested dependency resolution", async t => {
	const f = await fixture(t), result = await materializePiRuntime(f.source, f.target);
	assert.equal(result.packages.length, 4); assert.equal(result.packages.filter(item => item.fork).length, 2);
	assert.deepEqual((await import(pathToFileURL(join(f.target, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")))).default, [1, 2]);
	for (const item of result.packages) assert.equal((await lstat(join(f.target, item.path))).isSymbolicLink(), false);
	assert.equal(await readFile(join(f.target, "LICENSE"), "utf8"), "fixture license\n");
	assert.ok(result.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
	await assert.rejects(materializePiRuntime(f.source, f.target), { code: "EEXIST" });
});

test("missing required dependencies and registry substitutes for fork packages are rejected", async t => {
	const f = await fixture(t);
	await removeFixtureTree(f, join(f.source, "node_modules/tree-leaf"));
	await assert.rejects(collectPiRuntime(f.source), /DEPENDENCY_MISSING/);
	await f.pkg("node_modules/tree-leaf", "tree-leaf", "1.0.0");
	await rm(join(f.source, "node_modules/@earendil-works/pi-ai"));
	await f.pkg("node_modules/@earendil-works/pi-ai", "@earendil-works/pi-ai", "1.3.0");
	await assert.rejects(collectPiRuntime(f.source), /FORK_PACKAGE_REQUIRED/);
});

test("private payloads and links escaping the runtime source cannot be packaged", async t => {
	const f = await fixture(t), leaf = join(f.source, "node_modules/tree-leaf");
	await writeFile(join(leaf, ".env"), "SYNTHETIC_PRIVATE_FIXTURE");
	await assert.rejects(materializePiRuntime(f.source, f.target), /PRIVATE_PAYLOAD_REJECTED/);
	await rm(join(leaf, ".env"));
	const outside = join(f.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "package.json"), JSON.stringify({ name: "tree-leaf", version: "1.0.0" }));
	await symlink(outside, join(leaf, "dist/linked"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(materializePiRuntime(f.source, join(f.directory, "linked-runtime")), /PAYLOAD_LINK_REJECTED/);
	await removeFixtureTree(f, leaf); await symlink(outside, leaf, process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(collectPiRuntime(f.source), /DEPENDENCY_ESCAPED/);
});
