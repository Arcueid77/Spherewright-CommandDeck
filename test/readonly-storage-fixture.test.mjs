import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { denyOwnedFileWrites, restoreOwnedFileWrites, assertOwnedReadonlyFile } from "../scripts/readonly-storage-fixture.mjs";
import { denyOwnedAclFileWrites, restoreOwnedAclFileWrites, assertOwnedAclReadonlyFile } from "../scripts/acl-storage-fixture.mjs";
import { WorkbenchStore } from "../apps/desktop/workbench-store.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { startupFailureCode } from "../apps/desktop/startup-failure.mjs";

async function fixture(t, kind = "game", initialize = file => { const db = new DatabaseSync(file); db.exec("CREATE TABLE fixture(value TEXT);INSERT INTO fixture VALUES('original');"); db.close(); }) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), folder = join(root, "supervisor-profile/supervisor", (kind === "game" ? "game-smoke-" : "m1-smoke-") + randomUUID()); await mkdir(folder, { recursive: true });
	const file = join(folder, kind === "game" ? "game-tasks.sqlite" : "workbench.sqlite"); initialize(file);
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true }); });
	return { root, file };
}

test("Windows storage fault uses real file denial and SQLite read-only rejection while preserving bytes", { skip: process.platform !== "win32" }, async t => {
	const f = await fixture(t), before = await readFile(f.file), mode = await denyOwnedFileWrites(f);
	try { const proof = await assertOwnedReadonlyFile(f); assert.equal(proof.actualOsWriteDenied, true); assert.equal(proof.sqliteReadOnlyObserved, true); assert.deepEqual(await readFile(f.file), before); }
	finally { await restoreOwnedFileWrites({ ...f, mode }); }
	const db = new DatabaseSync(f.file); try { db.exec("INSERT INTO fixture VALUES('restored')"); assert.equal(db.prepare("SELECT count(*) AS n FROM fixture").get().n, 2); } finally { db.close(); }
});

test("valid current ledgers cannot silently open read-only and report a usable writable store", { skip: process.platform !== "win32" }, async t => {
	const ports = { approvalAuthority: {}, prepareResearch: async () => { throw new Error("NO_FIXTURE_TRANSPORT"); }, readResearchProof: async () => { throw new Error("NO_FIXTURE_TRANSPORT"); } };
	for (const kind of ["game", "workbench"]) {
		const construct = file => kind === "game" ? new GameIntentLedger(file, ports) : new WorkbenchStore(file);
		const f = await fixture(t, kind, file => construct(file).close()), before = await readFile(f.file), mode = await denyOwnedFileWrites(f); let unexpected;
		try { assert.throws(() => { unexpected = construct(f.file); }, error => startupFailureCode(error) === "STARTUP_STORAGE_UNAVAILABLE"); }
		finally { unexpected?.close(); await restoreOwnedFileWrites({ ...f, mode }); }
		assert.deepEqual(await readFile(f.file), before);
	}
});

test("fault injection refuses outside files, aliased files and invalid restore modes before changing permissions", { skip: process.platform !== "win32" }, async t => {
	const f = await fixture(t), outside = join(f.root, "not-a-ledger.sqlite"), before = await readFile(f.file); await writeFile(outside, before);
	await assert.rejects(denyOwnedFileWrites({ root: f.root, file: outside }), /READONLY_FIXTURE_SCOPE_INVALID/);
	await link(f.file, join(f.root, "alias.sqlite")); await assert.rejects(denyOwnedFileWrites(f), /READONLY_FIXTURE_SCOPE_INVALID/); assert.deepEqual(await readFile(f.file), before);
	const second = await fixture(t); await assert.rejects(restoreOwnedFileWrites({ ...second, mode: 0 }), /READONLY_FIXTURE_RESTORE_MODE_INVALID/);
});

test("Windows ACL denial preserves the file attribute and bytes, and restores the exact original DACL", { skip: process.platform !== "win32" }, async t => {
	const f = await fixture(t), before = await readFile(f.file), lease = await denyOwnedAclFileWrites(f);
	try {
		const proof = await assertOwnedAclReadonlyFile(f);
		assert.equal(proof.actualOsWriteDenied, true); assert.equal(proof.sqliteReadOnlyObserved, true); assert.equal(proof.readonlyAttributeChanged, false);
		assert.notEqual(lease.originalDaclSha256, lease.deniedDaclSha256); assert.deepEqual(await readFile(f.file), before);
		await assert.rejects(restoreOwnedAclFileWrites({ ...f, lease: { ...lease } }), /ACL_FIXTURE_RESTORE_LEASE_INVALID/);
	} finally { const proof = await restoreOwnedAclFileWrites({ ...f, lease }); assert.equal(proof.exactOriginalDaclRestored, true); }
	await assert.rejects(restoreOwnedAclFileWrites({ ...f, lease }), /ACL_FIXTURE_RESTORE_LEASE_INVALID/);
	const db = new DatabaseSync(f.file); try { db.exec("INSERT INTO fixture VALUES('restored')"); assert.equal(db.prepare("SELECT count(*) AS n FROM fixture").get().n, 2); } finally { db.close(); }
	const outside = join(f.root, "not-a-ledger.sqlite"); await writeFile(outside, before);
	await assert.rejects(denyOwnedAclFileWrites({ root: f.root, file: outside }), /READONLY_FIXTURE_SCOPE_INVALID/);
	await link(f.file, join(f.root, "alias.sqlite")); await assert.rejects(denyOwnedAclFileWrites(f), /READONLY_FIXTURE_SCOPE_INVALID/);
});

test("both current ledgers refuse an actual ACL write denial before reporting storage available", { skip: process.platform !== "win32" }, async t => {
	const ports = { approvalAuthority: {}, prepareResearch: async () => { throw new Error("NO_FIXTURE_TRANSPORT"); }, readResearchProof: async () => { throw new Error("NO_FIXTURE_TRANSPORT"); } };
	for (const kind of ["game", "workbench"]) {
		const construct = file => kind === "game" ? new GameIntentLedger(file, ports) : new WorkbenchStore(file);
		const f = await fixture(t, kind, file => construct(file).close()), before = await readFile(f.file), lease = await denyOwnedAclFileWrites(f); let unexpected;
		try { await assertOwnedAclReadonlyFile(f); assert.throws(() => { unexpected = construct(f.file); }, error => startupFailureCode(error) === "STARTUP_STORAGE_UNAVAILABLE"); }
		finally { unexpected?.close(); await restoreOwnedAclFileWrites({ ...f, lease }); }
		assert.deepEqual(await readFile(f.file), before);
		construct(f.file).close();
	}
});
