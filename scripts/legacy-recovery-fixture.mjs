import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { portableRecoveryFile, recoveryHash } from "../apps/desktop/portable-recovery.mjs";

export async function seedLegacyRecovery(directory, runId) {
	const canonical = await realpath(directory); assert.equal(canonical.toLowerCase(), directory.toLowerCase()); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); assert.match(runId, /^[a-f0-9-]{36}$/);
	const legacy = JSON.parse(await readFile(new URL("../test/fixtures/game-ledger-v1.json", import.meta.url), "utf8"));
	assert.equal(legacy.sourceRevision, "f37dae5ad59df6968e7335c12bbc8f56a2dd5aae"); assert.equal(legacy.sourceBlob, "23fa44e215e69f47b3ed695b50858daf11f36d9f"); assert.equal(legacy.userVersion, 1); assert.equal(legacy.gameCalls, 0);
	const folder = join(directory, "supervisor-profile/supervisor/game-smoke-" + runId); await mkdir(folder, { recursive: true }); assert.equal((await realpath(folder)).toLowerCase(), folder.toLowerCase());
	const file = join(folder, "game-tasks.sqlite"); await writeFile(file, new Uint8Array(), { flag: "wx" });
	const database = new DatabaseSync(file);
	try {
		for (const entry of legacy.schema) database.exec(entry.sql);
		for (const [table, rows] of Object.entries(legacy.rows)) for (const row of rows) { const columns = Object.keys(row); database.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`).run(...columns.map(column => row[column])); }
		database.exec("PRAGMA user_version=1");
	} finally { database.close(); }
	const row = legacy.rows.game_tasks[0], original = legacy.rows.game_intents[0];
	const intent = { intentId: original.id, taskId: original.task_id, state: original.state, idempotencyKey: original.idempotency_key, actionId: original.action_id, acceptance: JSON.parse(original.acceptance), terminal: null };
	const task = { id: row.id, state: row.state, scope: JSON.parse(row.scope), previewHash: row.preview_hash, expiresAt: row.expires_at, approvalId: row.approval_id, details: {}, intent };
	const value = { version: 1, kind: "legacy-v1-pending-recovery", runId, legacySourceRevision: legacy.sourceRevision, legacySourceBlob: legacy.sourceBlob, task, intent, sha256: recoveryHash({ task, intent }) };
	await writeFile(join(directory, portableRecoveryFile), JSON.stringify(value), { flag: "wx" });
	return { file, expected: value, rows: legacy.rows };
}

export function readLegacyBaseRows(file) {
	const database = new DatabaseSync(file, { readOnly: true });
	try { return { version: database.prepare("PRAGMA user_version").get().user_version, rows: Object.fromEntries(["game_tasks", "game_intents", "game_gate"].map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))])) }; }
	finally { database.close(); }
}
