import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { preserveModelDataLock } from "../scripts/pi-model-data-lock.mjs";

const pin = { package: "fixture", version: "1.0.0", integrity: "sha512-fixture", dataFiles: 3, sourceCommit: "a".repeat(40) };
function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "commanddeck-model-pin-"));
	t.after(() => {
		const canonical = realpathSync(directory);
		assert.equal(dirname(canonical).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
		assert.ok(basename(canonical).startsWith("commanddeck-model-pin-"));
		rmSync(canonical, { recursive: true, force: true });
	});
	return join(directory, "pin.json");
}

test("hydration retains the exact bytes and mtime of an existing matching Windows model pin", t => {
	const path = fixture(t), bytes = Buffer.from(JSON.stringify(pin, null, 4).replaceAll("\n", "\r\n") + "\r\n");
	writeFileSync(path, bytes); const before = statSync(path, { bigint: true });
	preserveModelDataLock(path, pin);
	assert.deepEqual(readFileSync(path), bytes);
	assert.equal(statSync(path, { bigint: true }).mtimeNs, before.mtimeNs);
});

test("hydration rejects changed provenance or malformed pins without replacing their bytes", t => {
	const path = fixture(t);
	for (const value of [{ ...pin, sourceCommit: "b".repeat(40) }, { ...pin, dataFiles: 4 }, { ...pin, extra: true }, null]) {
		const bytes = JSON.stringify(value); writeFileSync(path, bytes);
		assert.throws(() => preserveModelDataLock(path, pin), /metadata changed/);
		assert.equal(readFileSync(path, "utf8"), bytes);
	}
	writeFileSync(path, "not JSON"); assert.throws(() => preserveModelDataLock(path, pin));
	assert.equal(readFileSync(path, "utf8"), "not JSON");
});

test("the first hydration creates a pin exclusively and subsequent hydration only verifies it", t => {
	const path = fixture(t); preserveModelDataLock(path, pin);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), pin);
	const before = readFileSync(path); preserveModelDataLock(path, pin);
	assert.deepEqual(readFileSync(path), before);
});
