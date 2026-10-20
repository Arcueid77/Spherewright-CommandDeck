import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { devNull, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { WorkbenchStore } from "../apps/desktop/workbench-store.mjs";
import { WorkspaceService } from "../apps/desktop/workspace.mjs";

function git(cwd, ...args) {
	return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", `core.attributesFile=${devNull}`, "-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", ...args], { cwd, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
async function fixture(t) {
	const base = await mkdtemp(join(tmpdir(), "commanddeck-workspace-"));
	const repo = join(base, "source"), outside = join(base, "outside");
	await mkdir(repo); await mkdir(outside);
	git(repo, "init", "-q");
	await writeFile(join(repo, "code.mjs"), "export const value = 1;\n");
	await writeFile(join(repo, ".gitignore"), ".local/\n");
	git(repo, "add", "."); git(repo, "commit", "-qm", "fixture baseline");
	const database = join(base, "workbench.sqlite"), store = new WorkbenchStore(database), workspace = new WorkspaceService(store);
	t.after(async () => {
		try { store.close(); } catch {}
		const absolute = resolve(base), temporary = await realpath(tmpdir());
		assert.equal(dirname(await realpath(absolute)).toLowerCase(), temporary.toLowerCase());
		assert.ok(basename(absolute).startsWith("commanddeck-workspace-"));
		await rm(absolute, { recursive: true, force: true });
	});
	return { base, repo, outside, database, store, workspace };
}
async function running(store, rootId, kind = "agent") {
	const task = store.createTask({ rootId, kind, prompt: "bounded fixture edit" });
	store.setTaskState(task.id, "running");
	return task;
}

test("workspace roots, grants, private session reference and UI draft survive reopen", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true, canExecute: false });
	const task = await running(f.store, root.id);
	f.store.setSession(task.id, join(f.base, "sessions", "private.jsonl"));
	f.store.setTaskState(task.id, "succeeded", { result: { checked: true } });
	f.store.saveUi("draft", { rootId: root.id, text: "draft preserved" });
	f.store.close();
	const reopened = new WorkbenchStore(f.database);
	try {
		assert.equal(reopened.roots()[0].id, root.id);
		assert.equal(reopened.root(root.id).canExecute, false);
		assert.equal(reopened.task(task.id).sessionFile, undefined);
		assert.match(reopened.task(task.id, { privateFields: true }).sessionFile, /private\.jsonl$/);
		assert.equal(reopened.ui("draft").text, "draft preserved");
		assert.equal(reopened.activeTask(), null);
	} finally { reopened.close(); }
});

test("restart marks unfinished effects unknown and never silently resumes a task", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id);
	f.store.beginInvocation(task.id, "workspace_edit", { path: "code.mjs" });
	f.store.prepareChange({ taskId: task.id, rootId: root.id, path: "code.mjs", beforeText: "before", beforeHash: "a", afterText: "after", afterHash: "b" });
	assert.equal(f.store.recoverInterrupted(), 1);
	assert.equal(f.store.task(task.id).state, "interrupted");
	assert.equal(f.store.invocations(task.id)[0].state, "unknown");
	assert.equal(f.store.changes(task.id)[0].state, "unknown");
	assert.equal(f.store.recoverInterrupted(), 0);
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), "export const value = 1;\n");
});

test("future SQLite schemas are refused without resetting their contents", async (t) => {
	const f = await fixture(t), future = join(f.base, "future.sqlite");
	const database = new DatabaseSync(future);
	database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('keep'); PRAGMA user_version=99;");
	database.close();
	const before = await readFile(future);
	assert.throws(() => new WorkbenchStore(future), /WORKBENCH_SCHEMA_TOO_NEW/);
	assert.deepEqual(await readFile(future), before);
});

test("workspace editing uses current content hashes and preserves durable before images", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	const edited = await f.workspace.replace({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, oldText: "value = 1", newText: "value = 2" });
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), "export const value = 2;\n");
	assert.equal(f.store.changes(task.id)[0].state, "applied");
	assert.equal(f.store.changes(task.id)[0].beforeText, source.fullText);
	assert.equal(f.store.changes(task.id)[0].afterHash, edited.sha256);
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "stale overwrite" }), /STALE_FILE_CONTENT/);
	assert.match((await f.workspace.diff(root.id, "code.mjs")).text, /value = 2/);
});

test("existing user changes are protected from agent edits while explicit editor saves retain hash checks", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repo, "code.mjs"), "export const value = 99;\n");
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	assert.equal(source.protected, true);
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "agent overwrite" }), /EXISTING_USER_CHANGE_PROTECTED/);
	await f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "explicit user edit\n", actor: "user" });
	assert.equal(f.store.changes(task.id)[0].beforeText, "export const value = 99;\n");
});

test("paths cannot escape roots, follow junctions, read private files or cross nested repositories", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.outside, "private.txt"), "outside data");
	await symlink(f.outside, join(f.repo, "linked"), process.platform === "win32" ? "junction" : "dir");
	const nested = join(f.repo, "nested"); await mkdir(nested); git(nested, "init", "-q");
	await writeFile(join(nested, "inside.txt"), "nested data"); git(nested, "add", "."); git(nested, "commit", "-qm", "nested baseline");
	await writeFile(join(f.repo, ".env"), "fixture credential");
	await writeFile(join(f.repo, "untracked.txt"), "unapproved existing file");
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	await assert.rejects(f.workspace.read(root.id, "../outside/private.txt"), /INVALID_WORKSPACE_PATH/);
	await assert.rejects(f.workspace.read(root.id, "linked/private.txt"), /WORKSPACE_LINK_OR_PATH_ESCAPE/);
	await assert.rejects(f.workspace.read(root.id, ".env"), /PRIVATE_WORKSPACE_PATH/);
	await assert.rejects(f.workspace.read(root.id, "nested/inside.txt"), /NESTED_REPOSITORY_REQUIRES_OWN_ROOT/);
	await assert.rejects(f.workspace.read(root.id, "untracked.txt"), /UNTRACKED_FILE_NOT_APPROVED/);
});

test("read-only grants and task root identity are enforced on every write", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: false });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "denied" }), /WORKSPACE_WRITE_NOT_GRANTED/);
	f.store.setTaskState(task.id, "cancelled");
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "after cancellation" }), /WORKSPACE_TASK_SCOPE_MISMATCH/);
});

test("new source files require absence and become readable through their own edit receipts", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id);
	await f.workspace.write({ taskId: task.id, rootId: root.id, path: "new/module.mjs", expectedSha256: null, content: "export const added = true;\n" });
	assert.equal((await f.workspace.read(root.id, "new/module.mjs")).text, "export const added = true;\n");
	assert.equal(f.store.changes(task.id)[0].beforeText, null);
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "new/module.mjs", expectedSha256: null, content: "replace existing" }), /FILE_ALREADY_EXISTS/);
});

test("Git metadata and diff reads never run configured clean filters", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repo, ".gitattributes"), "code.mjs filter=poison\n");
	const executable = process.execPath.replaceAll("\\", "/");
	git(f.repo, "config", "filter.poison.clean", `"${executable}" -e "require('node:fs').writeFileSync('FILTER_RAN','bad')"`);
	await writeFile(join(f.repo, "code.mjs"), "export const value = 7;\n");
	const root = await f.workspace.register({ path: f.repo, label: "source" });
	assert.ok(root.metadata.changes.some((change) => change.path === "code.mjs"));
	assert.match((await f.workspace.diff(root.id, "code.mjs")).text, /value = 7/);
	await assert.rejects(readFile(join(f.repo, "FILTER_RAN")), { code: "ENOENT" });
});

test("applicable untracked AGENTS rules are loaded as rules without granting other untracked reads", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repo, "AGENTS.md"), "Preserve the current scope.\n");
	const root = await f.workspace.register({ path: f.repo, label: "source" });
	const rules = await f.workspace.rules(root.id, "code.mjs");
	assert.equal(rules.length, 1);
	assert.equal(rules[0].content, "Preserve the current scope.\n");
	assert.match(rules[0].sha256, /^[0-9a-f]{64}$/);
});

test("a task cannot write after an external branch switch even when file contents still match", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	git(f.repo, "checkout", "-qb", "dev/other-work");
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "wrong branch" }), /WORKSPACE_REVISION_CHANGED/);
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), source.fullText);
});

test("registered nested repositories retain their independent task and permission identity", async (t) => {
	const f = await fixture(t), nested = join(f.repo, "nested");
	await mkdir(nested); git(nested, "init", "-q");
	await writeFile(join(nested, "code.mjs"), "nested source\n"); git(nested, "add", "."); git(nested, "commit", "-qm", "nested baseline");
	const outer = await f.workspace.register({ path: f.repo, label: "outer", canWrite: true });
	const inner = await f.workspace.register({ path: nested, label: "inner", canWrite: true });
	const task = await running(f.store, outer.id), source = await f.workspace.read(inner.id, "code.mjs");
	assert.throws(() => f.store.createTask({ rootId: inner.id, kind: "agent" }), /DEVELOPMENT_TASK_ALREADY_RUNNING/);
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: inner.id, path: "code.mjs", expectedSha256: source.sha256, content: "cross root" }), /WORKSPACE_TASK_SCOPE_MISMATCH/);
});

test("permission revocation applies to an already running task", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	f.store.setRootGrants(root.id, { canWrite: false, canExecute: false });
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: "revoked" }), /WORKSPACE_WRITE_NOT_GRANTED/);
});

test("a pinned product submodule stays read-only even when registration requests writes", async (t) => {
	const f = await fixture(t);
	git(f.outside, "init", "-q");
	await writeFile(join(f.outside, "product.mjs"), "export const product = true;\n");
	git(f.outside, "add", "."); git(f.outside, "commit", "-qm", "product baseline");
	git(f.repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", f.outside, "deps/Spherewright");
	const root = await f.workspace.register({ path: join(f.repo, "deps/Spherewright"), label: "pinned product", canWrite: true, canExecute: true });
	assert.equal(root.metadata.submodule, true);
	assert.equal(root.canWrite, false); assert.equal(root.canExecute, false);
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "product.mjs");
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: "product.mjs", expectedSha256: source.sha256, content: "overwrite dependency" }), /WORKSPACE_WRITE_NOT_GRANTED/);
});

test("concurrent edits using the same expected hash cannot overwrite each other", async (t) => {
	const f = await fixture(t);
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, "code.mjs");
	const results = await Promise.allSettled([2, 3].map((value) => f.workspace.write({ taskId: task.id, rootId: root.id, path: "code.mjs", expectedSha256: source.sha256, content: `export const value = ${value};\n` })));
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.match(results.find((result) => result.status === "rejected").reason.message, /STALE_FILE_CONTENT/);
	assert.equal(f.store.changes(task.id).filter((change) => change.state === "applied").length, 1);
});

test("initial dirty protection is complete when status presentation is truncated", async (t) => {
	const f = await fixture(t), names = Array.from({ length: 1002 }, (_, index) => `tracked-${String(index).padStart(4, "0")}.txt`);
	await Promise.all(names.map((name) => writeFile(join(f.repo, name), "baseline\n")));
	git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "large fixture baseline");
	await Promise.all(names.map((name) => writeFile(join(f.repo, name), "existing user change\n")));
	const root = await f.workspace.register({ path: f.repo, label: "source", canWrite: true });
	assert.equal(root.metadata.changes.length, 1000);
	assert.equal(root.metadata.changesTruncated, true);
	assert.equal(root.metadata.protectedPaths.length, names.length);
	const refreshed = await f.workspace.refresh(root.id), last = names.at(-1);
	assert.ok(refreshed.metadata.protectedPaths.includes(last));
	const task = await running(f.store, root.id), source = await f.workspace.read(root.id, last);
	await assert.rejects(f.workspace.write({ taskId: task.id, rootId: root.id, path: last, expectedSha256: source.sha256, content: "overwrite" }), /EXISTING_USER_CHANGE_PROTECTED/);
});

test("repository-local Git executables are never selected during read-only inspection", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repo, "git.exe"), "This fixture must never be executed.\n");
	await writeFile(join(f.repo, "git.com"), "This fixture must never be executed.\n");
	const root = await f.workspace.register({ path: f.repo, label: "source", canExecute: false });
	assert.equal(root.canExecute, false);
	assert.match(root.metadata.sha, /^[a-f0-9]{40,64}$/);
	assert.equal((await f.workspace.read(root.id, "code.mjs")).text, "export const value = 1;\n");
});

test("diff paths are literal and cannot glob into protected files", async (t) => {
	const f = await fixture(t);
	await writeFile(join(f.repo, "[s]ecrets.json"), "public baseline\n");
	await writeFile(join(f.repo, "secrets.json"), "fixture private baseline\n");
	git(f.repo, "add", "."); git(f.repo, "commit", "-qm", "literal path fixture");
	await writeFile(join(f.repo, "[s]ecrets.json"), "public changed\n");
	await writeFile(join(f.repo, "secrets.json"), "PRIVATE_FIXTURE_MUST_NOT_APPEAR\n");
	const root = await f.workspace.register({ path: f.repo, label: "source" });
	const diff = await f.workspace.diff(root.id, "[s]ecrets.json");
	assert.match(diff.text, /public changed/);
	assert.doesNotMatch(diff.text, /PRIVATE_FIXTURE|private baseline/);
	await assert.rejects(f.workspace.diff(root.id, "secrets.json"), /PRIVATE_WORKSPACE_PATH/);
});
