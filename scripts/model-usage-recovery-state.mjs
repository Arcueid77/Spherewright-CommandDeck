import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, readdir, realpath, readFile } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export async function usageRecoveryState(directory, runId, { role = "game" } = {}) {
	assert.ok(["game", "development"].includes(role));
	assert.match(runId, /^[a-f0-9-]{36}$/); assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase());
	assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(directory).startsWith("commanddeck-desktop-smoke-"));
	const profile = join(directory, "supervisor-profile/supervisor");
	async function physical(file, optional = false) {
		let info; try { info = await lstat(file); } catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
		assert.ok(!info.isSymbolicLink()); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
		if (info.isFile()) assert.equal(info.nlink, 1);
		return info;
	}
	const file = join(profile, "game-smoke-" + runId, "game-tasks.sqlite"), info = await physical(file); assert.ok(info.isFile() && info.size > 0 && info.size <= 4194304);
	const db = new DatabaseSync(file, { readOnly: true }); let rows;
	try {
		assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
		rows = Object.fromEntries(["game_tasks", "game_intents", "game_gate", "game_task_details", "game_task_events"].map(table => {
			const values = db.prepare("SELECT * FROM " + table + " ORDER BY rowid LIMIT 257").all().map(row => ({ ...row })); assert.ok(values.length <= 256); return [table, values];
		}));
	} finally { db.close(); }
	const pi = [], pending = [join(profile, "m0-probes"), join(profile, "game-agent-smoke-" + runId), join(profile, "m1-smoke-" + runId, "agent")]; let entries = 0, total = 0;
	while (pending.length) {
		const parent = pending.pop(), parentInfo = await physical(parent, true); if (!parentInfo) continue; assert.ok(parentInfo.isDirectory());
		for (const name of await readdir(parent)) {
			assert.ok(++entries <= 1024); const item = join(parent, name), entry = await physical(item);
			if (entry.isDirectory()) pending.push(item);
			else { assert.ok(entry.isFile() && entry.size <= 8388608); assert.ok((total += entry.size) <= 33554432); pi.push({ path: relative(profile, item).replaceAll("\\", "/"), bytes: entry.size, sha256: sha256(await readFile(item)) }); }
		}
	}
	assert.ok(pi.some(entry => entry.path.endsWith(".jsonl"))); pi.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const vaultFile = join(profile, "vault-smoke-" + runId, "profiles.vault.json"), vaultInfo = await physical(vaultFile); assert.ok(vaultInfo.isFile() && vaultInfo.size > 0 && vaultInfo.size <= 1048576);
	if (role === "development") {
		assert.ok(Object.values(rows).every(values => values.length === 0));
		const workFile = join(profile, "m1-smoke-" + runId, "workbench.sqlite"), workInfo = await physical(workFile); assert.ok(workInfo.isFile() && workInfo.size > 0 && workInfo.size <= 4194304);
		const work = new DatabaseSync(workFile, { readOnly: true }); let workbench;
		try {
			assert.equal(work.prepare("PRAGMA user_version").get().user_version, 1);
			workbench = Object.fromEntries(["roots", "tasks", "invocations", "changes", "events"].map(table => { const values = work.prepare("SELECT * FROM " + table + " ORDER BY rowid LIMIT 513").all().map(row => ({ ...row })); assert.ok(values.length <= 512); return [table, values]; }));
			workbench.ui = work.prepare("SELECT * FROM ui_state WHERE key IN ('selection','draft') ORDER BY key").all().map(row => ({ ...row }));
		} finally { work.close(); }
		assert.equal(await physical(join(directory, "runtime-fixtures/m3-smoke", runId, "synthetic-research-world.json"), true), null);
		return { rows, workbench, pi, vault: { bytes: vaultInfo.size, sha256: sha256(await readFile(vaultFile)) }, world: null };
	}
	const worldFile = join(directory, "runtime-fixtures/m3-smoke", runId, "synthetic-research-world.json"), worldInfo = await physical(worldFile); assert.ok(worldInfo.isFile() && worldInfo.size > 0 && worldInfo.size <= 65536);
	return { rows, pi, vault: { bytes: vaultInfo.size, sha256: sha256(await readFile(vaultFile)) }, world: { bytes: worldInfo.size, sha256: sha256(await readFile(worldFile)) } };
}
