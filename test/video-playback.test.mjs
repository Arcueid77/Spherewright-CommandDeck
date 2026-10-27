import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { VideoPlaybackSessions, videoByteRange } from "../apps/desktop/video-playback.mjs";
import { createVideoProtocol, videoPlaybackUrl } from "../apps/desktop/video-protocol.mjs";
const deferred = () => { let resolve; return { promise: new Promise(value => { resolve = value; }), resolve: value => resolve(value) }; };
function fixture(t, { open, read, ttlMs = 100 } = {}) {
	const owner = {}, other = {}, id = randomUUID(), bytes = Buffer.from("owned encoded media"), calls = []; let generation = 1, now = 0;
	const reader = () => ({ recording: { id, bytes: bytes.length }, complete: true, readOnly: true, executionAuthority: false, read: async (offset, size) => read ? read(offset, size) : bytes.subarray(offset, offset + size), close: async () => { calls.push("close"); } });
	const broker = new VideoPlaybackSessions({ getArchive: () => ({ openReader: async () => open ? open(reader) : reader() }), isCurrent: (candidate, value) => candidate === owner && value === generation, now: () => now, ttlMs });
	t.after(() => broker.drain()); return { broker, owner, other, id, bytes, calls, reader, generation: value => { generation = value; }, time: value => { now = value; } };
}
test("playback binds owner/document, expires, and exposes only bounded reads", async t => {
	const f = fixture(t), grant = await f.broker.open(f.owner, 1, f.id);
	assert.equal(grant.executionAuthority, false); assert.deepEqual(await f.broker.read(f.owner, 1, grant.grant, 0, 5), f.bytes.subarray(0, 5));
	await assert.rejects(f.broker.read(f.other, 1, grant.grant, 0, 5), /VIDEO_UI_CHANGED/); await assert.rejects(f.broker.read(f.owner, 1, grant.grant, 0, 65537), /VIDEO_RANGE_INVALID/);
	f.time(101); await assert.rejects(f.broker.read(f.owner, 1, grant.grant, 0, 5), /VIDEO_PLAYBACK_EXPIRED/);
	await f.broker.close(f.owner, 1, grant.grant); assert.equal(f.calls.length, 1);
});
test("a newer selection and UI invalidation prevent late opened readers from escaping", async t => {
	const first = deferred(), second = deferred(), firstStarted = deferred(), secondStarted = deferred(); let count = 0;
	const f = fixture(t, { open: reader => { const initial = ++count === 1; (initial ? firstStarted : secondStarted).resolve(); return (initial ? first.promise : second.promise).then(() => reader()); } });
	const a = f.broker.open(f.owner, 1, f.id); await firstStarted.promise; const b = f.broker.open(f.owner, 1, f.id); await secondStarted.promise;
	second.resolve(); const current = await b; first.resolve(); await assert.rejects(a, /VIDEO_UI_CHANGED/); assert.equal(f.calls.length, 1);
	await f.broker.invalidate(f.owner); await assert.rejects(f.broker.read(f.owner, 1, current.grant, 0, 1), /VIDEO_PLAYBACK_CHANGED/); assert.equal(f.calls.length, 2);
});

test("a playback close cannot be performed by another document or owner", async t => {
	const f = fixture(t), opened = await f.broker.open(f.owner, 1, f.id);
	await f.broker.close(f.other, 1, opened.grant); await f.broker.close(f.owner, 2, opened.grant);
	assert.equal(f.calls.length, 0); assert.equal((await f.broker.read(f.owner, 1, opened.grant, 0, 1)).length, 1);
	await f.broker.close(f.owner, 1, opened.grant); assert.equal(f.calls.length, 1);
});

test("media streaming stays bounded and discards late bytes after document invalidation", async () => {
	const grant = randomUUID(), data = Buffer.alloc(150000, 21), entry = { generation: 1, recording: { bytes: data.length } }, entries = new Map([[grant, entry]]), lengths = []; let generation = 1;
	const handle = createVideoProtocol({ entries, generation: () => generation, read: async (_, __, offset, length) => { lengths.push(length); return { bytes: length, data: data.subarray(offset, offset + length).toString("base64") }; } });
	const head = await handle(new Request(videoPlaybackUrl(grant), { method: "HEAD" })); assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(lengths.length, 0);
	const full = await handle(new Request(videoPlaybackUrl(grant))); assert.deepEqual(Buffer.from(await full.arrayBuffer()), data); assert.equal(lengths.reduce((a, b) => a + b, 0), data.length); assert.ok(lengths.every(length => length <= 65536));
	assert.equal((await handle(new Request(videoPlaybackUrl(grant), { method: "POST" }))).status, 405);
	assert.equal((await handle(new Request(videoPlaybackUrl(grant), { headers: { range: "bytes=150000-" } }))).status, 416);
	const pending = deferred(), started = deferred(), stale = createVideoProtocol({ entries, generation: () => generation, read: () => { started.resolve(); return pending.promise; } });
	const response = await stale(new Request(videoPlaybackUrl(grant), { headers: { range: "bytes=0-4" } })), result = response.arrayBuffer(); await started.promise;
	generation++; pending.resolve({ bytes: 5, data: data.subarray(0, 5).toString("base64") }); await assert.rejects(result, /VIDEO_PLAYBACK_UNAVAILABLE/);
});
test("in-flight reads cannot deliver bytes after reload or shutdown", async t => {
	const pending = deferred(), f = fixture(t, { read: () => pending.promise }), grant = await f.broker.open(f.owner, 1, f.id);
	const result = f.broker.read(f.owner, 1, grant.grant, 0, 5); f.generation(2); await f.broker.invalidate(f.owner); pending.resolve(f.bytes.subarray(0, 5));
	await assert.rejects(result, /VIDEO_UI_CHANGED/); await f.broker.drain(); assert.throws(() => f.broker.open(f.owner, 2, f.id), /VIDEO_UI_CHANGED/);
});
test("range parsing and protocol streaming reject arbitrary URLs and stale document grants", async () => {
	assert.deepEqual(videoByteRange("bytes=2-5", 10), { start: 2, end: 5, length: 4, status: 206 }); assert.equal(videoByteRange("bytes=-3", 10).start, 7); assert.equal(videoByteRange("bytes=0-100", 10).end, 9);
	for (const header of ["bytes=10-", "bytes=5-2", "bytes=0-1,4-5", "bytes=-0", "file:///private"]) assert.throws(() => videoByteRange(header, 10), /VIDEO_RANGE_INVALID/);
	const grant = randomUUID(), data = Buffer.from("owned media data"), entries = new Map([[grant, { generation: 1, recording: { bytes: data.length } }]]); let generation = 1, reads = 0;
	const handle = createVideoProtocol({ entries, generation: () => generation, read: async (_, __, offset, length) => { reads++; const bytes = data.subarray(offset, offset + length); return { bytes: bytes.length, data: bytes.toString("base64") }; } });
	const response = await handle(new Request(videoPlaybackUrl(grant), { headers: { range: "bytes=2-5" } })); assert.equal(response.status, 206); assert.equal(await response.text(), data.subarray(2, 6).toString()); assert.equal(reads, 1);
	assert.equal((await handle(new Request("deck-video://stream/../../private"))).status, 410); generation++;
	assert.equal((await handle(new Request(videoPlaybackUrl(grant)))).status, 410); assert.equal(reads, 1);
});
