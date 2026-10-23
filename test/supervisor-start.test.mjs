import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { startSupervisor } from "../apps/desktop/supervisor-start.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-supervisor-start-")));
	t.after(async () => { const canonical = await realpath(root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-supervisor-start-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root;
}

test("a secondary instance exits before runtime loading can create or migrate a ledger", async t => {
	const root = await fixture(t), events = [], ledger = join(root, "supervisor/ledger-witness");
	const app = { getPath: () => root, setPath: (name, path) => { assert.equal(name, "userData"); assert.equal(path, join(root, "supervisor")); events.push("path"); }, requestSingleInstanceLock: () => { events.push("lock"); return false; }, exit: code => events.push("exit:" + code) };
	const result = await startSupervisor(app, { smoke: true, notice: code => events.push(code), load: async () => { await writeFile(ledger, "opened"); } });
	assert.equal(result.primary, false); assert.deepEqual(events, ["path", "lock", "SMOKE_INSTANCE_ALREADY_RUNNING", "exit:1"]); await assert.rejects(lstat(ledger), { code: "ENOENT" });
});

test("the primary instance keeps the existing profile path and loads resources only after ownership", async t => {
	const root = await fixture(t), events = [];
	const app = { getPath: () => root, setPath: (_name, path) => events.push(path), requestSingleInstanceLock: () => { events.push("lock"); return true; }, exit: () => assert.fail("primary must not exit") };
	assert.equal((await startSupervisor(app, { load: async () => events.push("load") })).primary, true); assert.deepEqual(events, [join(root, "supervisor"), "lock", "load"]);
});
