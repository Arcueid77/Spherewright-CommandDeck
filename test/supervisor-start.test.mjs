import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, lstat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { startSupervisor } from "../apps/desktop/supervisor-start.mjs";
import { startupFailureCode, startupFailurePage } from "../apps/desktop/startup-failure.mjs";

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

test("failed bootstrap retains ownership and returns before ready, then shows only a sanitized blocked state", async t => {
	const root = await fixture(t), events = []; let ready;
	const app = { getPath: () => root, setPath: () => {}, requestSingleInstanceLock: () => true, exit: code => events.push("exit:" + code), whenReady: () => new Promise(resolve => { ready = resolve; }) };
	const result = await startSupervisor(app, { notice: code => events.push(code), load: async () => { throw new Error("GAME_LEDGER_SCHEMA_UNSUPPORTED"); }, blocked: async code => events.push("shown:" + code) });
	assert.deepEqual(result, { primary: true, blocked: true, code: "GAME_LEDGER_SCHEMA_UNSUPPORTED" }); assert.deepEqual(events, ["GAME_LEDGER_SCHEMA_UNSUPPORTED"]);
	ready(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ["GAME_LEDGER_SCHEMA_UNSUPPORTED", "shown:GAME_LEDGER_SCHEMA_UNSUPPORTED"]);
});

test("startup diagnostics discard raw storage messages and HTML never includes caller text or executable scripts", () => {
	const secret = "<script>private credential and path</script>";
	for (const error of [Object.assign(new Error(secret), { code: "ERR_SQLITE_ERROR" }), Object.assign(new Error(secret), { code: "ENOSPC" })]) assert.equal(startupFailureCode(error), "STARTUP_STORAGE_UNAVAILABLE");
	assert.equal(startupFailureCode(new Error(secret)), "STARTUP_FAILED");
	for (const code of [secret, "STARTUP_STORAGE_UNAVAILABLE", "GAME_LEDGER_SCHEMA_UNSUPPORTED"]) {
		const page = startupFailurePage(code); assert.ok(page.includes("启动受阻")); assert.ok(page.includes("default-src 'none'")); assert.ok(!page.includes(secret)); assert.ok(!page.includes("<script"));
	}
});

test("sanitized runtime-initialization errors retain their classification across the process boundary", () => {
	for (const error of [new Error("WORKBENCH_SCHEMA_TOO_NEW"), new Error("WORKBENCH_SCHEMA_UNKNOWN"), Object.assign(new Error("private database path"), { code: "ERR_SQLITE_ERROR" }), Object.assign(new Error("private disk path"), { code: "ENOSPC" })]) {
		const code = startupFailureCode(error); assert.equal(startupFailureCode(new Error(code)), code);
		const page = startupFailurePage(code); assert.ok(page.includes(code)); assert.ok(!page.includes("private"));
	}
});
