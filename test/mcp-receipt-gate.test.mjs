import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, readFile, link, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { syntheticCommitReceiptReleaseFile, syntheticCommitReceiptReleased } from "../apps/desktop/synthetic-scope.mjs";

async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-receipt-gate-"))), runId = randomUUID();
	t.after(async () => { const path = await realpath(directory); assert.equal(path, directory); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith("commanddeck-receipt-gate-")); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { directory, runId, file: join(directory, syntheticCommitReceiptReleaseFile(runId)) };
}
test("a receipt release marker is empty, fixed to one run and created once", async t => {
	const f = await fixture(t); assert.equal(syntheticCommitReceiptReleased(f.directory, f.runId), false);
	await writeFile(f.file, "", { flag: "wx" }); assert.equal(syntheticCommitReceiptReleased(f.directory, f.runId), true);
	assert.equal(syntheticCommitReceiptReleased(f.directory, randomUUID()), false); assert.throws(() => syntheticCommitReceiptReleaseFile("../other"));
	await assert.rejects(writeFile(f.file, "", { flag: "wx" }), { code: "EEXIST" });
});
test("a receipt gate refuses contents and hardlinks while preserving the original bytes", async t => {
	const text = await fixture(t); await writeFile(text.file, "UNTRUSTED_CONTROL_TEXT", { flag: "wx" });
	assert.throws(() => syntheticCommitReceiptReleased(text.directory, text.runId)); assert.equal(await readFile(text.file, "utf8"), "UNTRUSTED_CONTROL_TEXT");
	const linked = await fixture(t); await writeFile(linked.file, "", { flag: "wx" }); await link(linked.file, join(linked.directory, "linked.private"));
	assert.throws(() => syntheticCommitReceiptReleased(linked.directory, linked.runId)); assert.equal((await readFile(linked.file)).length, 0);
});
