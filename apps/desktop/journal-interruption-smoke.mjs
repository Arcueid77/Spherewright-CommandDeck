import assert from "node:assert/strict";
import { readFile, writeFile, lstat, realpath, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { beginJournalSmoke, finishJournalSmoke } from "./journal-smoke.mjs";

export const journalInterruptionCaseFile = "journal-interruption-case.private.json";
export const journalInterruptionStartedFile = "journal-interruption-started.private.json";
export const journalInterruptionFrozenFile = "journal-interruption-frozen.private.json";

async function readFixture(context, name, optional = false) {
	assert.match(context.runId, /^[a-f0-9-]{36}$/);
	assert.equal((await realpath(context.root)).toLowerCase(), context.root.toLowerCase());
	assert.equal(dirname(context.root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
	assert.ok(basename(context.root).startsWith("commanddeck-desktop-smoke-"));
	const file = join(context.root, name); let info;
	try { info = await lstat(file); } catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 1048576, "JOURNAL_INTERRUPTION_FIXTURE_INVALID");
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8")); assert.equal(value.runId, context.runId); return value;
}

export async function readJournalInterruptionCase(context) {
	const value = await readFixture(context, journalInterruptionCaseFile, true); if (!value) return null;
	assert.deepEqual(Object.keys(value).sort(), ["phase", "runId", "version"]);
	assert.equal(value.version, 1); assert.ok(["record", "resume", "reopen"].includes(value.phase)); return value;
}

export async function runJournalInterruptionSmoke(driver, fixture, manifest) {
	const request = (action, args = {}) => driver.api("journal", { action, args });
	const work = await driver.api("workbench", { action: "state" }), game = await driver.api("game", { action: "snapshot" }), bridge = await driver.api("bridge", { action: "snapshot" });
	assert.deepEqual(work.tasks, []); assert.deepEqual(work.roots, []); assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(bridge.selected, null);
	if (fixture.phase === "record") {
		assert.equal((await request("snapshot")).recordings.length, 0);
		const recording = await beginJournalSmoke(driver, false), result = await driver.api("probe", { mode: "offline" });
		assert.equal(result.requestCount, 2); assert.equal(driver.getProbeSequence(), 1);
		await request("bookmark", { id: recording.id, sequence: 2, tag: "checkpoint" });
		const archive = await request("read", { id: recording.id }); assert.equal(archive.recording.state, "recording"); assert.equal(archive.readOnly, false); assert.equal(archive.executionAuthority, false);
		assert.equal(archive.bookmarks.length, 1); assert.ok(archive.events.length >= 3);
		const ready = join(driver.context.root, journalInterruptionStartedFile), staging = ready + ".pending";
		await assert.rejects(lstat(ready), { code: "ENOENT" });
		await writeFile(staging, JSON.stringify({ runId: driver.context.runId, sourceRevision: manifest.sourceRevision, supervisorPid: process.pid, archive }), { flag: "wx" }); await rename(staging, ready);
		// The external controller confirms this exact owned process, then uses
		// its spawn handle to terminate it without the normal journal stop path.
		await new Promise(() => {});
		throw new Error("JOURNAL_INTERRUPTION_CONTROLLER_DID_NOT_TERMINATE");
	}
	const frozen = await readFixture(driver.context, journalInterruptionFrozenFile);
	assert.equal(frozen.sourceRevision, manifest.sourceRevision);
	assert.equal(frozen.archive.recording.state, "recording"); assert.equal(frozen.archive.recording.stoppedAt, null);
	const snapshot = await request("snapshot"); assert.equal(snapshot.available, true); assert.equal(snapshot.activeId, null); assert.equal(snapshot.recordings.length, 1);
	const expected = { ...frozen.archive, recording: { ...frozen.archive.recording, state: "interrupted", reason: "application_interrupted" }, readOnly: true };
	assert.deepEqual(await request("read", { id: expected.recording.id }), expected);
	assert.equal(driver.getProbeSequence(), 0); assert.equal((await driver.api("snapshot")).lastProbeResult, null);
	const playback = await finishJournalSmoke(driver, { previous: true, archive: expected });
	assert.equal(driver.getProbeSequence(), 0); assert.equal((await request("snapshot")).activeId, null);
	const proof = { runId: driver.context.runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, phase: fixture.phase, packaged: true, interruptedRecordingRetained: true, automaticRecordingNotResumed: true, noModelOrTaskReplay: true, syntheticModelRequests: 0, realModelRequests: 0, gameCalls: 0, playback };
	await writeFile(join(driver.context.root, "journal-interruption-" + fixture.phase + ".json"), JSON.stringify(proof), { flag: "wx" });
	assert.equal(await driver.getTray().activate("exit"), true);
}
