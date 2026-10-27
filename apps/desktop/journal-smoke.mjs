import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function until(predicate, label) { const deadline = performance.now() + 10000; while (!await predicate()) { assert.ok(performance.now() < deadline, "JOURNAL_SMOKE_TIMEOUT_" + label); await new Promise(resolve => setTimeout(resolve, 40)); } }
const request = (driver, action, args = {}) => driver.api("journal", { action, args });
const ui = (driver, source) => driver.testCommand("evaluate", { source });
async function openPanel(driver) {
	await until(async () => await ui(driver, "[...document.querySelectorAll('header button')].some(button=>button.textContent==='运行日记'&&!button.disabled)"), "HEADER_READY");
	await ui(driver, "[...document.querySelectorAll('header button')].find(button=>button.textContent==='运行日记').click();true");
	await until(async () => await ui(driver, "Boolean(document.querySelector('.journal-panel'))"), "PANEL");
}
export async function beginJournalSmoke(driver, previous) {
	await openPanel(driver);
	const snapshot = await request(driver, "snapshot"); assert.equal(snapshot.available, true); assert.equal(snapshot.activeId, null);
	if (previous) {
		let expected;
		try { expected = JSON.parse(await readFile(join(driver.context.root, "journal-original.private.json"), "utf8")); }
		catch (error) { if (error.code !== "ENOENT" || snapshot.recordings.length) throw error; }
		if (expected) { assert.equal(expected.runId, driver.context.runId); assert.deepEqual(await request(driver, "read", { id: expected.archive.recording.id }), expected.archive); return { previous: true, archive: expected.archive }; }
	}
	await until(async () => await ui(driver, "[...document.querySelectorAll('.journal-panel button')].some(button=>button.textContent==='开始事件记录'&&!button.disabled)"), "START_READY");
	await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='开始事件记录').click();true");
	await until(async () => Boolean((await request(driver, "snapshot")).activeId), "START");
	return { previous: false, id: (await request(driver, "snapshot")).activeId };
}
export async function finishJournalSmoke(driver, recording) {
	await openPanel(driver);
	const sequence = driver.getProbeSequence(), runtime = driver.getRuntimePid(), native = await driver.api("status");
	let archive = recording.archive;
	if (!recording.previous) {
		await until(async () => (await request(driver, "read", { id: recording.id })).events.length >= 3, "EVENTS");
		await until(async () => await ui(driver, "document.querySelector('.journal-panel')?.getAttribute('data-journal-mode')==='live'"), "LIVE_VIEW");
		await until(async () => await ui(driver, "[...document.querySelectorAll('.journal-panel button')].some(button=>button.textContent==='下一事件'&&!button.disabled)"), "EVENTS_RENDERED");
		await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='下一事件').click();true");
		await until(async () => await ui(driver, "document.querySelector('.journal-event')?.getAttribute('data-event-sequence')==='2'"), "POSITION");
		await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='添加事件书签').click();true");
		await until(async () => (await request(driver, "read", { id: recording.id })).bookmarks.length === 1, "BOOKMARK");
		await until(async () => await ui(driver, "[...document.querySelectorAll('.journal-panel button')].some(button=>button.textContent==='停止事件记录'&&!button.disabled)"), "STOP_READY");
		await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='停止事件记录').click();true");
		await until(async () => (await request(driver, "snapshot")).activeId === null, "STOP");
		archive = await request(driver, "read", { id: recording.id }); assert.equal(archive.recording.state, "stopped"); assert.equal(archive.readOnly, true); assert.equal(archive.executionAuthority, false);
		if (driver.context) await writeFile(join(driver.context.root, "journal-original.private.json"), JSON.stringify({ runId: driver.context.runId, archive }), { flag: "wx" });
	}
	const knownProbeToolNamesRecorded = archive.events.some(event => event.domain === "probe" && event.kind === "tool" && event.facts.tool === "deck_echo");
	if (!recording.previous) assert.equal(knownProbeToolNamesRecorded, true, "FORWARDED_PROBE_TOOL_NAME_MISSING");
	await until(async () => await ui(driver, "document.querySelector('.journal-panel')?.getAttribute('data-journal-mode')==='replay'"), "READ_ONLY_VIEW");
	const denied = await ui(driver, "(async()=>{let denied=0;for(const action of ['execute','commit','replay','resume'])try{await window.deck.journal(action,{})}catch{denied++}return denied})()"); assert.equal(denied, 4);
	await assert.rejects(request(driver, "bookmark", { id: archive.recording.id, sequence: 1, tag: "attention" }), /JOURNAL_BOOKMARK_INVALID/);
	await until(async () => await ui(driver, "Boolean(document.querySelector('.journal-bookmarks button'))"), "BOOKMARK_RENDERED");
	await ui(driver, "document.querySelector('.journal-bookmarks button').click();true");
	await until(async () => await ui(driver, "document.querySelector('.journal-event')?.getAttribute('data-event-sequence')==='2'"), "BOOKMARK_NAVIGATION");
	assert.equal(await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='添加事件书签').disabled"), true);
	await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='连续浏览').click();true");
	await until(async () => await ui(driver, "Number(document.querySelector('.journal-event')?.getAttribute('data-event-sequence'))>=3"), "CONTINUOUS_REPLAY");
	await ui(driver, "[...document.querySelectorAll('.journal-panel button')].find(button=>button.textContent==='暂停浏览')?.click();true");
	await driver.testCommand("reload");
	await openPanel(driver);
	await until(async () => await ui(driver, "Boolean(document.querySelector('.journal-panel .journal-event'))"), "RELOAD");
	assert.deepEqual(await request(driver, "read", { id: archive.recording.id }), archive);
	assert.equal(driver.getProbeSequence(), sequence); assert.equal(driver.getRuntimePid(), runtime);
	const after = await driver.api("status"); assert.equal(after.attached, native.attached); assert.equal(after.targetPid, native.targetPid);
	return { localEventJournal: true, recordingRowsRetained: true, bookmarkNavigation: true, historicalReplayReadOnly: true, replayExecutionActionsRejected: true, uiReloadRetainsJournal: true, noModelOrTaskReplay: true, originalNativeStateRetained: true, previousAppRecordingReopened: recording.previous, knownProbeToolNamesRecorded, eventCount: archive.events.length, bookmarkCount: archive.bookmarks.length, videoRecordingVerified: false, physicalInputVerified: false };
}
export async function runJournalSmoke(driver) {
	const recording = await beginJournalSmoke(driver, false);
	const result = await driver.api("probe", { mode: "offline" }); assert.equal(result.requestCount, 2);
	const proof = await finishJournalSmoke(driver, recording), directory = join(driver.root, ".local/journal-smoke", driver.runId);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "application.private.json"), JSON.stringify({ runId: driver.runId, ...proof, syntheticModelRequests: 2, realModelRequests: 0, gameCalls: 0 }), { flag: "wx" });
}
