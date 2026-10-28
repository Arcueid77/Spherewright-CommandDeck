import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { VideoTimeline } from "../apps/desktop/video-timeline.mjs";
import { journalPrefixHash } from "../apps/desktop/journal-evidence.mjs";
import { journalFacts } from "../apps/desktop/journal-format.mjs";
import { videoContext } from "../apps/desktop/video-context.mjs";
import { block, cluster, movie, hex } from "./fixtures/webm.mjs";
const event = (sequence, elapsedMs) => ({ sequence, elapsedMs, domain: "probe", kind: "state", task: null, facts: journalFacts({ busy: true }) });
const sample = (journalId, events, elapsedMs, priorCount) => ({ journalId, elapsedMs, eventCount: events.length, prefixSha256: journalPrefixHash(journalId, events), priorCount, priorSha256: journalPrefixHash(journalId, events, priorCount) });
const bytes = () => movie([cluster(0, [block(0), block(500), block(1500)])]);
function fixture() { const id = randomUUID(), events = [event(1, 100), event(2, 900), event(3, 2000)], timeline = new VideoTimeline(sample(id, events.slice(0, 1), 100, 0)); return { id, events, timeline, sample: (time = 1800, count = 2, prior = 1) => sample(id, events.slice(0, count), time, prior) }; }
test("causal begin/receipt bounds use encoded frame time, preserve hash prefixes, and never extrapolate", () => {
	const f = fixture(), value = f.timeline.append(bytes(), f.sample()); assert.equal(value.originLowerMs, 100); assert.equal(value.originUpperMs, 302); assert.equal(value.mediaThroughMs, 1500); assert.equal(value.eventCount, 2);
	const recording = { id: randomUUID(), journalId: f.id }, annotations = { recording, bookmarks: [], timing: { ...value, mediaSha256: "a".repeat(64) }, executionAuthority: false };
	const context = videoContext({ annotations: () => annotations }, recording.id, () => ({ recording: { id: f.id }, events: f.events, executionAuthority: false }));
	assert.equal(context.timeline.status, "bounded"); assert.equal(context.timeline.uncertaintyMs, 205); assert.deepEqual(context.timeline.events.map(row => row.event.sequence), [2]); assert.equal(context.timeline.events[0].fromMs, 597); assert.equal(context.timeline.events[0].toMs, 802);
	f.events[0].facts = journalFacts({ busy: false }); assert.equal(videoContext({ annotations: () => annotations }, recording.id, () => ({ recording: { id: f.id }, events: f.events, executionAuthority: false })).timeline.status, "changed");
});
test("coarse clocks and unavailable samples do not become precise automatic event links", () => {
	const f = fixture(); f.timeline.append(bytes(), f.sample(4000));
	const recording = { id: randomUUID(), journalId: f.id }, archive = { annotations: () => ({ recording, bookmarks: [], timing: f.timeline.snapshot(), executionAuthority: false }) };
	assert.equal(videoContext(archive, recording.id, () => ({ recording: { id: f.id }, events: f.events, executionAuthority: false })).timeline.status, "coarse");
	const pending = fixture(); assert.equal(pending.timeline.append(bytes(), null).status, "pending");
});
test("journal replacement, prefix edits and backwards clocks invalidate synchronization without changing the source", () => {
	for (const change of [clock => ({ ...clock, journalId: randomUUID() }), clock => ({ ...clock, priorSha256: "a".repeat(64) }), clock => ({ ...clock, elapsedMs: 99 })]) { const f = fixture(), original = bytes(); assert.equal(f.timeline.append(original, change(f.sample())).status, "unsupported"); assert.deepEqual(original, bytes()); }
	const f = fixture(); f.timeline.append(bytes(), f.sample()); assert.equal(f.timeline.append(hex("ec80"), f.sample(1801, 2, 2)).status, "bounded");
});
test("nonzero media origins, invalid formats and incomplete complete-recordings stay explicitly unsupported", () => {
	const f = fixture(); assert.equal(f.timeline.append(movie([cluster(100, [block(0)])]), f.sample()).reason, "media_origin_unconfirmed");
	const invalid = fixture(); assert.equal(invalid.timeline.append(hex("1a45dfa380"), invalid.sample()).reason, "media_format_unsupported");
	const partial = fixture(), data = bytes(); partial.timeline.append(data.subarray(0, data.length - 1), partial.sample()); assert.equal(partial.timeline.finish(false).status, "bounded"); assert.equal(partial.timeline.finish(true).status, "unsupported");
});
