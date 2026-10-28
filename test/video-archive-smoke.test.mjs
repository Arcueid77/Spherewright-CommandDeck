import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVideoArchiveCase, videoArchiveCaseFile, videoTimelineFixtureEvidence } from "../apps/desktop/video-archive-smoke.mjs";

const timing = upper => ({ status: "bounded", originLowerMs: 100, originUpperMs: upper, mediaThroughMs: 1800 });
const marker = { event: { sequence: 2, domain: "probe" }, fromMs: 597, toMs: 802, timeMs: 700 };
const timeline = upper => ({ status: upper - 100 + 3 > 1000 ? "coarse" : "bounded", uncertaintyMs: upper - 100 + 3, mediaThroughMs: 1800, events: upper - 100 + 3 > 1000 ? [] : [marker] });

test("video UI fixture distinguishes a precise seek, a coarse clock and an uncovered event window", () => {
	assert.deepEqual(videoTimelineFixtureEvidence(timeline(302), timing(302), 2), { status: "bounded", uncertaintyMs: 205, marker });
	assert.deepEqual(videoTimelineFixtureEvidence(timeline(1500), timing(1500), 2), { status: "coarse", uncertaintyMs: 1403, marker: null });
	assert.deepEqual(videoTimelineFixtureEvidence({ ...timeline(302), events: [] }, timing(302), 2), { status: "bounded", uncertaintyMs: 205, marker: null });
	assert.equal(videoTimelineFixtureEvidence(timeline(1097), timing(1097), 2).status, "bounded");
	assert.equal(videoTimelineFixtureEvidence(timeline(1098), timing(1098), 2).status, "coarse");
});

test("video fixture rejects changed precision labels, fabricated automatic links and out-of-media ranges", () => {
	for (const value of [
		{ ...timeline(1500), status: "bounded" }, { ...timeline(1500), uncertaintyMs: 999 }, { ...timeline(1500), events: [marker] },
		{ ...timeline(302), status: "coarse" }, { ...timeline(302), mediaThroughMs: 2000 },
		{ ...timeline(302), events: [{ ...marker, fromMs: -1 }] }, { ...timeline(302), events: [{ ...marker, toMs: 1900 }] },
	]) assert.throws(() => videoTimelineFixtureEvidence(value, timing(value.uncertaintyMs > 1000 ? 1500 : 302), 2));
});

test("video fixture binds its explicit clock case to the current run without expanding capture authority", async t => {
	const root = await mkdtemp(join(tmpdir(), "deck-video-case-")), runId = randomUUID(), file = join(root, videoArchiveCaseFile);
	t.after(() => rm(root, { recursive: true, force: true }));
	assert.equal(await readVideoArchiveCase({ root, runId }), null);
	for (const clockCase of ["normal", "delayed"]) {
		const value = { version: 2, runId, phase: "record", clockCase }; await writeFile(file, JSON.stringify(value));
		assert.deepEqual(await readVideoArchiveCase({ root, runId }), value);
		await assert.rejects(readVideoArchiveCase({ root, runId: randomUUID() }));
	}
	for (const extra of [{ clockCase: "native" }, { delayMs: 1300 }, { sourceId: "desktop:0:0" }, { version: 1 }]) {
		await writeFile(file, JSON.stringify({ version: 2, runId, phase: "record", clockCase: "normal", ...extra }));
		await assert.rejects(readVideoArchiveCase({ root, runId }));
	}
});
