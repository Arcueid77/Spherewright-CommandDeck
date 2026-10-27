import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { journalFacts } from "../apps/desktop/journal-format.mjs";
import { videoContext, videoRelation } from "../apps/desktop/video-context.mjs";

function fixture(count = 3) {
	const journalId = randomUUID(), recording = { id: randomUUID(), journalId }, events = Array.from({ length: count }, (_, index) => ({ sequence: index + 1, elapsedMs: 5000 + index * 50, domain: "development", kind: "task", task: "development-1", facts: journalFacts({ state: "running" }) }));
	const journal = { recording: { id: journalId }, events, executionAuthority: false }, bookmarks = [], calls = [];
	return { recording, journal, bookmarks, calls, read: id => { calls.push(id); return journal; }, archive: { annotations: id => { assert.equal(id, recording.id); return { recording, bookmarks, executionAuthority: false }; } } };
}
test("manual movie/event relations bind canonical content and keep the two clock positions independent", () => {
	const f = fixture(), relation = videoRelation(f.recording, 2, f.read); assert.equal(relation.journalId, f.recording.journalId); assert.equal(relation.sequence, 2);
	f.bookmarks.push({ id: randomUUID(), timeMs: 400, mediaSha256: "a".repeat(64), relation });
	const context = videoContext(f.archive, f.recording.id, f.read); assert.equal(context.executionAuthority, false); assert.equal(context.bookmarks[0].timeMs, 400); assert.equal(context.bookmarks[0].link.status, "matching"); assert.equal(context.bookmarks[0].link.event.elapsedMs, 5050);
	f.journal.events[1].facts = journalFacts({ state: "failed" }); const changed = videoContext(f.archive, f.recording.id, f.read); assert.equal(changed.bookmarks[0].link.status, "changed"); assert.equal(changed.bookmarks[0].link.event, null);
	assert.ok(f.calls.every(id => id === f.recording.journalId)); assert.equal(videoRelation(f.recording, null, () => { throw new Error("MUST_NOT_READ"); }), null);
});
test("journal browsing is bounded and projects only validated structured fields", () => {
	const f = fixture(260); f.journal.events[0].privatePrompt = "PRIVATE"; f.journal.sourcePath = "PRIVATE";
	const first = videoContext(f.archive, f.recording.id, f.read), second = videoContext(f.archive, f.recording.id, f.read, 128), last = videoContext(f.archive, f.recording.id, f.read, 256);
	assert.equal(first.journal.events.length, 128); assert.equal(first.journal.nextOffset, 128); assert.equal(second.journal.events[0].sequence, 129); assert.equal(last.journal.events.length, 4); assert.equal(last.journal.nextOffset, null);
	assert.ok(!JSON.stringify(first).includes("PRIVATE")); for (const offset of [-1, 1, 4096, "128"]) assert.throws(() => videoContext(f.archive, f.recording.id, f.read, offset), /VIDEO_CONTEXT_PAGE_INVALID/);
});
test("missing, foreign and invalid journals cannot acquire matching links or authorize a relation", () => {
	const f = fixture(), relation = videoRelation(f.recording, 1, f.read); f.bookmarks.push({ timeMs: 0, relation });
	const missing = () => { throw new Error("JOURNAL_RECORDING_NOT_FOUND"); }; assert.equal(videoContext(f.archive, f.recording.id, missing).bookmarks[0].link.status, "missing"); assert.throws(() => videoRelation(f.recording, 1, missing), /VIDEO_JOURNAL_EVENT_UNAVAILABLE/);
	f.journal.recording.id = randomUUID(); assert.equal(videoContext(f.archive, f.recording.id, f.read).journal.status, "unavailable");
	f.journal.recording.id = f.recording.journalId; f.journal.events[0].facts.private = "PRIVATE"; assert.equal(videoContext(f.archive, f.recording.id, f.read).bookmarks[0].link.status, "unavailable");
	for (const sequence of [0, 4097, "1", undefined]) assert.throws(() => videoRelation(f.recording, sequence, f.read), /VIDEO_JOURNAL_EVENT_INVALID/);
	f.recording.journalId = null; assert.equal(videoContext(f.archive, f.recording.id, f.read).journal.status, "none");
});
