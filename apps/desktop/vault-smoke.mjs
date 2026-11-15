import { app, safeStorage } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { CredentialVault } from "./credential-vault.mjs";
import { GameRecoveryVault } from "./game-recovery-vault.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), runId = process.env.COMMANDDECK_VAULT_SMOKE_ID, phase = process.argv.at(-1);
if (!/^[0-9a-f-]{36}$/.test(runId ?? "") || !["write", "read"].includes(phase)) throw new Error("EXPLICIT_VAULT_SMOKE_REQUIRED");
const directory = join(root, ".local/vault-smoke", runId);
mkdirSync(directory, { recursive: true }); app.setPath("userData", directory);
app.whenReady().then(async () => { try {
	assert.equal(process.platform, "win32"); assert.equal(safeStorage.isEncryptionAvailable(), true);
	const protection = { available: () => process.platform === "win32" && safeStorage.isEncryptionAvailable(), encrypt: (text) => safeStorage.encryptStringAsync(text), decrypt: async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result };
	const file = join(directory, "profiles.vault.json"), vault = new CredentialVault(file, protection), id = "deckvault-" + runId, key = "synthetic-vault-" + runId;
	const recoveryFile = join(directory, "game-recovery.vault.json"), recovery = new GameRecoveryVault(recoveryFile, protection), token = "synthetic-recovery-" + runId;
	if (phase === "write") {
		await vault.save({ id, label: "OS protection fixture", api: "openai-completions", baseUrl: "https://fixture.invalid/v1", modelId: "fixture-model", contextWindow: 8192, maxTokens: 2048, apiKey: key, expectedRevision: null });
		await recovery.save({ token, sourceSessionId: "synthetic-world", gameVersion: "1.2.3", planetId: 1, savedTick: 42, cohortHash: "a".repeat(64), schemaHash: "b".repeat(64) });
	}
	else {
		assert.equal((await vault.resolve(id, "fixture-model")).key, key);
		assert.equal((await vault.describe(id)).key, undefined);
		assert.ok(!(await readFile(file, "utf8")).includes(key));
		const candidate = await recovery.snapshot(); assert.equal(candidate.state, "ready"); assert.equal((await recovery.peek(candidate.id)).token, token);
		assert.ok(!(await readFile(recoveryFile, "utf8")).includes(token)); assert.ok(!JSON.stringify(candidate).includes(token));
		await recovery.transition(candidate.id, "ready", "pending", runId);
		assert.equal((await new GameRecoveryVault(recoveryFile, protection).snapshot()).state, "pending");
		await writeFile(join(root, ".local/credential-vault-smoke.json"), JSON.stringify({ runId, nativeProtection: "Windows safeStorage", separateProcessReopen: true, ciphertextOnly: true, publicMetadataHasNoKey: true, gameRecoveryCiphertextOnly: true, gameRecoveryPendingRetained: true, syntheticCredentialOnly: true, modelRequests: 0, gameCalls: 0 }, null, 2));
	}
	app.exit(0);
} catch (error) { console.error("VAULT_OS_SMOKE_FAILED", error.message); app.exit(1); } }).catch(() => app.exit(1));
