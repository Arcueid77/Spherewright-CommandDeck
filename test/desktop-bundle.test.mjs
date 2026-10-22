import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat, symlink } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { bundleRelative, ridLockedCopy, inventoryBundle, copyBundleTree, verifyBundle, bundleManifestName, bundleExecutable } from "../scripts/desktop-bundle-files.mjs";
import { assertPortableAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";

async function fixture(t, prefix = "commanddeck-bundle-test-") {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	t.after(async () => { const path = await realpath(root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith(prefix)); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root;
}

test("bundle paths reject traversal, Windows aliases, private state and proprietary game DLLs", () => {
	for (const value of ["../secret", "a/../b", "C:/outside", "a\\b", "NUL.dll", "a/name:stream", ".local/private.json", "vendor/.env", "UnityEngine.CoreModule.dll", "Assembly-CSharp.dll", "BepInEx.dll"]) assert.throws(() => bundleRelative(value));
	assert.equal(bundleRelative("resources/app/vendor/pi/node_modules/pkg/dist/index.js"), "resources/app/vendor/pi/node_modules/pkg/dist/index.js");
});

test("frozen native locks add only empty RID targets and retain every committed dependency pin", () => {
	const original = { version: 1, dependencies: { ".NETFramework,Version=v4.7.2": { ref: { resolved: "1", contentHash: "fixed" } }, "net8.0-windows7.0": { lib: { resolved: "2", contentHash: "fixed" } } } };
	const bytes = JSON.stringify(original), derived = JSON.parse(ridLockedCopy(bytes));
	assert.deepEqual(derived.dependencies["net8.0-windows7.0"], original.dependencies["net8.0-windows7.0"]); assert.deepEqual(derived.dependencies["net8.0-windows7.0/win-x64"], {});
	assert.equal(bytes, JSON.stringify(original)); derived.dependencies["net8.0-windows7.0/win-x64"] = { unexpected: {} };
	assert.throws(() => ridLockedCopy(JSON.stringify(derived)), /REQUIRE_REVIEW/);
});

test("bundle copying is physical, hashed and refuses existing bytes or linked payloads", async t => {
	const root = await fixture(t), source = join(root, "source"), target = join(root, "copy"); await mkdir(source); await writeFile(join(source, "file.txt"), "fixed");
	await copyBundleTree(source, target); const first = await inventoryBundle(target); assert.equal(first.files.length, 1); assert.match(first.files[0].sha256, /^[a-f0-9]{64}$/);
	await assert.rejects(copyBundleTree(source, target), { code: "EEXIST" }); assert.equal(await readFile(join(target, "file.txt"), "utf8"), "fixed");
	await symlink(target, join(source, "linked"), process.platform === "win32" ? "junction" : "dir"); await assert.rejects(inventoryBundle(source), /LINK_REJECTED/);
});

test("a bundle manifest detects changed or extra payloads and rejects unsafe or duplicate member records", async t => {
	const root = await fixture(t), files = [bundleExecutable, "resources/app/package.json", "resources/app/apps/desktop/main.mjs", "resources/app/dist/renderer/index.html", "resources/app/artifacts/native/CommandDeck.NativeHost.exe", "resources/app/artifacts/native/hostfxr.dll", "resources/app/artifacts/native/System.Windows.Forms.dll", "resources/app/artifacts/commands/command-host-cohort.json", "resources/app/vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js"];
	for (const path of files) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), "fixture"); }
	const manifest = { version: 1, kind: "commanddeck-windows-portable", runtimeIdentifier: "win-x64", executable: bundleExecutable, sourceRevision: "a".repeat(40), piCommit: "b".repeat(40), selfContained: true, ...await inventoryBundle(root) };
	const path = join(root, bundleManifestName); await writeFile(path, JSON.stringify(manifest)); await verifyBundle(root);
	await writeFile(join(root, bundleExecutable), "changed"); await assert.rejects(verifyBundle(root), /PAYLOAD_CHANGED/); await writeFile(join(root, bundleExecutable), "fixture");
	await writeFile(join(root, "extra.txt"), "extra"); await assert.rejects(verifyBundle(root), /PAYLOAD_CHANGED/); await rm(join(root, "extra.txt"));
	for (const transform of [value => value.files.push(value.files[0]), value => { value.files[0].path = "../outside"; }, value => { value.selfContained = false; }]) {
		const value = structuredClone(manifest); transform(value); await writeFile(path, JSON.stringify(value)); await assert.rejects(verifyBundle(root));
	}
});

test("portable verification cannot reach a game, external model, developer command or adapter", () => {
	for (const [action, args] of [["bridge-select", "server.exe"], ["bridge", { action: "connect" }], ["game", { action: "start" }], ["probe", { mode: "live" }], ["workbench", { action: "check" }], ["profiles-manage", { action: "save" }], ["attach", "adapter:1-2"]]) assert.throws(() => assertPortableAction(action, args), /PORTABLE_SMOKE_ACTION_REJECTED/);
	for (const [action, args] of [["probe", { mode: "offline" }], ["attach", "owned-fixture"], ["workbench", { action: "state" }]]) assert.doesNotThrow(() => assertPortableAction(action, args));
});

test("portable mode uses only a fresh temporary profile and rejects source-app or extra launch flags", async t => {
	const root = await fixture(t, "commanddeck-desktop-smoke-"), env = { COMMANDDECK_PORTABLE_ROOT: root, COMMANDDECK_PORTABLE_RUN_ID: "a".repeat(36) }, calls = [], app = { isPackaged: true, setPath: (...args) => calls.push(args) };
	const value = await preparePortableMode(app, ["program", "--portable-smoke"], env); assert.equal(value.root, root); assert.equal(calls[0][1], join(root, "supervisor-profile")); assert.equal((await lstat(calls[0][1])).isSymbolicLink(), false);
	await assert.rejects(preparePortableMode({ ...app, isPackaged: false }, ["program", "--portable-smoke"], env), /PACKAGED_PORTABLE_SMOKE_REQUIRED/);
	await assert.rejects(preparePortableMode(app, ["program", "--portable-smoke", "--workspace"], env), /PACKAGED_PORTABLE_SMOKE_REQUIRED/);
});
