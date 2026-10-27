import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, readdir, lstat, realpath, rename } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { seedLegacyRecovery } from "./legacy-recovery-fixture.mjs";
import { portableProfileFile, readPortableProfileCase, profileFixtureSpec, profileHash, inventoryProfilePi } from "../apps/desktop/portable-profile.mjs";

const execute = promisify(execFile);
const tables = ["roots", "tasks", "invocations", "events", "changes", "ui_state"];
export function readProfileWorkbenchRows(file) {
	const database = new DatabaseSync(file, { readOnly: true });
	try { assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1); return Object.fromEntries(tables.map(table => [table, database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all().map(row => ({ ...row, ...(table === "ui_state" ? { value: JSON.parse(row.value) } : {}) }))])); }
	finally { database.close(); }
}
async function messagesFromProbe(base) {
	const pending = [join(base, "m0-probes")]; let entries = 0;
	while (pending.length) {
		const parent = pending.pop(); assert.equal((await realpath(parent)).toLowerCase(), parent.toLowerCase());
		for (const name of await readdir(parent)) {
			assert.ok(++entries <= 512); const file = join(parent, name), info = await lstat(file); assert.ok(!info.isSymbolicLink());
			if (info.isDirectory()) pending.push(file);
			else if (name.endsWith(".jsonl")) {
				assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 8388608);
				const messages = (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message").map(entry => entry.message);
				assert.ok(messages.some(message => message.role === "assistant") && messages.some(message => message.role === "toolResult")); return messages;
			}
		}
	}
	throw new Error("FULL_PROFILE_BOOTSTRAP_PI_SESSION_MISSING");
}
async function gitWorkspace(directory, workspace, beforeText) {
	await mkdir(workspace);
	const globalConfig = join(directory, "empty-git-config"), hooks = join(directory, "empty-git-hooks"); await writeFile(globalConfig, "", { flag: "wx" }); await mkdir(hooks);
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
	Object.assign(env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" });
	const git = async args => (await execute("git", ["-c", "core.hooksPath=" + hooks, "-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, env, windowsHide: true, timeout: 15000, maxBuffer: 65536 })).stdout.trim();
	await git(["init", "-b", "main"]); await writeFile(join(workspace, "fixture.txt"), beforeText, { flag: "wx" }); await git(["add", "--", "fixture.txt"]);
	await git(["-c", "user.name=CommandDeck Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic profile history"]);
	const sha = await git(["rev-parse", "HEAD"]); assert.match(sha, /^[a-f0-9]{40}$/); return sha;
}

export async function seedFullProfileHistory({ context, applicationRoot, bootstrap }) {
	const { root: directory, runId } = context;
	assert.equal((await realpath(directory)).toLowerCase(), directory.toLowerCase()); assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(directory).startsWith("commanddeck-desktop-smoke-"));
	assert.equal((await readPortableProfileCase(context)).phase, "bootstrap"); assert.equal(bootstrap.runId, runId); assert.equal(bootstrap.emptyIsolatedWorkspace, true); assert.equal(bootstrap.fullProfileBootstrap.nativeCiphertextCreated, true);
	const base = join(directory, "supervisor-profile/supervisor"), workDirectory = join(base, "m1-smoke-" + runId), gameDirectory = join(base, "game-smoke-" + runId), gameFile = join(gameDirectory, "game-tasks.sqlite");
	assert.equal((await realpath(base)).toLowerCase(), base.toLowerCase());
	const database = new DatabaseSync(gameFile, { readOnly: true });
	try { assert.equal(database.prepare("PRAGMA user_version").get().user_version, 2); for (const table of ["game_tasks", "game_intents", "game_gate", "game_task_details", "game_task_events"]) assert.equal(database.prepare("SELECT count(*) AS n FROM " + table).get().n, 0, "FULL_PROFILE_BOOTSTRAP_GAME_NOT_EMPTY"); } finally { database.close(); }
	// Retain the known-empty current fixture and its sidecars before installing
	// the independently sourced historical v1 fixture. No user database is used.
	for (const suffix of ["", "-wal", "-shm"]) {
		const file = gameFile + suffix; let info; try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT" && suffix) continue; throw error; }
		assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8388608); assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
		const retained = join(gameDirectory, "empty-before-migration" + suffix + ".retained.sqlite"); await assert.rejects(lstat(retained), { code: "ENOENT" }); await rename(file, retained);
	}
	const legacy = await seedLegacyRecovery(directory, runId);
	const { Workbench } = await import(pathToFileURL(join(applicationRoot, "apps/desktop/workbench.mjs")).href);
	const { SessionManager } = await import(pathToFileURL(join(applicationRoot, "vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js")).href);
	const messages = await messagesFromProbe(base), spec = profileFixtureSpec(runId), workspace = join(directory, "profile-workspace"), beforeText = "Original synthetic profile file " + runId + "\n", afterText = "Saved synthetic profile file " + runId + "\n";
	const sha = await gitWorkspace(directory, workspace, beforeText);
	const work = new Workbench({ directory: workDirectory, helperSource: join(applicationRoot, "artifacts/commands") });
	let expectedWorkbench;
	try {
		assert.deepEqual(work.store.roots(), []); assert.deepEqual(work.store.tasks(), []); assert.ok(work.store.ui("layout")?.panels?.["game-agent"]);
		const root = work.store.upsertRoot({ pathKey: workspace.toLowerCase(), path: workspace, label: "Synthetic migrated workspace", canWrite: false, canExecute: false, metadata: { branch: "main", sha, submodule: false, fixtureOnly: true, dirtyPaths: ["fixture.txt"], protectedPaths: [], changes: [{ path: "fixture.txt", code: " M" }] } });
		const model = messages.find(message => message.role === "assistant");
		const task = work.store.createTask({ rootId: root.id, kind: "agent", prompt: "Synthetic archived development history; no agent executed this edit.", provider: model.provider, model: model.model }); work.store.setTaskState(task.id, "running");
		const devManager = SessionManager.create(workspace, join(workDirectory, "agent", task.id, "sessions")); for (const message of messages) devManager.appendMessage(message);
		assert.ok(devManager.getSessionFile()); work.store.setSession(task.id, devManager.getSessionFile());
		const gameAgent = join(base, "game-agent-smoke-" + runId); await mkdir(gameAgent);
		const gameManager = SessionManager.create(gameAgent, join(gameAgent, "sessions")); for (const message of messages) gameManager.appendMessage(message); assert.ok(gameManager.getSessionFile());
		const changeId = work.store.prepareChange({ taskId: task.id, rootId: root.id, path: "fixture.txt", beforeText, beforeHash: profileHash(beforeText), afterText, afterHash: profileHash(afterText) });
		await writeFile(join(workspace, "fixture.txt"), afterText); work.store.finishChange(changeId, "applied");
		work.store.event(task.id, "reference", { version: 1, id: randomUUID(), taskId: task.id, rootId: root.id, path: "fixture.txt", label: "Synthetic fixed original", revision: sha, sha256: profileHash(beforeText) });
		work.store.setResponse(task.id, "Synthetic closed edit and archived Pi session."); work.store.setTaskState(task.id, "succeeded", { result: { fixtureOnly: true, executedByAgent: false } });
		const check = work.store.createTask({ rootId: root.id, kind: "check", prompt: "Synthetic retained check receipt; no command was executed." }); work.store.setTaskState(check.id, "running");
		const invocation = work.store.beginInvocation(check.id, "workspace_check", { fixtureOnly: true, checkId: "retained-only" }), result = { fixtureOnly: true, exitCode: 0, executed: false };
		work.store.finishInvocation(invocation, { result }); work.store.event(check.id, "check-result", result); work.store.setTaskState(check.id, "succeeded", { result });
		work.store.setRootGrants(root.id, { enabled: true, canWrite: false, canExecute: false });
		work.store.saveUi("selection", { rootId: root.id, taskId: task.id });
		work.store.saveUi("draft", { prompt: "Unsent full-profile draft " + runId, model: JSON.stringify([spec.id, spec.modelId]) });
		work.store.saveUi("editor", { rootId: root.id, path: "fixture.txt", sha256: profileHash(afterText), diskText: afterText, text: "Unsent editor content " + runId + "\n" });
		const state = work.state(), taskDetails = []; for (const item of state.tasks) taskDetails.push(await work.request("task", { taskId: item.id }));
		expectedWorkbench = { roots: state.roots, tasks: state.tasks, taskDetails, ui: Object.fromEntries(["layout", "selection", "draft", "editor"].map(key => [key, work.store.ui(key)])) };
	} finally { await work.close(); }
	const expected = { workbench: expectedWorkbench, vault: bootstrap.fullProfileBootstrap.vault, pi: await inventoryProfilePi(context) };
	const caseValue = { version: 1, kind: "synthetic-full-profile-migration", runId, phase: "recover", expected, sha256: profileHash(expected) };
	await rename(join(directory, portableProfileFile), join(directory, "full-profile-bootstrap.retained.json")); await writeFile(join(directory, portableProfileFile), JSON.stringify(caseValue), { flag: "wx" });
	assert.deepEqual(await readPortableProfileCase(context), caseValue);
	return { legacy, caseValue, workbenchRows: readProfileWorkbenchRows(join(workDirectory, "workbench.sqlite")), workspaceFile: join(workspace, "fixture.txt"), workspaceSha256: profileHash(afterText) };
}
