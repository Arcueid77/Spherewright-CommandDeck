import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, readFile, writeFile, rename, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { VideoArchive, videoArchiveLimits } from "../apps/desktop/video-archive.mjs";

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
