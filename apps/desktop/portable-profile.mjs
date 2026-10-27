import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat, realpath, readdir } from "node:fs/promises";
import { join, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";

export const portableProfileFile = "full-profile-case.json";
export const profileHash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const exactKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const fingerprint = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function profileFixtureSpec(runId) {
	assert.match(runId, /^[a-f0-9-]{36}$/);
	return { id: "deckvault-" + runId, label: "Synthetic profile migration", modelId: "retained-fixture-model", api: "openai-completions", baseUrl: "https://profile-migration.invalid/v1", contextWindow: 8192, maxTokens: 2048, apiKey: "synthetic-profile-key-" + runId };
}
async function scope(context) {
	profileFixtureSpec(context.runId);
	assert.equal((await realpath(context.root)).toLowerCase(), context.root.toLowerCase());
	assert.equal(dirname(context.root).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
	assert.ok(basename(context.root).startsWith("commanddeck-desktop-smoke-"));
	return join(context.root, "supervisor-profile/supervisor");
}
function validPiPath(path, runId) {
	return typeof path === "string" && path.length <= 4096 && path.split("/").every(part => part && part !== "." && part !== ".." && !/[\\:\0]/.test(part)) &&
		["m0-probes/", "game-agent-smoke-" + runId + "/", "m1-smoke-" + runId + "/agent/"].some(prefix => path.startsWith(prefix));
}

// Synthetic expectations are comparison data, never grants, commands or approvals.
export async function readPortableProfileCase(context) {
	await scope(context);
	const file = join(context.root, portableProfileFile); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 262144, "FULL_PROFILE_CASE_INVALID");
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.equal(value.version, 1); assert.equal(value.kind, "synthetic-full-profile-migration"); assert.equal(value.runId, context.runId);
	assert.ok(["bootstrap", "recover"].includes(value.phase));
	exactKeys(value, value.phase === "bootstrap" ? ["version", "kind", "runId", "phase"] : ["version", "kind", "runId", "phase", "expected", "sha256"]);
	if (value.phase === "bootstrap") return value;
	exactKeys(value.expected, ["workbench", "vault", "pi"]);
	assert.equal(value.sha256, profileHash(value.expected));
	const work = value.expected.workbench;
	exactKeys(work, ["roots", "tasks", "taskDetails", "ui"]);
	assert.equal(work.roots.length, 1); const root = work.roots[0];
	assert.equal(root.path, join(context.root, "profile-workspace")); assert.equal(root.enabled, true); assert.equal(root.canWrite, false); assert.equal(root.canExecute, false);
	assert.equal(work.tasks.length, 2); assert.equal(work.taskDetails.length, 2);
	for (const task of work.tasks) { assert.equal(task.rootId, root.id); assert.equal(task.state, "succeeded"); assert.ok(["agent", "check"].includes(task.kind)); }
	assert.deepEqual(work.taskDetails.map(task => task.id).sort(), work.tasks.map(task => task.id).sort());
	for (const task of work.taskDetails) { assert.equal(task.state, "succeeded"); assert.equal(task.rootId, root.id); assert.ok(task.invocations.every(call => call.state === "completed")); }
	exactKeys(work.ui, ["layout", "selection", "draft", "editor"]);
	assert.ok(work.ui.layout && typeof work.ui.layout === "object" && work.ui.layout.panels?.["game-agent"]);
	assert.equal(work.ui.selection.rootId, root.id); assert.ok(work.tasks.some(task => task.id === work.ui.selection.taskId));
	assert.equal(work.ui.editor.rootId, root.id); assert.equal(work.ui.editor.path, "fixture.txt"); assert.ok(fingerprint(work.ui.editor.sha256));
	assert.ok(typeof work.ui.editor.text === "string" && work.ui.editor.text !== work.ui.editor.diskText);
	assert.equal(work.ui.draft.prompt, "Unsent full-profile draft " + context.runId);
	const spec = profileFixtureSpec(context.runId), metadata = [{ providerId: spec.id, modelId: spec.modelId, label: spec.label, api: spec.api, source: "protected" }];
	exactKeys(value.expected.vault, ["profiles", "ciphertextSha256", "ciphertextBytes"]);
	assert.deepEqual(value.expected.vault.profiles, metadata); assert.ok(fingerprint(value.expected.vault.ciphertextSha256));
	assert.ok(Number.isInteger(value.expected.vault.ciphertextBytes) && value.expected.vault.ciphertextBytes > 0 && value.expected.vault.ciphertextBytes <= 1048576);
	assert.ok(Array.isArray(value.expected.pi) && value.expected.pi.length >= 3 && value.expected.pi.length <= 512);
	const paths = new Set();
	for (const entry of value.expected.pi) { exactKeys(entry, ["path", "bytes", "sha256"]); assert.ok(validPiPath(entry.path, context.runId)); assert.ok(!paths.has(entry.path)); paths.add(entry.path); assert.ok(fingerprint(entry.sha256)); assert.ok(Number.isInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 8388608); }
	return value;
}

export async function inventoryProfilePi(context) {
	const base = await scope(context), runId = context.runId, files = [], pending = [join(base, "m0-probes"), join(base, "game-agent-smoke-" + runId), join(base, "m1-smoke-" + runId, "agent")];
	let entries = 0, total = 0;
	while (pending.length) {
		const parent = pending.pop(), parentInfo = await lstat(parent);
		assert.ok(parentInfo.isDirectory() && !parentInfo.isSymbolicLink()); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++entries <= 1024, "FULL_PROFILE_PI_TOO_LARGE");
			const file = join(parent, name), info = await lstat(file);
			assert.ok(!info.isSymbolicLink()); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
			if (info.isDirectory()) pending.push(file);
			else {
				assert.ok(info.isFile() && info.nlink === 1 && info.size <= 8388608); assert.ok((total += info.size) <= 33554432);
				const path = relative(base, file).replaceAll("\\", "/"); assert.ok(validPiPath(path, runId));
				files.push({ path, bytes: info.size, sha256: profileHash(await readFile(file)) });
			}
		}
	}
	assert.ok(files.length <= 512);
	for (const prefix of ["m0-probes/", "game-agent-smoke-" + runId + "/", "m1-smoke-" + runId + "/agent/"]) assert.ok(files.some(file => file.path.startsWith(prefix) && file.path.endsWith(".jsonl") && file.bytes > 0), "FULL_PROFILE_PI_SESSION_MISSING");
	return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

// Only the isolated packaged smoke host receives this closure's vault object.
export async function runProfileVaultFixture(vault, context, phase) {
	const base = await scope(context), value = await readPortableProfileCase(context), spec = profileFixtureSpec(context.runId);
	assert.equal(value?.phase, phase); assert.equal(vault.file, join(base, "vault-smoke-" + context.runId, "profiles.vault.json"));
	assert.equal(vault.available(), true);
	if (phase === "bootstrap") { assert.deepEqual((await vault.list()).profiles, []); await vault.save({ ...spec, expectedRevision: null }); }
	else assert.equal(phase, "recover");
	const list = await vault.list(), resolved = await vault.resolve(spec.id, spec.modelId);
	assert.equal(resolved.key, spec.apiKey); assert.equal(resolved.baseUrl, spec.baseUrl); assert.equal(resolved.api, spec.api); assert.equal(resolved.contextWindow, spec.contextWindow); assert.equal(resolved.maxTokens, spec.maxTokens);
	assert.equal((await vault.describe(spec.id)).key, undefined);
	const info = await lstat(vault.file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1048576);
	const bytes = await readFile(vault.file); assert.equal(bytes.includes(Buffer.from(spec.apiKey)), false, "FULL_PROFILE_CREDENTIAL_STORED_AS_PLAINTEXT");
	const actual = { profiles: list.profiles, ciphertextSha256: profileHash(bytes), ciphertextBytes: bytes.length };
	if (phase === "recover") assert.deepEqual(actual, value.expected.vault, "FULL_PROFILE_VAULT_CHANGED");
	return actual;
}

export async function assertFullProfileWorkbench(api, expected) {
	const state = await api("workbench", { action: "state" });
	assert.deepEqual(state.roots, expected.roots); assert.deepEqual(state.tasks, expected.tasks);
	const details = [];
	for (const task of expected.taskDetails) details.push(await api("workbench", { action: "task", args: { taskId: task.id } }));
	assert.deepEqual(details, expected.taskDetails, "FULL_PROFILE_TASK_HISTORY_CHANGED");
	const ui = {};
	for (const key of ["layout", "selection", "draft", "editor"]) ui[key] = await api("workbench", { action: "ui-get", args: { key } });
	assert.deepEqual(ui, expected.ui, "FULL_PROFILE_UI_STATE_CHANGED");
	return { workbenchSha256: profileHash({ roots: state.roots, tasks: state.tasks, taskDetails: details, ui }), developmentTasks: details.length, invocations: details.reduce((n, task) => n + task.invocations.length, 0), changes: details.reduce((n, task) => n + task.changes.length, 0), references: details.reduce((n, task) => n + task.references.length, 0), unsentEditorAndDraftPreserved: true, layoutAndSelectionPreserved: true };
}

export async function runProfileBootstrap(driver) {
	const { api, testCommand } = driver;
	let layout = null, activated = false; const until = performance.now() + 10000;
	while (!activated || !layout?.panels?.["game-agent"]) {
		if (!activated) activated = await testCommand("evaluate", { source: "(()=>{const header=document.querySelector('header'),button=[...document.querySelectorAll('header button')].find(button=>button.textContent==='游戏 Agent');if(header?.getAttribute('aria-busy')!=='false'||!button||button.disabled)return false;button.click();return true})()" });
		layout = await api("workbench", { action: "ui-get", args: { key: "layout" } });
		assert.ok(performance.now() < until, "FULL_PROFILE_REAL_LAYOUT_NOT_PERSISTED");
		if (!activated || !layout?.panels?.["game-agent"]) await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.equal(activated, true);
	const vault = await driver.profileVaultFixture("bootstrap");
	return { vault, layoutSha256: profileHash(layout), realRendererLayoutPersisted: true, nativeCiphertextCreated: true };
}
