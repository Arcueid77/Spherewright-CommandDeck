import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, link, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { SessionManager } from "../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { developmentContextInfo, prepareDevelopmentContext, createDevelopmentSession } from "../apps/desktop/development-context.mjs";

async function fixture(t) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-context-"))), workbench = new Workbench({ directory, helperSource: "unused" });
	t.after(async () => { await workbench.close(); const absolute = await realpath(directory); assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(absolute).startsWith("commanddeck-context-")); await rm(absolute, { recursive: true, force: true }); });
	const root = workbench.store.upsertRoot({ path: directory, pathKey: directory, label: "synthetic", canWrite: false, canExecute: false, metadata: {} });
	const task = workbench.store.createTask({ rootId: root.id, kind: "agent", prompt: "synthetic" }); workbench.store.setTaskState(task.id, "running");
	const sessionDirectory = join(directory, "agent", task.id, "sessions"); await mkdir(sessionDirectory, { recursive: true });
	const manager = SessionManager.create(directory, sessionDirectory); manager.appendMessage({ role: "user", content: "Synthetic request", timestamp: 1 }); manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic answer" }], api: "openai-completions", provider: "synthetic", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
	const file = manager.getSessionFile(); workbench.store.setSession(task.id, file); workbench.store.setTaskState(task.id, "succeeded");
	return { directory, workbench, root, task, manager, file, original: await readFile(file) };
}

test("context preflight returns only bounded identity and counts; a continuation forks into a new owned task", async t => {
	const f = await fixture(t), info = await developmentContextInfo(f.workbench, f.root.id, f.task.id);
	assert.equal(info.messages, 2); assert.equal(info.sourceTaskId, f.task.id); assert.equal(info.canCompact, false); assert.equal(JSON.stringify(info).includes("Synthetic answer"), false); assert.equal(JSON.stringify(info).includes(f.directory.replaceAll("\\", "\\\\")), false);
	const plan = await prepareDevelopmentContext(f.workbench, f.root.id, { mode: "continue", sourceTaskId: f.task.id, sourceSha256: info.sourceSha256 });
	const child = f.workbench.store.createTask({ rootId: f.root.id, kind: "agent", parentId: f.task.id, contextPlan: plan }), childDirectory = join(f.directory, "agent", child.id); await mkdir(childDirectory);
	const fork = await createDevelopmentSession(f.workbench, child, childDirectory, SessionManager);
	assert.notEqual(fork.getSessionFile(), f.file); assert.equal(fork.buildSessionContext().messages.length, 2); assert.equal(dirname(fork.getSessionFile()), join(childDirectory, "sessions")); assert.deepEqual(await readFile(f.file), f.original);
	assert.equal(f.workbench.store.task(child.id).scope.context.sourceSha256, info.sourceSha256);
	await assert.rejects(createDevelopmentSession(f.workbench, child, childDirectory, SessionManager), { code: "EEXIST" }); assert.deepEqual(await readFile(f.file), f.original);
});

test("context selection rejects other roots, unresolved effects, stale hashes and unnecessary compaction", async t => {
	const f = await fixture(t), info = await developmentContextInfo(f.workbench, f.root.id, f.task.id), request = { mode: "continue", sourceTaskId: f.task.id, sourceSha256: info.sourceSha256 };
	await assert.rejects(prepareDevelopmentContext(f.workbench, f.root.id, { ...request, sourceSha256: "0".repeat(64) }), /SOURCE_CHANGED/);
	await assert.rejects(prepareDevelopmentContext(f.workbench, f.root.id, { ...request, mode: "compact" }), /TOO_SMALL/);
	await assert.rejects(prepareDevelopmentContext(f.workbench, f.root.id, { ...request, file: f.file }), /INVALID_DEVELOPMENT_CONTEXT_REQUEST/);
	const other = f.workbench.store.upsertRoot({ path: join(f.directory, "other"), pathKey: "other", label: "other", canWrite: false, canExecute: false, metadata: {} });
	await assert.rejects(developmentContextInfo(f.workbench, other.id, f.task.id), /SOURCE_INVALID/);
	f.workbench.store.db.prepare("INSERT INTO invocations(id,task_id,name,arguments,state,created_at) VALUES('synthetic',?,'workspace_read','{}','unknown','synthetic')").run(f.task.id);
	await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /OUTCOME_UNRESOLVED/); assert.deepEqual(await readFile(f.file), f.original);
});

test("registered source paths cannot point at outside files or hardlinks, and malformed/future transcripts remain untouched", async t => {
	const f = await fixture(t), outside = join(f.directory, "outside.jsonl"); await writeFile(outside, f.original); f.workbench.store.setSession(f.task.id, outside);
	await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /SOURCE_INVALID/); assert.deepEqual(await readFile(outside), f.original); f.workbench.store.setSession(f.task.id, f.file);
	const hardlink = join(f.directory, "retained-link.jsonl"); await link(f.file, hardlink); await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /SOURCE_INVALID/); await rm(hardlink);
	for (const text of [f.original.toString().replace('"version":3', '"version":99'), f.original.toString() + '{broken}\n', f.original.toString().replace('"cwd":', '"wrongCwd":')]) {
		await writeFile(f.file, text); await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /SOURCE_INVALID/); assert.equal(await readFile(f.file, "utf8"), text);
	}
	await writeFile(f.file, f.original);
	const sessions = join(f.directory, "agent", f.task.id, "sessions"), retained = join(f.directory, "agent", f.task.id, "sessions-retained"); assert.equal(dirname(f.file), sessions);
	await rename(sessions, retained);
	try { await symlink(retained, sessions, process.platform === "win32" ? "junction" : "dir"); await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /SOURCE_INVALID_DIRECTORY/); assert.deepEqual(await readFile(join(retained, basename(f.file))), f.original); }
	finally { await rm(sessions, { force: true }); await rename(retained, sessions); }
});

test("known Pi context edits remain loadable and a late game reservation invalidates context admission", async t => {
	const f = await fixture(t), entry = f.manager.getBranch().find(value => value.type === "message");
	f.manager.appendContextEdit(entry.id, { content: "Synthetic amended context" });
	const info = await developmentContextInfo(f.workbench, f.root.id, f.task.id); assert.equal(info.messages, 2);
	t.mock.method(f.workbench.workspace, "refresh", async () => f.root); t.mock.method(f.workbench.workspace, "protectCurrentChanges", () => {});
	const original = f.workbench.store.task.bind(f.workbench.store); t.mock.method(f.workbench.store, "task", (id, options) => { const value = original(id, options); if (options?.privateFields) f.workbench.gameWritesFrozen = false; return value; });
	let executed = 0;
	await assert.rejects(f.workbench.start({ rootId: f.root.id, kind: "agent", contextRequest: { mode: "continue", sourceTaskId: f.task.id, sourceSha256: info.sourceSha256 } }, async () => { executed++; }), /GAME_EXECUTION_OWNS_RUNTIME/);
	assert.equal(executed, 0); assert.equal(f.workbench.store.tasks().length, 1); assert.equal(f.workbench.store.activeTask(), null);
});

test("an existing profile-root alias preserves the exact owned source without allowing child redirection", async t => {
	const f = await fixture(t), alias = join(f.directory, "profile-alias"), before = await developmentContextInfo(f.workbench, f.root.id, f.task.id);
	await symlink(f.directory, alias, process.platform === "win32" ? "junction" : "dir");
	try {
		f.workbench.directory = alias; f.workbench.store.setSession(f.task.id, join(alias, "agent", f.task.id, "sessions", basename(f.file)));
		assert.deepEqual(await developmentContextInfo(f.workbench, f.root.id, f.task.id), before); assert.deepEqual(await readFile(f.file), f.original);
		f.workbench.store.setSession(f.task.id, join(alias, "outside.jsonl")); await assert.rejects(developmentContextInfo(f.workbench, f.root.id, f.task.id), /SOURCE_INVALID_PATH/);
	} finally { await rm(alias); }
});
