import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, readFile, link, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { EventJournal } from "../apps/desktop/event-journal.mjs";
import { JournalProjector, journalLimits } from "../apps/desktop/journal-format.mjs";

async function fixture(t, options) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-journal-"))), stores = [];
	t.after(async () => { for (const store of stores) if (!store.closed) store.close(); const canonical = await realpath(directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-journal-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { directory, open: () => { const store = new EventJournal(directory, options); stores.push(store); return store; } };
}
test("journal projection keeps stable per-recording aliases and never persists text, credentials, paths or original identities", () => {
	const projector = new JournalProjector(), secret = "PRIVATE_TOKEN_AND_PATH", id = "PRIVATE_ORIGINAL_TASK";
	const first = projector.project({ type: "workbench", taskId: id, kind: "task", facts: { state: "running", code: secret }, prompt: secret, text: secret });
	const second = projector.project({ type: "workbench", taskId: "another-private-task", kind: "assistant", text: secret });
	const repeated = projector.project({ type: "workbench", taskId: id, kind: "tool", facts: { name: "workspace_read", arguments: { path: secret }, result: secret } });
	assert.equal(first.task, repeated.task); assert.notEqual(first.task, second.task);
	const game = projector.project({ type: "game-changed" }, { game: { currentTaskId: id, phase: "accepted", unresolved: [{ actionId: secret }], prompt: secret, scope: { sessionId: secret } } });
	for (const value of [secret, id, "another-private-task", "sessionId", "actionId", "arguments"]) assert.ok(!JSON.stringify([first, second, repeated, game]).includes(value));
	assert.equal(projector.project({ type: "text", text: secret }), null);
	const forwardedTool = projector.project({ type: "tool_execution_start", tool: "deck_echo" });
	assert.equal(forwardedTool.facts.tool, "deck_echo"); assert.equal(forwardedTool.facts.state, "running");
	assert.equal(projector.project({ type: "tool_execution_end", toolName: "deck_echo" }).facts.tool, "deck_echo");
	assert.equal(projector.project({ type: "tool_execution_start", tool: secret }).facts.tool, null);
});
test("stopped recordings and bookmarks reopen as data while a crashed active recording becomes interrupted", async t => {
	const f = await fixture(t), store = f.open(); store.start({ sourceRevision: "a".repeat(40), piCommit: "b".repeat(40), credential: "PRIVATE" });
	store.capture({ type: "probe-result", result: { requestCount: 2, executed: 1, text: "PRIVATE" } });
	const id = store.snapshot().activeId; store.bookmark(id, 2, "verified"); store.stop(); const original = store.read(id);
	assert.equal(original.executionAuthority, false); assert.equal(original.readOnly, true); assert.equal(original.bookmarks.length, 1); assert.ok(!JSON.stringify(original).includes("PRIVATE"));
	store.start({}); const interruptedId = store.snapshot().activeId; store.close(); const reopened = f.open();
	assert.deepEqual(reopened.read(id), original); assert.equal(reopened.snapshot().activeId, null);
	assert.equal(reopened.read(interruptedId).recording.state, "interrupted"); assert.equal(reopened.read(interruptedId).recording.stoppedAt, null);
	assert.throws(() => reopened.bookmark(id, 1, "attention"), /JOURNAL_BOOKMARK_INVALID/);
});
test("event bounds stop recording explicitly and storage failure latches without deleting or replaying events", async t => {
	const f = await fixture(t, { limits: { ...journalLimits, events: 3 } }), store = f.open(); store.start({}); const id = store.snapshot().activeId;
	store.capture({ type: "probe-state", busy: true }); store.capture({ type: "probe-state", busy: false });
	const limited = store.read(id); assert.equal(store.snapshot().activeId, null); assert.equal(limited.events.length, 3); assert.equal(limited.recording.reason, "event_limit");
	store.start({}); const failedId = store.snapshot().activeId; store.db.exec("PRAGMA query_only=ON"); store.capture({ type: "runtime-stopped" });
	assert.equal(store.snapshot().available, false); assert.equal(store.read(failedId).recording.reason, "storage_unconfirmed");
	store.db.exec("PRAGMA query_only=OFF"); assert.throws(() => store.start({}), /JOURNAL_STORAGE_UNAVAILABLE/);
	assert.equal(store.read(failedId).events.length, 1); store.close(); const reopened = f.open(); assert.equal(reopened.read(failedId).recording.reason, "application_interrupted");
});
test("future and foreign schemas preserve original bytes; a hard-linked store is never opened", async t => {
	const f = await fixture(t), file = join(f.directory, "events.sqlite"), db = new DatabaseSync(file); db.exec("PRAGMA user_version=99"); db.close();
	const before = await readFile(file); assert.throws(() => f.open(), /JOURNAL_SCHEMA_TOO_NEW/); assert.deepEqual(await readFile(file), before);
	const second = join(f.directory, "other"); await mkdir(second); await link(file, join(second, "events.sqlite"));
	assert.throws(() => new EventJournal(second), /JOURNAL_PATH_UNSAFE/); assert.deepEqual(await readFile(file), before);
	const foreign = join(f.directory, "foreign"); await mkdir(foreign); const foreignFile = join(foreign, "events.sqlite"), other = new DatabaseSync(foreignFile);
	other.exec("CREATE TABLE game_tasks(id TEXT); PRAGMA user_version=1"); other.close(); const foreignBytes = await readFile(foreignFile);
	assert.throws(() => new EventJournal(foreign), /JOURNAL_SCHEMA_UNKNOWN/); assert.deepEqual(await readFile(foreignFile), foreignBytes);
});
test("tampered playback records are rejected and cannot become a command or approval", async t => {
	const f = await fixture(t), store = f.open(); store.start({}); const id = store.snapshot().activeId; store.stop();
	store.db.prepare("UPDATE recorded_events SET value=? WHERE recording_id=? AND sequence=1").run(JSON.stringify({ domain: "system", kind: "power", task: null, facts: {}, instructions: "PRIVATE_COMMAND" }), id);
	assert.throws(() => store.read(id), /JOURNAL_RECORD_INVALID/);
});

test("a registered missing journal is refused without creating an empty replacement", async t => {
	const f = await fixture(t), store = f.open(); store.start({}); store.stop(); store.close();
	const file = join(f.directory, "events.sqlite"), retained = join(f.directory, "retained.sqlite"); await rename(file, retained);
	const before = await readFile(retained); assert.throws(() => f.open(), /JOURNAL_EVIDENCE_MISSING/);
	await assert.rejects(readFile(file), { code: "ENOENT" }); assert.deepEqual(await readFile(retained), before);
});
