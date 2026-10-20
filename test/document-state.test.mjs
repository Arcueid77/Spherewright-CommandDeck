import test from "node:test";
import assert from "node:assert/strict";
import { DocumentLease } from "../apps/renderer/src/document-state.ts";

test("a delayed file open preserves input made while the read was pending", async () => {
	const lease = new DocumentLease(); let release, document = "original", persisted = "original";
	const open = lease.load(() => new Promise((done) => { release = done; }), (value) => { document = value; persisted = value; });
	lease.changed(); document = "unsaved user input"; persisted = document;
	release("late file content");
	assert.equal(await open, false);
	assert.equal(document, "unsaved user input"); assert.equal(persisted, document);
});

test("out-of-order file reads can only apply the most recent open request", async () => {
	const lease = new DocumentLease(); let first, second, document = "original";
	const old = lease.load(() => new Promise((done) => { first = done; }), (value) => { document = value; lease.changed(); });
	const latest = lease.load(() => new Promise((done) => { second = done; }), (value) => { document = value; lease.changed(); });
	second("selected second file"); assert.equal(await latest, true);
	first("late first file"); assert.equal(await old, false);
	assert.equal(document, "selected second file");
});
