import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { copyFrameworkNotices } from "../scripts/framework-notices.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-framework-notices-"))), cache = join(root, "cache"), output = join(root, "output"), dependencies = [];
	t.after(async () => { const canonical = await realpath(root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-framework-notices-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	await mkdir(output); const version = "8.0.28", frameworks = [{ name: "Microsoft.NETCore.App", version }, { name: "Microsoft.WindowsDesktop.App", version }];
	for (const framework of frameworks) {
		const id = framework.name + ".Runtime.win-x64", directory = join(cache, id.toLowerCase(), version); await mkdir(directory, { recursive: true });
		await writeFile(join(directory, id.toLowerCase() + ".nuspec"), "<package><metadata><id>" + id + "</id><version>" + version + "</version></metadata></package>");
		for (const file of framework.name === "Microsoft.NETCore.App" ? ["LICENSE.TXT", "THIRD-PARTY-NOTICES.TXT"] : ["LICENSE"]) await writeFile(join(directory, file), framework.name + ": " + file);
		dependencies.push({ name: id, version: "[" + version + ", " + version + "]" });
	}
	return { root, cache, output, assets: { packageFolders: { [cache]: {} }, project: { frameworks: { net8: { downloadDependencies: dependencies } } } }, runtimeConfig: { runtimeOptions: { includedFrameworks: frameworks } } };
}

test("runtime notices come from the exact resolved packs and are copied before group sealing", async t => {
	const options = await fixture(t), result = await copyFrameworkNotices(options); assert.equal(result.length, 3);
	assert.match(await readFile(join(options.output, "LICENSE-Microsoft.WindowsDesktop.App.txt"), "utf8"), /Microsoft.WindowsDesktop.App/);
	for (const file of result) { assert.equal(file.version, "8.0.28"); assert.match(file.sha256, /^[a-f0-9]{64}$/); }
	await assert.rejects(copyFrameworkNotices(options), { code: "EEXIST" });
});

test("missing version evidence or mismatched package identity produces no guessed notice files", async t => {
	const options = await fixture(t), altered = structuredClone(options); altered.assets.project.frameworks.net8.downloadDependencies[0].version = "[8.0.27, 8.0.27]";
	await assert.rejects(copyFrameworkNotices(altered), /DOWNLOAD_PIN_MISSING/); assert.deepEqual(await readdir(options.output), []);
	const path = join(options.cache, "microsoft.netcore.app.runtime.win-x64/8.0.28/microsoft.netcore.app.runtime.win-x64.nuspec");
	await writeFile(path, "<package><metadata><id>Microsoft.NETCore.App.Runtime.win-x64</id><version>8.0.27</version></metadata></package>");
	await assert.rejects(copyFrameworkNotices(options), /PACKAGE_IDENTITY_MISMATCH/); assert.deepEqual(await readdir(options.output), []);
});

test("the framework license without its provided third-party notices cannot seal a complete candidate", async t => {
	const options = await fixture(t); await rm(join(options.cache, "microsoft.netcore.app.runtime.win-x64/8.0.28/THIRD-PARTY-NOTICES.TXT"));
	await assert.rejects(copyFrameworkNotices(options), { code: "ENOENT" }); assert.deepEqual(await readdir(options.output), []);
});
