import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, open, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { publishSyntheticResearchWorld } from "../apps/desktop/synthetic-scope.mjs";

async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-mcp-recovery-")));
	t.after(async () => {
		const canonical = await realpath(directory);
		assert.equal(canonical, directory);
		assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(canonical).startsWith("commanddeck-mcp-recovery-"));
		await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	const path = join(directory, "synthetic-research-world.json"), original = { version: 1, runId: randomUUID(), commits: 0 };
	await writeFile(path, JSON.stringify(original), { flag: "wx" });
	return { directory, path, original };
}

test("synthetic publication never truncates a snapshot held by an existing reader", async t => {
	const f = await fixture(t), reader = await open(f.path, "r"), next = { ...f.original, commits: 1, padding: "NEW".repeat(700) };
	try {
		if (process.platform === "win32") {
			assert.throws(() => publishSyntheticResearchWorld(f.path, next), error => ["EPERM", "EACCES", "EBUSY"].includes(error.code));
			assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), f.original);
			const pending = (await readdir(f.directory)).filter(name => name.endsWith(".pending"));
			assert.equal(pending.length, 1);
			assert.deepEqual(JSON.parse(await readFile(join(f.directory, pending[0]), "utf8")), next);
		} else publishSyntheticResearchWorld(f.path, next);
		// A truncate-and-rewrite changes this same handle, even without a timing race.
		assert.deepEqual(JSON.parse(await reader.readFile("utf8")), f.original);
	} finally { await reader.close(); }
	publishSyntheticResearchWorld(f.path, next);
	assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), next);
});

test("an oversized synthetic snapshot is rejected before changing the published evidence", async t => {
	const f = await fixture(t);
	assert.throws(() => publishSyntheticResearchWorld(f.path, { ...f.original, padding: "X".repeat(4096) }), /SYNTHETIC_WORLD_SNAPSHOT_TOO_LARGE/);
	assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), f.original);
	assert.deepEqual(await readdir(f.directory), ["synthetic-research-world.json"]);
});
