import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GameRecoveryVault } from "../apps/desktop/game-recovery-vault.mjs";

test("protected recovery records keep tokens out of snapshots and never reset pending originals", async t => {
	const directory = await mkdtemp(join(tmpdir(), "deck-recovery-vault-"));
	t.after(async () => { const path = await realpath(directory); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith("deck-recovery-vault-")); await rm(path, { recursive: true, force: true }); });
	const protection = { available: () => true, encrypt: async text => Buffer.from(text).map(value => value ^ 0x5a), decrypt: async bytes => Buffer.from(bytes).map(value => value ^ 0x5a).toString() };
	const file = join(directory, "recovery.vault.json"), vault = new GameRecoveryVault(file, protection, () => 1000);
	const candidate = { token: "PRIVATE_SYNTHETIC_TOKEN", sourceSessionId: "world", gameVersion: "1.2.3", planetId: 1, savedTick: 42, cohortHash: "a".repeat(64), schemaHash: "b".repeat(64) };
	const saved = await vault.save(candidate); assert.equal(saved.state, "ready");
	assert.ok(!(await readFile(file, "utf8")).includes(candidate.token));
	assert.ok(!JSON.stringify(await vault.snapshot()).includes(candidate.token));
	assert.equal((await vault.peek(saved.id)).token, candidate.token);
	await vault.transition(saved.id, "ready", "pending", "12345678-1234-1234-1234-123456789abc");
	const reopened = new GameRecoveryVault(file, protection, () => 1000);
	assert.equal((await reopened.snapshot()).state, "pending");
	await assert.rejects(reopened.cancelUnsent(saved.id, "00000000-0000-0000-0000-000000000000"), /GAME_RECOVERY_CANDIDATE_CHANGED/);
	await assert.rejects(reopened.peek(saved.id), /GAME_RECOVERY_CANDIDATE_CHANGED/);
	await assert.rejects(vault.save(candidate), /GAME_RECOVERY_ORIGINAL_PENDING/);
	await assert.rejects(vault.peek(saved.id), /GAME_RECOVERY_CANDIDATE_CHANGED/);
	await vault.transition(saved.id, "pending", "used");
	assert.equal((await vault.snapshot()).state, "used");
});
