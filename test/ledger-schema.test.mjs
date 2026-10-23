import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, realpath, readFile, readdir, rm } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchStore } from "../apps/desktop/workbench-store.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";

const legacy = JSON.parse(await readFile(new URL("./fixtures/game-ledger-v1.json", import.meta.url), "utf8"));
async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-ledger-schema-")));
	t.after(async () => { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-ledger-schema-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return directory;
}
function seedLegacy(file) {
	assert.equal(legacy.sourceRevision, "f37dae5ad59df6968e7335c12bbc8f56a2dd5aae"); assert.equal(legacy.sourceBlob, "23fa44e215e69f47b3ed695b50858daf11f36d9f"); assert.equal(legacy.gameCalls, 0);
	const database = new DatabaseSync(file);
	try {
		for (const entry of legacy.schema) database.exec(entry.sql);
		for (const [table, rows] of Object.entries(legacy.rows)) for (const row of rows) { const keys = Object.keys(row); database.prepare(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key])); }
		database.exec("PRAGMA user_version=1");
	} finally { database.close(); }
}
function options() {
	let calls = 0; const port = async () => { calls++; throw new Error("MIGRATION_MUST_NOT_CALL_TRANSPORT"); };
	return { value: { approvalAuthority: {}, prepareResearch: port, readResearchProof: port }, calls: () => calls };
}
function baseRows(database) { return Object.fromEntries(Object.keys(legacy.rows).map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))])); }

test("workbench unknown or incomplete structures refuse before altering original bytes or adding sidecars", async t => {
	const directory = await fixture(t);
	for (const [kind, sql] of [
		["foreign-v0", "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep'); PRAGMA user_version=0"],
		["negative-version", "CREATE TABLE unrelated(value TEXT); PRAGMA user_version=-1"],
		["missing-columns-v1", "CREATE TABLE changes(id TEXT); CREATE TABLE events(sequence INTEGER); CREATE TABLE invocations(id TEXT); CREATE TABLE roots(id TEXT); CREATE TABLE tasks(id TEXT); CREATE TABLE ui_state(key TEXT); PRAGMA user_version=1"],
	]) {
		const file = join(directory, kind + ".sqlite"), database = new DatabaseSync(file); database.exec(sql); database.close();
		const before = await readFile(file), members = await readdir(directory);
		assert.throws(() => new WorkbenchStore(file)); assert.deepEqual(await readFile(file), before); assert.deepEqual(await readdir(directory), members);
	}
});

test("a malformed v1 game ledger is rejected without creating v2 tables or promoting the version", async t => {
	const directory = await fixture(t), file = join(directory, "game.sqlite"), database = new DatabaseSync(file);
	database.exec("CREATE TABLE game_tasks(id TEXT PRIMARY KEY,scope TEXT,state TEXT,preview_hash TEXT,preview_boot TEXT,expires_at INTEGER,approval_id TEXT,approval_at INTEGER); CREATE TABLE game_intents(id TEXT PRIMARY KEY,task_id TEXT,idempotency_key TEXT,state TEXT,action_id TEXT,acceptance TEXT); CREATE TABLE game_gate(id INTEGER,intent_id TEXT,reason TEXT); PRAGMA user_version=1"); database.close();
	const before = await readFile(file), members = await readdir(directory), ports = options();
	assert.throws(() => new GameIntentLedger(file, ports.value)); assert.deepEqual(await readFile(file), before); assert.deepEqual(await readdir(directory), members); assert.equal(ports.calls(), 0);
	const result = new DatabaseSync(file, { readOnly: true });
	try { assert.equal(result.prepare("PRAGMA user_version").get().user_version, 1); assert.equal(result.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('game_task_details','game_task_events')").get().n, 0); } finally { result.close(); }
});

test("unexpected legacy metadata and malformed current metadata are rejected before journal or migration writes", async t => {
	const directory = await fixture(t);
	for (const version of [1, 2]) {
		const file = join(directory, "game-" + version + ".sqlite"); seedLegacy(file); const database = new DatabaseSync(file);
		database.exec("CREATE TABLE game_task_details(task_id TEXT); CREATE TABLE game_task_events(sequence INTEGER,task_id TEXT,kind TEXT,body TEXT); PRAGMA user_version=" + version); database.close();
		const before = await readFile(file), ports = options(); assert.throws(() => new GameIntentLedger(file, ports.value)); assert.deepEqual(await readFile(file), before); assert.equal(ports.calls(), 0);
	}
});

test("a ledger produced by the actual historical v1 implementation migrates with every original pending field preserved", async t => {
	const directory = await fixture(t), file = join(directory, "legacy.sqlite"); seedLegacy(file);
	const old = new DatabaseSync(file, { readOnly: true }); let original; try { original = baseRows(old); assert.equal(old.prepare("PRAGMA user_version").get().user_version, 1); } finally { old.close(); }
	assert.deepEqual(original, legacy.rows);
	const ports = options(), ledger = new GameIntentLedger(file, ports.value);
	try {
		assert.equal(ledger.db.prepare("PRAGMA user_version").get().user_version, 2); assert.deepEqual(baseRows(ledger.db), original);
		const intent = ledger.unresolved()[0], stored = original.game_intents[0]; assert.equal(ledger.unresolved().length, 1); assert.equal(intent.idempotencyKey, stored.idempotency_key); assert.equal(intent.actionId, stored.action_id); assert.deepEqual(intent.acceptance, JSON.parse(stored.acceptance));
		assert.deepEqual(ledger.events(intent.taskId), []); assert.deepEqual(ledger.tasks()[0].details, {}); assert.throws(() => ledger.confirmationPreview(intent.taskId), /FRESH_RESEARCH_PREVIEW_REQUIRED/); assert.equal(ports.calls(), 0);
	} finally { ledger.close(); }
});
