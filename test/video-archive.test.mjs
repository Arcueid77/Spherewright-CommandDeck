import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile, rename, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { VideoArchive, videoArchiveLimits } from "../apps/desktop/video-archive.mjs";
import { journalPrefixHash } from "../apps/desktop/journal-evidence.mjs";
import { journalFacts } from "../apps/desktop/journal-format.mjs";
import { block, cluster, movie } from "./fixtures/webm.mjs";

const metadata = { width: 1280, height: 720, frameRate: 30, sourceRevision: "a".repeat(40), piCommit: "b".repeat(40) };
// Binary storage fixture, not evidence of a decoded video or a captured window.
const first = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), second = Buffer.from([5, 6, 7, 8]);
async function fixture(t, options) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-video-archive-"))), stores = [];
	t.after(async () => { for (const store of stores) if (!store.closed) await store.close(); const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-video-archive-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { directory, open: () => { const store = new VideoArchive(directory, options); stores.push(store); return store; } };
}
test("encoded clip chunks are ordered, duplicate acknowledgements do not append, and complete history reopens read-only", async t => {
	const f = await fixture(t), archive = f.open(); await assert.rejects(archive.start({ ...metadata, privatePath: "PRIVATE" }), /VIDEO_METADATA_INVALID/);
	const id = (await archive.start(metadata)).activeId;
	const receipt = await archive.append(id, 1, first); assert.deepEqual(await archive.append(id, 1, first), receipt);
	await assert.rejects(archive.append(id, 1, second), /VIDEO_CHUNK_SEQUENCE_CHANGED/); await assert.rejects(archive.append(id, 3, second), /VIDEO_CHUNK_SEQUENCE_CHANGED/);
	await archive.append(id, 2, second); await archive.finish(id); const original = archive.snapshot().recordings[0], bytes = Buffer.concat([first, second]);
	assert.equal(original.bytes, bytes.length); assert.equal(original.chunks, 2); assert.equal(original.state, "complete"); assert.equal(original.sha256, createHash("sha256").update(bytes).digest("hex"));
	const reader = await archive.openReader(id); assert.equal(reader.readOnly, true); assert.equal(reader.executionAuthority, false); assert.deepEqual(await reader.read(0, bytes.length), bytes);
	await assert.rejects(reader.read(0, videoArchiveLimits.readBytes + 1), /VIDEO_RANGE_INVALID/); await archive.close(); await assert.rejects(reader.read(0, 1), /VIDEO_RANGE_INVALID/);
	const reopened = f.open(); assert.equal(reopened.snapshot().activeId, null); assert.deepEqual(reopened.snapshot().recordings[0], original); assert.ok(!JSON.stringify(reopened.snapshot()).includes("PRIVATE"));
});
test("close drains already accepted chunks, while an unclosed store is marked interrupted without inventing a stop time", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId;
	const one = archive.append(id, 1, first), two = archive.append(id, 2, second); const close = archive.close(); await Promise.all([one, two, close]);
	await assert.rejects(archive.append(id, 3, second), /VIDEO_ARCHIVE_UNAVAILABLE/);
	const reopened = f.open(); assert.equal(reopened.snapshot().recordings[0].reason, "application_exit"); assert.equal(reopened.snapshot().recordings[0].bytes, first.length + second.length);
	const active = (await reopened.start(metadata)).activeId; await reopened.append(active, 1, first);
	// Object-disposal crash simulation only. Whole-app capture/recovery remains a separate gate.
	await reopened.active.file.close(); reopened.db.close(); reopened.closed = true;
	const next = f.open(), row = next.snapshot().recordings.find(row => row.id === active);
	assert.equal(row.state, "interrupted"); assert.equal(row.reason, "application_interrupted"); assert.equal(row.stoppedAt, null); assert.equal(row.bytes, first.length);
	const reader = await next.openReader(active); assert.equal(reader.complete, false); assert.deepEqual(await reader.read(0, first.length), first); await reader.close();
});
test("byte limits preserve the accepted prefix and SQLite refusal latches before binary append", async t => {
	const f = await fixture(t, { limits: { ...videoArchiveLimits, recordingBytes: first.length } }), archive = f.open(), id = (await archive.start(metadata)).activeId;
	await archive.append(id, 1, first); await assert.rejects(archive.append(id, 2, second), /VIDEO_RECORDING_BYTE_LIMIT/);
	assert.equal(archive.snapshot().recordings[0].reason, "byte_limit"); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), first);
	const secondId = (await archive.start(metadata)).activeId; archive.db.exec("PRAGMA query_only=ON");
	await assert.rejects(archive.append(secondId, 1, first), /VIDEO_ARCHIVE_UNAVAILABLE/); assert.equal(archive.snapshot().available, false);
	assert.equal((await readFile(join(f.directory, secondId + ".webm"))).length, 0); archive.db.exec("PRAGMA query_only=OFF"); await assert.rejects(archive.start(metadata), /VIDEO_ARCHIVE_UNAVAILABLE/);
});
test("completed media digest detects mutation and a missing registered catalog is never replaced", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId; await archive.append(id, 1, first); await archive.finish(id);
	const changed = Buffer.from(first); changed[changed.length - 1] ^= 0xff; await writeFile(join(f.directory, id + ".webm"), changed);
	await assert.rejects(archive.openReader(id), /VIDEO_ARCHIVE_MEDIA_UNCONFIRMED/); await archive.close();
	const catalog = join(f.directory, "videos.sqlite"), retained = join(f.directory, "retained.sqlite"); await rename(catalog, retained); const before = await readFile(retained);
	assert.throws(() => f.open(), /VIDEO_ARCHIVE_EVIDENCE_MISSING/); await assert.rejects(readFile(catalog), { code: "ENOENT" }); assert.deepEqual(await readFile(retained), before);
});
test("foreign/future catalogs and hard-linked media remain untouched and unavailable", async t => {
	const f = await fixture(t), catalog = join(f.directory, "videos.sqlite"), db = new DatabaseSync(catalog); db.exec("PRAGMA user_version=99"); db.close();
	const before = await readFile(catalog); assert.throws(() => f.open(), /VIDEO_ARCHIVE_SCHEMA_TOO_NEW/); assert.deepEqual(await readFile(catalog), before);
	const foreign = await fixture(t), foreignFile = join(foreign.directory, "videos.sqlite"), foreignDb = new DatabaseSync(foreignFile); foreignDb.exec("CREATE TABLE recordings(id TEXT); PRAGMA user_version=1"); foreignDb.close();
	const foreignBytes = await readFile(foreignFile); assert.throws(() => foreign.open(), /VIDEO_ARCHIVE_SCHEMA_UNKNOWN/); assert.deepEqual(await readFile(foreignFile), foreignBytes);
	const g = await fixture(t), archive = g.open(), id = (await archive.start(metadata)).activeId; await archive.append(id, 1, first); await archive.finish(id); await archive.close();
	const media = join(g.directory, id + ".webm"); await link(media, join(g.directory, "duplicate.webm")); assert.throws(() => g.open(), /VIDEO_ARCHIVE_EVIDENCE_INVALID/); assert.deepEqual(await readFile(media), first);
});
test("runtime catalog corruption latches without rewriting the original row during close", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId;
	archive.db.prepare("UPDATE recordings SET mime='invalid-private-data' WHERE id=?").run(id);
	await assert.rejects(archive.append(id, 1, first), /VIDEO_ARCHIVE_UNAVAILABLE/); await archive.close();
	const db = new DatabaseSync(join(f.directory, "videos.sqlite"), { readOnly: true });
	try { const row = db.prepare("SELECT state,mime,bytes FROM recordings WHERE id=?").get(id); assert.equal(row.state, "recording"); assert.equal(row.mime, "invalid-private-data"); assert.equal(row.bytes, 0); } finally { db.close(); }
	assert.equal((await readFile(join(f.directory, id + ".webm"))).length, 0);
});
test("WebM initialization may span fragments while invalid continuations and incomplete completion remain refused", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId;
	await archive.append(id, 1, first.subarray(0, 1)); await archive.append(id, 1, first.subarray(0, 1));
	await assert.rejects(archive.append(id, 2, Buffer.from([0xff])), /VIDEO_WEBM_HEADER_REQUIRED/);
	await archive.append(id, 2, first.subarray(1, 2)); await archive.append(id, 3, first.subarray(2)); await archive.finish(id);
	const reader = await archive.openReader(id); assert.deepEqual(await reader.read(0, first.length), first); await reader.close();
	const incomplete = (await archive.start(metadata)).activeId; await archive.append(incomplete, 1, first.subarray(0, 1)); await archive.finish(incomplete);
	const row = archive.snapshot().recordings.find(row => row.id === incomplete); assert.equal(row.state, "interrupted"); assert.equal(row.reason, "no_data"); assert.equal(row.bytes, 1); assert.equal(row.sha256, null);
	await assert.rejects(archive.openReader(incomplete), /VIDEO_PLAYBACK_UNAVAILABLE/);
});

function legacyCatalog(directory, { mediaBytes = first.length } = {}) {
	const id = randomUUID(), hash = createHash("sha256").update(first).digest("hex"), db = new DatabaseSync(join(directory, "videos.sqlite"));
	try {
		db.exec("CREATE TABLE recordings(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at TEXT NOT NULL,stopped_at TEXT,bytes INTEGER NOT NULL,chunks INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,frame_rate INTEGER NOT NULL,source_revision TEXT,pi_commit TEXT,journal_id TEXT,reason TEXT,sha256 TEXT); CREATE UNIQUE INDEX one_recording ON recordings((1)) WHERE state='recording'; PRAGMA user_version=1;");
		db.prepare("INSERT INTO recordings VALUES(?,'complete',?,?,?,?,?,'video/webm;codecs=vp8',1280,720,30,?,?,NULL,'user_stopped',?)").run(id, "2026-10-28T00:00:00.000Z", "2026-10-28T00:00:01.000Z", mediaBytes, 1, 1000, metadata.sourceRevision, metadata.piCommit, hash);
	} finally { db.close(); }
	return { id, hash };
}
test("v1 catalog migration preserves every media/recording field and bookmarks survive reopen", async t => {
	const f = await fixture(t), old = legacyCatalog(f.directory), catalog = join(f.directory, "videos.sqlite"), marker = join(f.directory, "videos.sqlite.presence");
	await writeFile(join(f.directory, old.id + ".webm"), first); await writeFile(marker, "commanddeck-video-archive-v1\n");
	const before = new DatabaseSync(catalog, { readOnly: true }); let original; try { original = before.prepare("SELECT * FROM recordings").all(); } finally { before.close(); }
	const archive = f.open(); assert.equal(archive.db.prepare("PRAGMA user_version").get().user_version, 3); assert.deepEqual(archive.db.prepare("SELECT * FROM recordings").all(), original);
	assert.deepEqual(archive.annotations(old.id).bookmarks, []); assert.deepEqual(await readFile(join(f.directory, old.id + ".webm")), first); assert.equal(await readFile(marker, "utf8"), "commanddeck-video-archive-v1\n");
	const saved = await archive.addBookmark(old.id, old.hash, 400, "checkpoint", null, () => true); assert.equal(saved.bookmarks.length, 1); assert.equal(saved.executionAuthority, false);
	await archive.close(); const reopened = f.open(); assert.deepEqual(reopened.annotations(old.id), saved); assert.deepEqual(reopened.db.prepare("SELECT * FROM recordings").all(), original);
});
test("inconsistent legacy media is rejected before schema migration without changing the catalog", async t => {
	const f = await fixture(t), old = legacyCatalog(f.directory, { mediaBytes: first.length + 1 }), catalog = join(f.directory, "videos.sqlite"); await writeFile(join(f.directory, old.id + ".webm"), first);
	const original = await readFile(catalog); assert.throws(() => f.open(), /VIDEO_ARCHIVE_MEDIA_UNCONFIRMED/); assert.deepEqual(await readFile(catalog), original);
	const db = new DatabaseSync(catalog, { readOnly: true }); try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1); assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='video_bookmarks'").get().n, 0); } finally { db.close(); }
});
test("bookmarks bind the media/journal, deduplicate acknowledgements, and enforce the exact per-clip bound", async t => {
	const f = await fixture(t), archive = f.open(), journalId = randomUUID(), id = (await archive.start({ ...metadata, journalId })).activeId; await archive.append(id, 1, first); await archive.finish(id);
	const hash = archive.snapshot().recordings[0].sha256, relation = { journalId, sequence: 1, pointSha256: "d".repeat(64) };
	const saved = await archive.addBookmark(id, hash, 123, "verified", relation, () => true); assert.deepEqual(await archive.addBookmark(id, hash, 123, "verified", relation, () => true), saved);
	for (const [digest, time, tag, link] of [["f".repeat(64), 0, "issue", null], [hash, -1, "issue", null], [hash, 0, "PRIVATE", null], [hash, 0, "issue", { ...relation, journalId: randomUUID() }], [hash, 0, "issue", { ...relation, path: "PRIVATE" }]]) await assert.rejects(archive.addBookmark(id, digest, time, tag, link, () => true), /VIDEO_BOOKMARK_INVALID/);
	archive.db.exec("BEGIN IMMEDIATE"); try { for (let index = 1; index < 128; index++) archive.db.prepare("INSERT INTO video_bookmarks VALUES(?,?,?,?,?,?,NULL,NULL,NULL)").run(randomUUID(), id, hash, index + 1000, "issue", "2026-10-28T00:00:00.000Z"); archive.db.exec("COMMIT"); } catch (error) { archive.db.exec("ROLLBACK"); throw error; }
	await assert.rejects(archive.addBookmark(id, hash, 3000, "issue", null, () => true), /VIDEO_BOOKMARK_LIMIT/); assert.equal((await archive.addBookmark(id, hash, 123, "verified", relation, () => true)).bookmarks.length, 128);
	assert.equal(archive.snapshot().available, true); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), first);
});
test("late UI invalidation and SQLite denial cannot create a bookmark or change media", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId; await archive.append(id, 1, first); await archive.finish(id); const hash = archive.snapshot().recordings[0].sha256;
	let release, current = true; const hold = archive.queue(() => new Promise(done => { release = done; })); await new Promise(resolve => setImmediate(resolve));
	const pending = archive.addBookmark(id, hash, 0, "checkpoint", null, () => current); current = false; release(); await hold; await assert.rejects(pending, /VIDEO_UI_CHANGED/); assert.deepEqual(archive.annotations(id).bookmarks, []);
	archive.db.exec("PRAGMA query_only=ON"); await assert.rejects(archive.addBookmark(id, hash, 0, "checkpoint", null, () => true), /VIDEO_ARCHIVE_UNAVAILABLE/); archive.db.exec("PRAGMA query_only=OFF");
	assert.equal(archive.snapshot().available, false); assert.equal(archive.db.prepare("SELECT count(*) AS n FROM video_bookmarks").get().n, 0); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), first);
});
test("corrupt bookmark evidence is refused before startup writes and remains intact", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId; await archive.append(id, 1, first); await archive.finish(id); const hash = archive.snapshot().recordings[0].sha256;
	await archive.addBookmark(id, hash, 500, "checkpoint", null, () => true); archive.db.prepare("UPDATE video_bookmarks SET media_sha256=?").run("f".repeat(64)); await archive.close();
	const catalog = join(f.directory, "videos.sqlite"), original = await readFile(catalog); assert.throws(() => f.open(), /VIDEO_BOOKMARK_EVIDENCE_INVALID/); assert.deepEqual(await readFile(catalog), original); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), first);
});
test("timing evidence commits with the same encoded prefix and survives a normal reopen", async t => {
	const f = await fixture(t), archive = f.open(), journalId = randomUUID(), events = [{ sequence: 1, elapsedMs: 0, domain: "recording", kind: "start", task: null, facts: journalFacts({}) }];
	const clock = (elapsedMs, priorCount) => ({ journalId, elapsedMs, eventCount: 1, prefixSha256: journalPrefixHash(journalId, events), priorCount, priorSha256: journalPrefixHash(journalId, events, priorCount) });
	const id = (await archive.start({ ...metadata, journalId, clock: clock(100, 0) })).activeId, bytes = movie([cluster(0, [block(0), block(1000)])]);
	await archive.append(id, 1, bytes.subarray(0, 1), clock(200, 1)); assert.equal(archive.annotations(id).timing.status, "pending");
	await archive.append(id, 2, bytes.subarray(1), clock(1200, 1)); await archive.finish(id); const original = archive.annotations(id);
	assert.equal(original.timing.status, "bounded"); assert.equal(original.timing.originLowerMs, 100); assert.equal(original.timing.originUpperMs, 202); assert.equal(original.timing.mediaSha256, original.recording.sha256);
	const reader = await archive.openReader(id); assert.equal(reader.timing.lastMs, 1000); await reader.close(); await archive.close(); assert.deepEqual(f.open().annotations(id), original);
});
test("v2-format migration preserves bookmarks/media and creates no invented clock history", async t => {
	const f = await fixture(t), archive = f.open(), id = (await archive.start(metadata)).activeId; await archive.append(id, 1, first); await archive.finish(id); const hash = archive.snapshot().recordings[0].sha256;
	const annotations = await archive.addBookmark(id, hash, 400, "checkpoint", null, () => true); await archive.close();
	const old = new DatabaseSync(join(f.directory, "videos.sqlite")); try { old.exec("DROP TABLE video_timing; PRAGMA user_version=2"); } finally { old.close(); }
	const reopened = f.open(); assert.equal(reopened.db.prepare("PRAGMA user_version").get().user_version, 3); assert.deepEqual(reopened.annotations(id), annotations); assert.equal(reopened.annotations(id).timing, null); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), first);
});
test("duplicate chunk acknowledgements retain the original clock prefix and SQLite denial keeps both ledgers at the accepted prefix", async t => {
	const f = await fixture(t), archive = f.open(), journalId = randomUUID(), events = [{ sequence: 1, elapsedMs: 0, domain: "recording", kind: "start", task: null, facts: journalFacts({}) }];
	const clock = (elapsedMs, priorCount) => ({ journalId, elapsedMs, eventCount: events.length, prefixSha256: journalPrefixHash(journalId, events), priorCount, priorSha256: journalPrefixHash(journalId, events, priorCount) });
	const id = (await archive.start({ ...metadata, journalId, clock: clock(100, 0) })).activeId, bytes = movie([cluster(0, [block(0), block(1000)])]);
	const receipt = await archive.append(id, 1, bytes.subarray(0, 1), clock(200, 1)); events.push({ sequence: 2, elapsedMs: 300, domain: "probe", kind: "state", task: null, facts: journalFacts({ busy: true }) });
	assert.deepEqual(await archive.append(id, 1, bytes.subarray(0, 1), clock(400, 1)), receipt); assert.equal(receipt.clockCount, 1); assert.equal(archive.annotations(id).timing.eventCount, 1);
	archive.db.exec("PRAGMA query_only=ON"); await assert.rejects(archive.append(id, 2, bytes.subarray(1), clock(1300, 1)), /VIDEO_ARCHIVE_UNAVAILABLE/); archive.db.exec("PRAGMA query_only=OFF");
	assert.equal(archive.db.prepare("SELECT bytes FROM recordings WHERE id=?").get(id).bytes, 1); assert.equal(archive.db.prepare("SELECT bytes,event_count FROM video_timing WHERE recording_id=?").get(id).event_count, 1); assert.deepEqual(await readFile(join(f.directory, id + ".webm")), bytes.subarray(0, 1));
});
