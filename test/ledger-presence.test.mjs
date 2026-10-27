import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rename, rm, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ledgerPresenceConfiguration, prepareLedgerPresence } from "../apps/desktop/ledger-presence.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-presence-"))), id = randomUUID(), config = ledgerPresenceConfiguration(id);
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-presence-")); await rm(canonical, { recursive: true }); });
	async function create() { for (const store of config.stores) { const file = join(root, store.file); await mkdir(dirname(file), { recursive: true }); await writeFile(file, "fixture database bytes", { flag: "wx" }); } }
	return { root, id, config, create, marker: join(root, config.marker) };
}

test("fresh and complete unmarked profiles are sealed only after both stores exist; reopen preserves the inventory", async t => {
	const f = await fixture(t), guard = await prepareLedgerPresence(f.root, f.id); await assert.rejects(readFile(f.marker), { code: "ENOENT" });
	await assert.rejects(guard.seal(), /PROFILE_LEDGER_EVIDENCE_MISSING/); await f.create(); await guard.seal(); const bytes = await readFile(f.marker);
	await (await prepareLedgerPresence(f.root, f.id)).seal(); assert.deepEqual(await readFile(f.marker), bytes);
	const existing = await fixture(t); await existing.create(); await (await prepareLedgerPresence(existing.root, existing.id)).seal(); assert.ok((await readFile(existing.marker)).length > 0);
});

test("registered missing or empty stores are refused without creating a replacement file", async t => {
	for (const role of ["game", "workbench"]) {
		const f = await fixture(t); await f.create(); await (await prepareLedgerPresence(f.root, f.id)).seal(); const marker = await readFile(f.marker), file = join(f.root, f.config.stores.find(store => store.role === role).file);
		await rename(file, join(f.root, "original.retained")); await assert.rejects(prepareLedgerPresence(f.root, f.id), /PROFILE_LEDGER_EVIDENCE_MISSING/); await assert.rejects(readFile(file), { code: "ENOENT" });
		await writeFile(file, "", { flag: "wx" }); await assert.rejects(prepareLedgerPresence(f.root, f.id), /PROFILE_LEDGER_EVIDENCE_MISSING/); assert.deepEqual(await readFile(f.marker), marker);
	}
});

test("corrupt, future or changed inventories cannot authorize new paths or be silently rebuilt", async t => {
	for (const value of ["{", JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, kind: "commanddeck-ledger-presence", stores: [{ role: "game", file: "../outside.sqlite" }] })]) {
		const f = await fixture(t); await f.create(); await writeFile(f.marker, value, { flag: "wx" }); await assert.rejects(prepareLedgerPresence(f.root, f.id), /PROFILE_LEDGER_GUARD_INVALID|PROFILE_LEDGER_GUARD_UNSUPPORTED/); assert.equal(await readFile(f.marker, "utf8"), value);
	}
	const f = await fixture(t); await f.create(); const guard = await prepareLedgerPresence(f.root, f.id); await writeFile(f.marker, "partial", { flag: "wx" }); await assert.rejects(guard.seal(), /PROFILE_LEDGER_GUARD_INVALID/); assert.equal(await readFile(f.marker, "utf8"), "partial");
});

test("a missing inventory plus leftover store files or Pi session evidence still refuses initialization", async t => {
	for (const location of ["store", "sessions"]) {
		const f = await fixture(t), folder = location === "store" ? dirname(join(f.root, f.config.stores[0].file)) : join(f.root, f.config.sessions); await mkdir(folder, { recursive: true }); await writeFile(join(folder, "retained-evidence"), "preserve");
		await assert.rejects(prepareLedgerPresence(f.root, f.id), /PROFILE_LEDGER_EVIDENCE_MISSING/); await assert.rejects(readFile(f.marker), { code: "ENOENT" });
	}
});

test("legacy game-only profiles may finish normal initialization; aliased files remain refused", async t => {
	const f = await fixture(t), game = join(f.root, f.config.stores[0].file); await mkdir(dirname(game), { recursive: true }); await writeFile(game, "legacy fixture bytes");
	const guard = await prepareLedgerPresence(f.root, f.id), workbench = join(f.root, f.config.stores[1].file); await mkdir(dirname(workbench), { recursive: true }); await writeFile(workbench, "new fixture bytes"); await guard.seal();
	await link(game, join(f.root, "alias.sqlite")); await assert.rejects(prepareLedgerPresence(f.root, f.id), /PROFILE_LEDGER_EVIDENCE_MISSING/);
});
