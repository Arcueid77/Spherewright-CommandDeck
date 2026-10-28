import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, readdir, rm, rename, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readJournalInterruptionCase, journalInterruptionCaseFile, journalInterruptionFailure, journalInterruptionProgress, journalInterruptionStagePrefix } from "../apps/desktop/journal-interruption-smoke.mjs";

test("journal interruption control data binds the exact owned run and refuses malformed or linked evidence", async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), context = { root, runId: randomUUID() }, file = join(root, journalInterruptionCaseFile);
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true }); });
	assert.equal(await readJournalInterruptionCase(context), null); assert.deepEqual(await readdir(root), []);
	const valid = { version: 1, runId: context.runId, phase: "record" }; await writeFile(file, JSON.stringify(valid), { flag: "wx" });
	assert.deepEqual(await readJournalInterruptionCase(context), valid); const original = await readFile(file);
	await assert.rejects(readJournalInterruptionCase({ ...context, runId: randomUUID() })); assert.deepEqual(await readFile(file), original);
	for (const value of [{ ...valid, phase: "execute" }, { ...valid, path: "arbitrary-private-file" }]) {
		await writeFile(file, JSON.stringify(value)); const bytes = await readFile(file); await assert.rejects(readJournalInterruptionCase(context)); assert.deepEqual(await readFile(file), bytes);
	}
	await rename(file, join(root, "retained.private.json")); await link(join(root, "retained.private.json"), file);
	await assert.rejects(readJournalInterruptionCase(context));
});

test("journal failure distinguishes an application exit from a live recording-readiness timeout", () => {
	const output = journalInterruptionStagePrefix + "entered\n" + journalInterruptionStagePrefix + "probe-start\nSMOKE_FAILURE UI_RECOVERY_PENDING\n";
	const initial = { phase: "record", exitCode: 1, timedOut: false, forced: false, remaining: 0, output };
	const exited = journalInterruptionFailure({ ...initial, controllerCode: "JOURNAL_RECORDING_APPLICATION_EXITED" });
	assert.equal(exited.reason, "application_exited_before_marker"); assert.equal(exited.lastStage, "probe-start"); assert.equal(exited.applicationCode, "UI_RECOVERY_PENDING");
	const waiting = journalInterruptionFailure({ ...initial, exitCode: null, controllerCode: "JOURNAL_RECORDING_READY_TIMEOUT" });
	assert.equal(waiting.reason, "recording_ready_timeout"); assert.equal(waiting.exitCode, null); assert.equal(waiting.timedOut, false);
	assert.equal(journalInterruptionFailure({ ...initial, remaining: null }).reason, "process_exit_unconfirmed");
});

test("public journal failure metadata cannot contain raw exception text, paths, credentials or run identities", () => {
	const privateValue = "PRIVATE_CONTEXT_MUST_STAY_PRIVATE";
	const failure = journalInterruptionFailure({ phase: privateValue, exitCode: privateValue, remaining: -1, controllerCode: privateValue,
		output: journalInterruptionStagePrefix + privateValue + "\nSMOKE_FAILURE " + privateValue + "\n" + privateValue,
	});
	assert.equal(failure.phase, "unknown"); assert.equal(failure.exitCode, null); assert.equal(failure.ownedImagesRemaining, null); assert.equal(failure.lastStage, "not-started");
	assert.equal(failure.applicationCode, "UNCLASSIFIED_APPLICATION_ERROR"); assert.equal(JSON.stringify(failure).includes(privateValue), false);
});

test("journal progress retains only bounded fixed stages and reports unavailable output conservatively", () => {
	const output = Array.from({ length: 100 }, () => journalInterruptionStagePrefix + "entered").join("\n");
	assert.equal(journalInterruptionProgress(output).length, 32); assert.deepEqual(journalInterruptionProgress(null), []);
	const unknown = journalInterruptionFailure(); assert.equal(unknown.lastStage, "not-started"); assert.equal(unknown.reason, "process_exit_unconfirmed");
});
