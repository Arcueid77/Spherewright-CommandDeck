import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devNull, tmpdir } from "node:os";
import { Workbench } from "../apps/desktop/workbench.mjs";
import { runDevelopmentAgent } from "../apps/desktop/development-agent.mjs";
import { developmentContextInfo } from "../apps/desktop/development-context.mjs";

const helperSource = fileURLToPath(new URL("../artifacts/commands", import.meta.url));
const windows = { skip: process.platform !== "win32" };
function git(cwd, ...args) { return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "user.name=CommandDeck fixture", "-c", "user.email=fixture@invalid.example", ...args], { cwd, windowsHide: true, stdio: "pipe" }); }
async function fixture(t, script = "node check.cjs") {
	const base = await mkdtemp(join(tmpdir(), "commanddeck-development-")), repo = join(base, "source"), directory = join(base, "private");
	await mkdir(repo); git(repo, "init", "-q");
	await writeFile(join(repo, "code.mjs"), "export const value = 1;\n");
	await writeFile(join(repo, "package.json"), JSON.stringify({ name: "commanddeck-fixture", private: true, scripts: { test: script } }));
	await writeFile(join(repo, "check.cjs"), "require('node:fs').appendFileSync('check-count.txt','x');console.log('CHECK_RAN');\n");
	git(repo, "add", "."); git(repo, "commit", "-qm", "fixture baseline");
	const workbench = new Workbench({ directory, helperSource });
	await workbench.add({ path: repo, label: "fixture", canWrite: true, canExecute: true });
	const rootId = workbench.state().roots[0].id;
	t.after(async () => {
		if (!workbench.closing) await workbench.close();
		const absolute = await realpath(resolve(base));
		assert.equal(dirname(absolute).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(absolute).startsWith("commanddeck-development-"));
		await rm(absolute, { recursive: true, force: true });
	});
	return { base, repo, directory, workbench, rootId };
}

test("editor tasks and check receipts persist without replay after reopening the workbench", windows, async (t) => {
	const f = await fixture(t), source = await f.workbench.request("read", { rootId: f.rootId, path: "code.mjs" });
	const edit = await f.workbench.request("save", { rootId: f.rootId, path: "code.mjs", expectedSha256: source.sha256, content: "export const value = 2;\n" });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(edit.id).state, "succeeded");
	const check = await f.workbench.request("check", { rootId: f.rootId, checkId: "npm:test" });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(check.id).state, "succeeded");
	await f.workbench.close();
	const reopened = new Workbench({ directory: f.directory, helperSource });
	try {
		const task = await reopened.request("task", { taskId: check.id });
		assert.equal(task.invocations[0].result.exitCode, 0);
		assert.equal(task.invocations[0].result.treeConfirmed, true);
		assert.ok(task.events.some((event) => event.kind === "command-output" && event.value.text.includes("CHECK_RAN")));
		assert.equal((await readFile(join(f.repo, "check-count.txt"), "utf8")), "x");
		assert.equal(reopened.state().activeTask, null);
	} finally { await reopened.close(); }
});

test("unknown command receipts freeze a reopened workbench even without a UI marker or recent task listing", async (t) => {
	const f = await fixture(t), originalTask = f.workbench.store.createTask({ rootId: f.rootId, kind: "check", prompt: "npm:test" });
	f.workbench.store.setTaskState(originalTask.id, "running");
	const invocation = f.workbench.store.beginInvocation(originalTask.id, "workspace_check", { checkId: "npm:test", helper: "synthetic-original-helper" });
	f.workbench.store.finishInvocation(invocation, { error: "COMMAND_OUTCOME_UNKNOWN", unknown: true, result: { created: true, started: true, receipt: null } });
	f.workbench.store.setTaskState(originalTask.id, "failed", { error: "COMMAND_OUTCOME_UNKNOWN", result: { outcomeUnknown: true } });
	f.workbench.store.db.prepare("UPDATE tasks SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(originalTask.id);
	const original = f.workbench.store.invocations(originalTask.id);
	for (let index = 0; index < 101; index++) {
		const later = f.workbench.store.createTask({ rootId: f.rootId, kind: "check", prompt: "blocked fixture attempt" });
		f.workbench.store.setTaskState(later.id, "running");
		f.workbench.store.setTaskState(later.id, "failed", { error: "DEVELOPMENT_EXECUTION_BLOCKED" });
	}
	assert.equal(f.workbench.store.ui("execution-blocked"), null); assert.equal(f.workbench.store.tasks().some(task => task.id === originalTask.id), false);
	await f.workbench.close();
	const reopened = new Workbench({ directory: f.directory, helperSource });
	try {
		assert.equal(reopened.state().executionBlocked, true);
		assert.equal(reopened.store.ui("execution-blocked").taskId, originalTask.id);
		assert.deepEqual(reopened.store.invocations(originalTask.id), original);
		const rejected = await reopened.request("check", { rootId: f.rootId, checkId: "npm:test" }); await reopened.operation.done;
		assert.equal(reopened.store.task(rejected.id).error, "DEVELOPMENT_EXECUTION_BLOCKED"); assert.deepEqual(reopened.store.invocations(rejected.id), []);
		await assert.rejects(readFile(join(f.repo, "check-count.txt")), { code: "ENOENT" });
	} finally { await reopened.close(); }
});

test("unknown check IDs and nonzero exits cannot become successful checks", windows, async (t) => {
	const f = await fixture(t, 'node -e "process.exit(3)"');
	const invalid = await f.workbench.request("check", { rootId: f.rootId, checkId: "arbitrary:shell" });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(invalid.id).error, "UNKNOWN_WORKSPACE_CHECK");
	const check = await f.workbench.request("check", { rootId: f.rootId, checkId: "npm:test" });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(check.id).state, "failed");
	assert.equal(f.workbench.store.invocations(check.id)[0].result.exitCode, 3);
	assert.equal(f.workbench.state().gameWriteAccess, "not_connected");
});

test("a UI check request cannot supply its own execution grant", windows, async (t) => {
	const f = await fixture(t);
	await f.workbench.request("grants", { rootId: f.rootId, canWrite: false, canExecute: false });
	const check = await f.workbench.request("check", { rootId: f.rootId, checkId: "npm:test", canExecute: true });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(check.id).error, "WORKSPACE_EXECUTION_NOT_GRANTED");
	await assert.rejects(readFile(join(f.repo, "check-count.txt")), { code: "ENOENT" });
});

test("a late clean refresh cannot remove dirty protection established by a new task", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.workspace.inspect.bind(f.workbench.workspace);
	let release, entered; const barrier = new Promise((done) => { entered = done; });
	let count = 0;
	t.mock.method(f.workbench.workspace, "inspect", async (...args) => {
		const result = await original(...args);
		if (++count === 1) { entered(); await new Promise((done) => { release = done; }); }
		return result;
	});
	const stale = f.workbench.request("refresh", { rootId: f.rootId });
	await barrier;
	await writeFile(join(f.repo, "code.mjs"), "existing user edit\n");
	let finish;
	const task = await f.workbench.start({ rootId: f.rootId, kind: "agent" }, () => new Promise((done) => { finish = done; }));
	release(); await stale;
	const current = f.workbench.store.root(f.rootId), source = await f.workbench.workspace.read(f.rootId, "code.mjs");
	assert.ok(current.metadata.protectedPaths.includes("code.mjs"));
	await assert.rejects(f.workbench.workspace.write({ rootId: f.rootId, taskId: task.id, path: "code.mjs", expectedSha256: source.sha256, content: "overwrite" }), /EXISTING_USER_CHANGE_PROTECTED/);
	finish({}); await f.workbench.operation.done;
});

test("a grant change that finishes after task admission cannot mutate running-task permissions", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.workspace.refresh.bind(f.workbench.workspace);
	let release, entered, finish; const barrier = new Promise((done) => { entered = done; }); let count = 0;
	t.mock.method(f.workbench.workspace, "refresh", async (...args) => { const value = await original(...args); if (++count === 1) { entered(); await new Promise((done) => { release = done; }); } return value; });
	const grant = f.workbench.request("grants", { rootId: f.rootId, canWrite: false, canExecute: false });
	const rejected = assert.rejects(grant, /DEVELOPMENT_TASK_ALREADY_RUNNING/);
	await barrier;
	await f.workbench.start({ rootId: f.rootId, kind: "agent" }, () => new Promise((done) => { finish = done; }));
	release(); await rejected;
	assert.equal(f.workbench.store.root(f.rootId).canExecute, true);
	finish({}); await f.workbench.operation.done;
});

test("a revoked grant is checked again immediately before a command is created", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.command.bind(f.workbench);
	t.mock.method(f.workbench, "command", async (...args) => { const value = await original(...args); f.workbench.store.setRootGrants(f.rootId, { canWrite: true, canExecute: false }); return value; });
	const check = await f.workbench.request("check", { rootId: f.rootId, checkId: "npm:test" });
	await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(check.id).error, "WORKSPACE_EXECUTION_NOT_GRANTED");
	assert.equal(f.workbench.store.invocations(check.id).length, 0);
	await assert.rejects(readFile(join(f.repo, "check-count.txt")), { code: "ENOENT" });
});

test("drain invalidates pending admission even if a failed close later reopens the workbench", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.workspace.refresh.bind(f.workbench.workspace);
	let release, entered, calls = 0; const barrier = new Promise((done) => { entered = done; });
	t.mock.method(f.workbench.workspace, "refresh", async (...args) => { const value = await original(...args); entered(); await new Promise((done) => { release = done; }); return value; });
	const pending = f.workbench.start({ rootId: f.rootId, kind: "agent" }, async () => { calls++; });
	const rejected = assert.rejects(pending, /WORKBENCH_ADMISSION_EXPIRED/);
	await barrier; await f.workbench.drain();
	f.workbench.closing = false;
	release(); await rejected;
	assert.equal(calls, 0); assert.equal(f.workbench.store.activeTask(), null);
});

test("an in-flight admission cannot pass a newly established unknown-execution gate", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.workspace.refresh.bind(f.workbench.workspace);
	let release, entered, calls = 0, reads = 0; const barrier = new Promise((done) => { entered = done; });
	t.mock.method(f.workbench.workspace, "refresh", async (...args) => { const value = await original(...args); if (++reads === 1) { entered(); await new Promise((done) => { release = done; }); } return value; });
	const pending = f.workbench.start({ rootId: f.rootId, kind: "agent" }, async () => { calls++; });
	const rejected = assert.rejects(pending, /DEVELOPMENT_EXECUTION_BLOCKED/);
	await barrier;
	const other = await f.workbench.start({ rootId: f.rootId, kind: "check" }, async (task) => {
		f.workbench.store.saveUi("execution-blocked", { reason: "SYNTHETIC_COMMAND_OUTCOME_UNKNOWN", taskId: task.id });
		const error = new Error("SYNTHETIC_COMMAND_OUTCOME_UNKNOWN"); error.unknown = true; throw error;
	});
	await f.workbench.operation.done; assert.equal(f.workbench.store.task(other.id).state, "failed");
	release(); await rejected;
	assert.equal(calls, 0); assert.equal(f.workbench.store.activeTask(), null);
});

test("game reservation blocks every development task and rejects an admission already awaiting refresh", windows, async (t) => {
	const f = await fixture(t), original = f.workbench.workspace.refresh.bind(f.workbench.workspace);
	let enter, release, effects = 0; const entered = new Promise((done) => { enter = done; });
	t.mock.method(f.workbench.workspace, "refresh", async (...args) => { const value = await original(...args); enter(); await new Promise((done) => { release = done; }); return value; });
	const admission = f.workbench.start({ rootId: f.rootId, kind: "edit" }, async () => { effects++; });
	const refused = assert.rejects(admission, /WORKBENCH_ADMISSION_EXPIRED|GAME_EXECUTION_OWNS_RUNTIME/); await entered;
	f.workbench.gameWritesFrozen = false; f.workbench.admissionGeneration++; release(); await refused;
	for (const kind of ["agent", "check", "edit", "revert"]) await assert.rejects(f.workbench.start({ rootId: f.rootId, kind }, async () => { effects++; }), /GAME_EXECUTION_OWNS_RUNTIME/);
	assert.equal(effects, 0); assert.equal(f.workbench.state().executionBlocked, true);
});

test("file reverts retain history and refuse to discard later external changes", windows, async (t) => {
	const f = await fixture(t), before = await f.workbench.workspace.read(f.rootId, "code.mjs");
	const edit = await f.workbench.request("save", { rootId: f.rootId, path: "code.mjs", expectedSha256: before.sha256, content: "edited\r\n" }); await f.workbench.operation.done;
	const change = f.workbench.store.changes(edit.id)[0];
	const undo = await f.workbench.request("revert", { sourceTaskId: edit.id, changeId: change.id }); await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(undo.id).state, "succeeded");
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), before.fullText);
	assert.equal((await f.workbench.workspace.read(f.rootId, "code.mjs")).sha256, before.sha256);
	const created = await f.workbench.request("save", { rootId: f.rootId, path: "created.txt", expectedSha256: null, content: "created\n" }); await f.workbench.operation.done;
	const createdChange = f.workbench.store.changes(created.id)[0];
	await f.workbench.request("revert", { sourceTaskId: created.id, changeId: createdChange.id }); await f.workbench.operation.done;
	await assert.rejects(readFile(join(f.repo, "created.txt")), { code: "ENOENT" });
	const second = await f.workbench.request("save", { rootId: f.rootId, path: "code.mjs", expectedSha256: before.sha256, content: "second\n" }); await f.workbench.operation.done;
	await writeFile(join(f.repo, "code.mjs"), "later external edit\n");
	const rejected = await f.workbench.request("revert", { sourceTaskId: second.id, changeId: f.workbench.store.changes(second.id)[0].id }); await f.workbench.operation.done;
	assert.equal(f.workbench.store.task(rejected.id).error, "STALE_FILE_CONTENT");
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), "later external edit\n");
});

test("the pinned Pi rejects injected scope and completes a bounded read/edit/check task", windows, async (t) => {
	const f = await fixture(t); let requests = 0, tools;
	const endpoint = createServer(async (request, response) => {
		let body = ""; for await (const part of request) body += part;
		const data = JSON.parse(body); requests++; tools = data.tools.map((tool) => tool.function.name);
		let tool, args;
		if (requests === 1) { tool = "workspace_edit"; args = { path: "code.mjs", expectedSha256: "0".repeat(64), oldText: "value = 1", newText: "value = 2", actor: "user", rootId: "forged-root", taskId: "forged-task" }; }
		if (requests === 2) { tool = "workspace_read"; args = { path: "code.mjs" }; }
		if (requests === 3) {
			const prior = JSON.parse(data.messages.filter((message) => message.role === "tool").at(-1).content);
			tool = "workspace_edit"; args = { path: "code.mjs", expectedSha256: prior.sha256, oldText: "value = 1", newText: "value = 2" };
		}
		if (requests === 4) { tool = "workspace_check"; args = { checkId: "npm:test" }; }
		const delta = tool ? { tool_calls: [{ index: 0, id: `fixture-${requests}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: "Changed the fixture and verified the named check." };
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
		response.write(`data: ${JSON.stringify({ id: "fixture", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 7 } } })}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((done) => endpoint.listen(0, "127.0.0.1", done));
	t.after(() => { endpoint.closeAllConnections(); endpoint.close(); });
	const modelsPath = join(f.base, "models.json");
	await writeFile(modelsPath, JSON.stringify({ providers: { "commanddeck-fixture": { baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, api: "openai-completions", apiKey: "synthetic", models: [{ id: "fixture", contextWindow: 16384, maxTokens: 2048, cost: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 } }] } } }));
	const task = await f.workbench.start({ rootId: f.rootId, kind: "agent", provider: "commanddeck-fixture", model: "fixture", prompt: "Change the fixture value to 2 and run the test." }, (task, signal) => runDevelopmentAgent({ workbench: f.workbench, task, signal, testModelsPath: modelsPath }));
	await f.workbench.operation.done;
	const result = await f.workbench.request("task", { taskId: task.id });
	assert.equal(result.state, "succeeded", result.error);
	assert.equal(requests, 5); assert.equal(result.result.gameCalls, 0);
	assert.equal(result.result.toolCalls, 3);
	assert.equal(result.invocations.filter((entry) => entry.name === "workspace_edit").length, 1);
	assert.equal(result.result.changedFiles.length, 1); assert.equal(result.result.cost, "unknown");
	assert.deepEqual(result.usage.tokens, { input: 450, output: 100, cacheRead: 50, cacheWrite: 0, totalTokens: 600, reasoning: 35 });
	assert.equal(result.usage.reportedResponses, 5); assert.equal(result.usage.estimate.status, "estimated"); assert.ok(Math.abs(result.usage.estimate.usd - 0.001925) < 1e-12);
	assert.deepEqual(result.usage, result.result.usage);
	assert.ok(tools.includes("workspace_edit") && tools.includes("workspace_check"));
	assert.ok(tools.every((name) => name.startsWith("workspace_")));
	assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), "export const value = 2;\n");
	assert.equal(await readFile(join(f.repo, "check-count.txt"), "utf8"), "x");
	assert.equal(result.invocations.find((entry) => entry.name === "workspace_check" && entry.result?.exitCode === 0).state, "completed");
	// Latest accounting is independent of the 500-row transcript page and final result.
	for (let i = 0; i < 505; i++) f.workbench.store.event(task.id, "assistant-text", { text: "bounded synthetic text" });
	await f.workbench.close();
	const reopened = new Workbench({ directory: f.directory, helperSource });
	try { assert.deepEqual((await reopened.request("task", { taskId: task.id, after: 999999 })).usage, result.usage); assert.deepEqual(reopened.store.invocations(task.id), result.invocations); }
	finally { await reopened.close(); }
});

test("Pi continuation and compaction fork original history, renew grants and stop on failed or cancelled summaries", { ...windows, timeout: 60000 }, async t => {
	const f = await fixture(t), calls = [], errors = []; let summaryMode = "normal", releaseSummary, summaryEntered;
	const server = createServer(async (request, response) => {
		try {
			let body = ""; for await (const part of request) body += part; const data = JSON.parse(body), encoded = JSON.stringify(data.messages), tools = (data.tools ?? []).map(tool => tool.function.name); calls.push({ tools, summary: !tools.length });
			let delta, input = 4000;
			if (!tools.length) {
				assert.ok(encoded.includes("CONTEXT_SEED_MARKER")); input = 5000;
				if (summaryMode === "fail") { response.writeHead(503); response.end("Synthetic summary failure"); return; }
				if (summaryMode === "hold") { summaryEntered(); await new Promise(resolve => { releaseSummary = resolve; }); if (response.destroyed) return; }
				delta = { content: "HISTORICAL_CONTEXT_SUMMARY: seed completed, follow-up answered. Inspect current files and permissions before new work." };
			} else if (encoded.includes("CONTEXT_AFTER_COMPACT")) {
				assert.deepEqual(tools.sort(), ["workspace_diff", "workspace_list", "workspace_read", "workspace_search"]); assert.ok(encoded.includes("HISTORICAL_CONTEXT_SUMMARY")); input = 400;
				delta = data.messages.some(message => message.role === "tool" && message.tool_call_id === "fresh-context-read") ? { content: "CONTEXT_COMPACT_DONE" } : { tool_calls: [{ index: 0, id: "fresh-context-read", type: "function", function: { name: "workspace_read", arguments: JSON.stringify({ path: "code.mjs" }) } }] };
			} else if (encoded.includes("CONTEXT_CONTINUE")) { assert.ok(encoded.includes("CONTEXT_SEED_DONE")); assert.ok(!tools.includes("workspace_edit")); input = 5000; delta = { content: "CONTEXT_CONTINUE_DONE" }; }
			else { assert.ok(encoded.includes("CONTEXT_SEED_MARKER")); assert.ok(tools.includes("workspace_edit")); delta = { content: "CONTEXT_SEED_DONE" }; }
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const choice of [{ delta: { role: "assistant", ...delta } }, { delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }]) response.write(`data: ${JSON.stringify({ id: "synthetic-context", model: "fixture", choices: [{ index: 0, ...choice }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "synthetic-context", choices: [], usage: { prompt_tokens: input, completion_tokens: 20 } })}\n\n`); response.end("data: [DONE]\n\n");
		} catch (error) { errors.push(error); response.writeHead(500); response.end("Synthetic fixture assertion failed"); }
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { releaseSummary?.(); server.closeAllConnections(); server.close(); });
	const modelsPath = join(f.base, "context-models.json"); await writeFile(modelsPath, JSON.stringify({ providers: { "commanddeck-fixture": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "synthetic", models: [{ id: "fixture", contextWindow: 32768, maxTokens: 2048, cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 } }] } } }));
	async function start(prompt, contextRequest) { return f.workbench.start({ rootId: f.rootId, kind: "agent", prompt, provider: "commanddeck-fixture", model: "fixture", contextRequest }, (task, signal) => runDevelopmentAgent({ workbench: f.workbench, task, signal, testModelsPath: modelsPath })); }
	async function finish(task) { await f.workbench.operation.done; return f.workbench.request("task", { taskId: task.id }); }
	const seed = await finish(await start("CONTEXT_SEED_MARKER " + "Historical synthetic detail. ".repeat(450))); assert.equal(seed.state, "succeeded", seed.error);
	const seedFile = f.workbench.store.task(seed.id, { privateFields: true }).sessionFile, seedBytes = await readFile(seedFile), info = await developmentContextInfo(f.workbench, f.rootId, seed.id);
	await f.workbench.request("grants", { rootId: f.rootId, canWrite: false, canExecute: false });
	const continued = await finish(await start("CONTEXT_CONTINUE " + "Recent synthetic detail. ".repeat(450), { mode: "continue", sourceTaskId: seed.id, sourceSha256: info.sourceSha256 }));
	assert.equal(continued.state, "succeeded", continued.error); assert.equal(continued.parentId, seed.id); assert.equal(continued.response, "CONTEXT_CONTINUE_DONE"); assert.equal(continued.result.contextManagement.compacted, false); assert.equal(continued.invocations.length, 0);
	const continuedFile = f.workbench.store.task(continued.id, { privateFields: true }).sessionFile, continuedBytes = await readFile(continuedFile), next = await developmentContextInfo(f.workbench, f.rootId, continued.id); assert.equal(next.canCompact, true);
	const contextRequest = { mode: "compact", sourceTaskId: continued.id, sourceSha256: next.sourceSha256 }, compacted = await finish(await start("CONTEXT_AFTER_COMPACT", contextRequest));
	assert.equal(compacted.state, "succeeded", compacted.error); assert.equal(compacted.parentId, continued.id); assert.equal(compacted.response, "CONTEXT_COMPACT_DONE"); assert.equal(compacted.result.contextManagement.compacted, true); assert.ok(compacted.result.contextManagement.estimatedTokensAfter < compacted.result.contextManagement.tokensBefore);
	const summaryCalls = compacted.result.contextManagement.compactionRequests; assert.ok(summaryCalls >= 1 && summaryCalls <= 2); assert.equal(compacted.usage.requests, summaryCalls + 2); assert.equal(compacted.usage.reportedResponses, summaryCalls + 2); assert.equal(compacted.invocations.length, 1); assert.equal(compacted.invocations[0].name, "workspace_read"); assert.equal(compacted.result.toolCalls, 1);
	summaryMode = "fail"; const beforeFail = calls.length, failed = await finish(await start("MUST_NOT_RUN_AFTER_FAILED_SUMMARY", contextRequest));
	assert.equal(failed.state, "failed"); assert.equal(failed.error, "DEVELOPMENT_CONTEXT_COMPACTION_FAILED"); assert.equal(calls.length, beforeFail + 1); assert.deepEqual(failed.invocations, []); assert.equal(failed.usage.requests, 1);
	summaryMode = "hold"; const entered = new Promise(resolve => { summaryEntered = resolve; }), cancelled = await start("MUST_NOT_RUN_AFTER_CANCELLED_SUMMARY", contextRequest); await entered;
	await f.workbench.request("cancel", { taskId: cancelled.id }); releaseSummary?.(); const stopped = await finish(cancelled); assert.equal(stopped.state, "cancelled"); assert.deepEqual(stopped.invocations, []); assert.equal(stopped.usage.requests, 1);
	assert.deepEqual(await readFile(seedFile), seedBytes); assert.deepEqual(await readFile(continuedFile), continuedBytes); assert.deepEqual(await f.workbench.request("task", { taskId: seed.id }), seed); assert.deepEqual(await f.workbench.request("task", { taskId: continued.id }), continued);
	assert.deepEqual(errors, []); assert.equal(await readFile(join(f.repo, "code.mjs"), "utf8"), "export const value = 1;\n"); await assert.rejects(readFile(join(f.repo, "check-count.txt")), { code: "ENOENT" });
});
