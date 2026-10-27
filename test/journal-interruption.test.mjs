import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, readdir, rm, rename, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { readJournalInterruptionCase, journalInterruptionCaseFile } from "../apps/desktop/journal-interruption-smoke.mjs";

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
