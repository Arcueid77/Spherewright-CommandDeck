import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, link } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CredentialVault } from "../apps/desktop/credential-vault.mjs";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { GameIntentLedger } from "../apps/desktop/game-intent-ledger.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";
import { assertPortableRecovery } from "../apps/desktop/portable-recovery.mjs";
import { portableProfileFile, readPortableProfileCase, runProfileVaultFixture, inventoryProfilePi, profileHash } from "../apps/desktop/portable-profile.mjs";
import { seedFullProfileHistory, readProfileWorkbenchRows } from "../scripts/full-profile-fixture.mjs";
import { readLegacyBaseRows } from "../scripts/legacy-recovery-fixture.mjs";
import { SessionManager } from "../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";

const applicationRoot = fileURLToPath(new URL("../", import.meta.url));
function unitProtection() {
	const key = randomBytes(32);
	return { available: () => true, encrypt: async text => { const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce), body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), body]); },
		decrypt: async bytes => { const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"); } };
}
async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), runId = randomUUID(), context = { root, runId }, base = join(root, "supervisor-profile/supervisor");
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	await mkdir(base, { recursive: true });
	await writeFile(join(root, portableProfileFile), JSON.stringify({ version: 1, kind: "synthetic-full-profile-migration", runId, phase: "bootstrap" }), { flag: "wx" });
	const work = new Workbench({ directory: join(base, "m1-smoke-" + runId), helperSource: join(root, "unused") });
	// The unit fixture supplies layout data; real renderer layout is verified by
	// the separate three-start packaged application controller.
	work.store.saveUi("layout", { grid: { root: {} }, panels: { "game-agent": { id: "game-agent", contentComponent: "game-agent" } } }); await work.close();
	const gameDirectory = join(base, "game-smoke-" + runId); await mkdir(gameDirectory);
	new GameIntentLedger(join(gameDirectory, "game-tasks.sqlite"), { approvalAuthority: {}, prepareResearch: async () => { throw new Error("NO_TRANSPORT"); }, readResearchProof: async () => { throw new Error("NO_TRANSPORT"); } }).close();
	const probe = join(base, "m0-probes/unit"); await mkdir(probe, { recursive: true });
	const manager = SessionManager.create(probe, join(probe, "sessions")), usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	manager.appendMessage({ role: "user", content: "Synthetic session retention fixture.", timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "deck_echo", arguments: { text: "synthetic" } }], api: "openai-completions", provider: "synthetic-history", model: "fixture", usage, stopReason: "toolUse", timestamp: 2 });
	manager.appendMessage({ role: "toolResult", toolCallId: "fixture-call", toolName: "deck_echo", content: [{ type: "text", text: "synthetic" }], isError: false, timestamp: 3 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic complete history." }], api: "openai-completions", provider: "synthetic-history", model: "fixture", usage, stopReason: "stop", timestamp: 4 });
	const vault = new CredentialVault(join(base, "vault-smoke-" + runId, "profiles.vault.json"), unitProtection());
	const vaultMetadata = await runProfileVaultFixture(vault, context, "bootstrap");
	const seed = await seedFullProfileHistory({ context, applicationRoot, bootstrap: { runId, emptyIsolatedWorkspace: true, fullProfileBootstrap: { nativeCiphertextCreated: true, vault: vaultMetadata } } });
	return { context, base, vault, seed };
}

test("a whole synthetic business profile retains both ledgers, unsent UI state, protected config and every Pi session across migration and reconstruction", async t => {
	const f = await fixture(t), originalGame = readLegacyBaseRows(f.seed.legacy.file); assert.equal(originalGame.version, 1);
	for (let attempt = 0; attempt < 2; attempt++) {
		let unexpected = 0; const fail = () => { unexpected++; throw new Error("NO_EXECUTION_DURING_MIGRATION"); };
		const work = new Workbench({ directory: join(f.base, "m1-smoke-" + f.context.runId), helperSource: join(f.context.root, "unused") });
		const game = new GameTasks({ directory: dirname(f.seed.legacy.file), bridge: {}, researchAuthority: {}, approvalAuthority: {}, syntheticOnly: true, planner: fail, freezeDevelopment: async () => { work.gameWritesFrozen = false; }, releaseDevelopment: fail });
		try {
			await game.initialize();
			const api = async (action, args) => action === "game" ? game.snapshot() : action === "workbench" ? work.request(args.action, args.args) : { selected: null, metadata: null, observation: null, requestPerformance: null };
			const profile = await readPortableProfileCase(f.context), proof = await assertPortableRecovery(api, f.seed.legacy.expected, profile);
			assert.equal(proof.developmentFrozen, true); assert.equal(proof.profile.developmentTasks, 2); assert.equal(proof.profile.invocations, 1); assert.equal(proof.profile.changes, 1); assert.equal(proof.profile.references, 1);
			assert.deepEqual(await runProfileVaultFixture(f.vault, f.context, "recover"), profile.expected.vault);
			assert.deepEqual(await inventoryProfilePi(f.context), profile.expected.pi);
			await assert.rejects(work.start({ rootId: profile.expected.workbench.roots[0].id, kind: "check" }, fail), /GAME_EXECUTION_OWNS_RUNTIME/);
			assert.throws(() => game.ledger.confirmationPreview(f.seed.legacy.expected.task.id), /FRESH_RESEARCH_PREVIEW_REQUIRED/);
			assert.equal(unexpected, 0); await game.drain(); assert.equal(unexpected, 0);
		} finally { game.close(); await work.close(); }
		assert.deepEqual(readProfileWorkbenchRows(join(f.base, "m1-smoke-" + f.context.runId, "workbench.sqlite")), f.seed.workbenchRows);
		const after = readLegacyBaseRows(f.seed.legacy.file); assert.equal(after.version, 2); assert.deepEqual(after.rows, originalGame.rows);
		assert.equal(profileHash(await readFile(f.seed.workspaceFile)), f.seed.workspaceSha256);
	}
});

test("full-profile expectations reject a foreign run or outside root before touching any protected profile", async t => {
	const f = await fixture(t), file = join(f.context.root, portableProfileFile), original = await readFile(file);
	await assert.rejects(readPortableProfileCase({ ...f.context, runId: randomUUID() }));
	const changed = JSON.parse(original); changed.expected.workbench.roots[0].path = dirname(f.context.root); changed.sha256 = profileHash(changed.expected); await writeFile(file, JSON.stringify(changed));
	let touched = false;
	await assert.rejects(runProfileVaultFixture({ get file() { touched = true; throw new Error("UNEXPECTED_VAULT_ACCESS"); } }, f.context, "recover")); assert.equal(touched, false);
	await writeFile(file, original);
	const redirected = structuredClone(changed); redirected.expected.workbench.roots[0].path = f.seed.caseValue.expected.workbench.roots[0].path; redirected.expected.pi[0].path = "m0-probes/../../outside.jsonl"; redirected.sha256 = profileHash(redirected.expected); await writeFile(file, JSON.stringify(redirected)); await assert.rejects(readPortableProfileCase(f.context));
});

test("encrypted profile corruption and redirected Pi evidence fail without replacing either original", async t => {
	const f = await fixture(t), original = await readFile(f.vault.file), damaged = JSON.parse(original); const bytes = Buffer.from(damaged.entries[0].encrypted, "base64"); bytes[bytes.length - 1] ^= 1; damaged.entries[0].encrypted = bytes.toString("base64"); const damagedBytes = Buffer.from(JSON.stringify(damaged)); await writeFile(f.vault.file, damagedBytes);
	await assert.rejects(runProfileVaultFixture(f.vault, f.context, "recover"), /PROTECTED_STORE_DECRYPT_FAILED/); assert.deepEqual(await readFile(f.vault.file), damagedBytes); await writeFile(f.vault.file, original);
	const entry = f.seed.caseValue.expected.pi.find(file => file.path.endsWith(".jsonl"));
	await link(join(f.base, entry.path), join(f.context.root, "pi-alias.jsonl")); await assert.rejects(inventoryProfilePi(f.context));
});
