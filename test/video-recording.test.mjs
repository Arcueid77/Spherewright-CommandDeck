import test from "node:test";
import assert from "node:assert/strict";
import { VideoRecording } from "../apps/desktop/video-recording.mjs";
import { recordingMasks, recordingSize } from "../apps/desktop/recording-options.mjs";
import { recordingPermissionGate } from "../apps/desktop/recording-permission.mjs";
import { paintMaskedVideo } from "../apps/desktop/video-frame.mjs";
const deferred = () => { let resolve; return { promise: new Promise(done => { resolve = done; }), resolve: value => resolve(value) }; };
function fixture(t, options = {}) {
	const owner = {}, calls = []; let generation = 1, locked = false, now = 0;
	const source = { version: 1, sourceId: "window:123:0", windowBinding: "b".repeat(32), width: 160, height: 90, layoutRevision: 2, gamePid: 123, gameStartedTicks: "639000000000000000", kind: "fixture", targetId: "adapter:owned" };
	const archive = { active: null, snapshot: () => ({ available: true }), async start(metadata) { calls.push(["start", metadata]); if (options.start) await options.start; this.active = { id: "owned-clip" }; return { activeId: this.active.id }; }, async append(id, sequence, bytes) { calls.push(["append", id, sequence, bytes.length]); if (options.append) await options.append; return { id, sequence, bytes: bytes.length }; }, async finish(id) { calls.push(["finish", id]); this.active = null; }, async interrupt(reason) { calls.push(["interrupt", reason]); this.active = null; } };
	const recorder = new VideoRecording({ getArchive: () => archive, getBuild: () => ({ sourceRevision: "c".repeat(40), piCommit: "d".repeat(40) }), getSource: () => options.source ? options.source(source) : Promise.resolve({ ...source }), isCurrent: (candidate, gen) => candidate === owner && gen === generation, isLocked: () => locked, now: () => now });
	t.after(() => recorder.dispose()); return { recorder, owner, calls, archive, source, generation: value => { generation = value; }, lock: value => { locked = value; }, time: value => { now = value; } };
}
const track = { audioTracks: 0, videoTracks: 1, displaySurface: "window", frameRate: 15, width: 160, height: 90 };
async function preview(f) { const prepared = await f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] }); assert.equal((await f.recorder.authorize(f.owner, 1, prepared.permit)).id, f.source.sourceId); await f.recorder.ready(f.owner, 1, prepared.permit, track); return prepared.permit; }
test("capture needs the current unlocked UI, fixed options and an expiring one-use source grant", async t => {
	const f = fixture(t); f.lock(true); await assert.rejects(f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] }), /VIDEO_DESKTOP_UNAVAILABLE/); f.lock(false);
	await assert.rejects(f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [], sourceId: "screen:0:0" }), /VIDEO_CAPTURE_OPTIONS_INVALID/);
	const prepared = await f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] }); f.time(15001); await assert.rejects(f.recorder.authorize(f.owner, 1, prepared.permit), /VIDEO_PREVIEW_EXPIRED/); assert.equal(f.recorder.snapshot().phase, "idle"); assert.equal(f.calls.length, 0);
	const permit = await preview(f); await assert.rejects(f.recorder.authorize(f.owner, 1, permit), /VIDEO_CAPTURE_CHANGED/); assert.equal(f.calls.length, 0);
});
test("recording preserves masks, serial bytes and normal stop without execution authority", async t => {
	const f = fixture(t), permit = await preview(f); f.recorder.setMasks(f.owner, 1, permit, [{ x: 0, y: 0, width: 5000, height: 5000 }]); await f.recorder.start(f.owner, 1, permit);
	assert.throws(() => f.recorder.setMasks(f.owner, 1, permit, []), /VIDEO_CAPTURE_CHANGED/);
	await f.recorder.append(f.owner, 1, permit, 1, new Uint8Array([26, 69, 223, 163])); await f.recorder.finish(f.owner, 1, permit);
	assert.equal(f.recorder.snapshot().cleanupPending, true); await assert.rejects(f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] }), /VIDEO_CAPTURE_BUSY/);
	f.recorder.closed(f.owner, 1, permit); assert.equal(f.recorder.snapshot().phase, "idle"); assert.deepEqual(f.calls.map(call => call[0]), ["start", "append", "finish"]); assert.equal(f.calls[0][1].width, 160);
});
test("window changes interrupt a retained prefix and refuse every later chunk", async t => {
	const f = fixture(t), permit = await preview(f); await f.recorder.start(f.owner, 1, permit); await f.recorder.append(f.owner, 1, permit, 1, new Uint8Array([1])); f.source.windowBinding = "e".repeat(32); await f.recorder.check();
	assert.equal(f.recorder.snapshot().phase, "stopping"); assert.throws(() => f.recorder.append(f.owner, 1, permit, 2, new Uint8Array([2])), /VIDEO_CAPTURE_CHANGED/); assert.equal(f.calls.filter(row => row[0] === "interrupt").length, 1);
	f.recorder.closed({}, 1, permit); assert.equal(f.recorder.snapshot().cleanupPending, true); f.recorder.closed(f.owner, 1, permit); assert.equal(f.recorder.snapshot().phase, "idle");
});
test("cancel during archive creation closes the late row rather than resuming or replaying", async t => {
	const waiting = deferred(), started = deferred(), f = fixture(t, { start: waiting.promise }); const originalStart = f.archive.start; f.archive.start = function(metadata) { started.resolve(); return originalStart.call(this, metadata); };
	const permit = await preview(f), start = f.recorder.start(f.owner, 1, permit); await started.promise; const stopped = f.recorder.cancel(f.owner, 1, permit); waiting.resolve(); await assert.rejects(start, /VIDEO_CAPTURE_CHANGED/); await stopped;
	assert.deepEqual(f.calls.map(row => row[0]), ["start", "interrupt"]); f.recorder.closed(f.owner, 1, permit); assert.equal(f.recorder.snapshot().phase, "idle");
});
test("UI replacement drops late preparation and cleanup does not reopen old capabilities", async t => {
	const pending = deferred(), f = fixture(t, { source: () => pending.promise }), operation = f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] });
	f.generation(2); await f.recorder.invalidate(f.owner); f.recorder.documentReady(f.owner, 2); pending.resolve(f.source); await assert.rejects(operation, /VIDEO_UI_CHANGED/); assert.equal(f.recorder.snapshot().phase, "idle"); assert.equal(f.calls.length, 0);
});
test("bounded pending chunks drain the accepted prefix before cancellation without replay", async t => {
	const waiting = deferred(), entered = deferred(), f = fixture(t, { append: waiting.promise }), original = f.archive.append;
	f.archive.append = function(...args) { entered.resolve(); return original.apply(this, args); }; const permit = await preview(f); await f.recorder.start(f.owner, 1, permit);
	const first = f.recorder.append(f.owner, 1, permit, 1, new Uint8Array([1])); await entered.promise;
	const second = f.recorder.append(f.owner, 1, permit, 2, new Uint8Array([2])), rejected = assert.rejects(second, /VIDEO_CAPTURE_CHANGED/);
	assert.throws(() => f.recorder.append(f.owner, 1, permit, 3, new Uint8Array([3])), /VIDEO_ARCHIVE_BACKPRESSURE/); const closing = f.recorder.cancel(f.owner, 1, permit); waiting.resolve(); await first; await rejected; await closing;
	assert.deepEqual(f.calls.map(row => row[0]), ["start", "append", "interrupt"]); f.recorder.closed(f.owner, 1, permit); assert.equal(f.recorder.snapshot().phase, "idle");
});
test("lock interrupts active capture and leaves cleanup unconfirmed until the original UI closes", async t => {
	const f = fixture(t), permit = await preview(f); await f.recorder.start(f.owner, 1, permit); f.lock(true); await f.recorder.check(); await f.recorder.tail;
	f.time(6000); await f.recorder.check(); assert.equal(f.recorder.snapshot().error, "VIDEO_CAPTURE_CLEANUP_UNCONFIRMED"); f.lock(false); await assert.rejects(f.recorder.prepare(f.owner, 1, { profile: "720p15", masks: [] }), /VIDEO_CAPTURE_BUSY/);
	await f.recorder.invalidate(f.owner, "ui_lost", true); assert.equal(f.recorder.snapshot().phase, "idle");
});
test("privacy rectangles and output bounds reject coercions, extra data and inherited profiles", () => {
	assert.deepEqual(recordingSize(3840, 2160, "1080p30"), { width: 1920, height: 1080, frameRate: 30 });
	assert.throws(() => recordingSize(160, 90, "toString"), /VIDEO_TRACK_INVALID/);
	for (const value of [[{ x: 0, y: 0, width: 10001, height: 1 }], [{ x: "0", y: 0, width: 1, height: 1 }], [{ x: 0, y: 0, width: 1, height: 1, text: "private" }], Array(9).fill({ x: 0, y: 0, width: 1, height: 1 })]) assert.throws(() => recordingMasks(value), /VIDEO_MASKS_INVALID/);
});
test("display permissions never allow camera/audio, another frame, missing gesture or late navigation", async () => {
	const frame = { url: "file:///owned/ui.html" }, owner = { mainFrame: frame, isDestroyed: () => false, isFocused: () => true }; let generation = 1, authorizations = 0;
	const gate = recordingPermissionGate({ owner, url: frame.url, generation: () => generation, authorize: async () => { authorizations++; return { id: "window:123:0" }; } }), permit = "a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5";
	gate.arm(permit); assert.equal(gate.permission(owner, "media"), false); assert.equal(gate.permission({}, "display-capture"), false); assert.equal(gate.permission(owner, "display-capture"), true);
	const request = { frame, videoRequested: true, audioRequested: false, userGesture: true }, outputs = [];
	for (const override of [{ audioRequested: true }, { frame: {} }, { userGesture: false }]) await gate.display({ ...request, ...override }, value => outputs.push(value)); assert.deepEqual(outputs, [null, null, null]); assert.equal(authorizations, 0);
	await gate.display(request, value => outputs.push(value)); assert.equal(outputs.at(-1).video.id, "window:123:0"); await gate.display(request, value => outputs.push(value)); assert.equal(outputs.at(-1), null); assert.equal(authorizations, 1);
	const pending = deferred(); const late = recordingPermissionGate({ owner, url: frame.url, generation: () => generation, authorize: () => pending.promise }); late.arm(permit); const result = late.display(request, value => outputs.push(value)); generation++; pending.resolve({ id: "window:123:0" }); await result; assert.equal(outputs.at(-1), null);
});
test("privacy covers fractional boundary pixels and rejects invalid masks before drawing", () => {
	const calls = [], context = { save() {}, restore() {}, resetTransform() {}, fillRect(...args) { calls.push(["fill", ...args]); }, drawImage(...args) { calls.push(["source", ...args]); } };
	paintMaskedVideo(context, "owned-source", 13, 11, [{ x: 3333, y: 3333, width: 3333, height: 3333 }]); assert.deepEqual(calls.at(-1), ["fill", 4, 3, 5, 5]);
	calls.length = 0; assert.throws(() => paintMaskedVideo(context, "owned-source", 13, 11, [{ x: 0, y: 0, width: 10001, height: 1 }]), /VIDEO_MASKS_INVALID/); assert.equal(calls.length, 0);
});
