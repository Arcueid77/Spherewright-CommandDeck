import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, link, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { copyCommandToolchain } from "../scripts/command-toolchain-fixture.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-toolchain-fixture-")));
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-toolchain-fixture-")); await rm(canonical, { recursive: true }); });
	const source = join(root, "source"); await mkdir(source); return { root, source, target: join(root, "target") };
}

test("developer toolchain copying excludes npm configuration without reading or changing the source", async t => {
	const f = await fixture(t); await mkdir(join(f.source, "bin")); await writeFile(join(f.source, "bin/npm-cli.js"), "fixture code\n");
	await writeFile(join(f.source, ".npmrc"), "private fixture canary\n");
	const result = await copyCommandToolchain(f.source, f.target); assert.equal(result.npmConfigurationExcluded, true);
	assert.equal(await readFile(join(f.target, "bin/npm-cli.js"), "utf8"), "fixture code\n"); await assert.rejects(readFile(join(f.target, ".npmrc")), { code: "ENOENT" });
	assert.equal(await readFile(join(f.source, ".npmrc"), "utf8"), "private fixture canary\n"); await assert.rejects(copyCommandToolchain(f.source, f.target), { code: "EEXIST" });
});

test("developer toolchains still reject aliased code and other private configuration", async t => {
	const f = await fixture(t); await writeFile(join(f.root, "outside.js"), "outside\n"); await link(join(f.root, "outside.js"), join(f.source, "aliased.js"));
	await assert.rejects(copyCommandToolchain(f.source, f.target), /COMMAND_TOOLCHAIN_REDIRECTED/); assert.equal(await readFile(join(f.root, "outside.js"), "utf8"), "outside\n");
	const separate = await fixture(t); await writeFile(join(separate.source, ".env"), "private\n"); await assert.rejects(copyCommandToolchain(separate.source, separate.target), /COMMAND_TOOLCHAIN_PRIVATE_CONFIG/);
});
