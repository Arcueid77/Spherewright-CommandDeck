import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DiagnosticExports, writeNewDiagnostic } from "../apps/desktop/diagnostic-export.mjs";
import { buildDiagnosticReport, captureWorkbenchDiagnostics, diagnosticLimits, diagnosticOptions } from "../apps/desktop/diagnostic-snapshot.mjs";
import { WorkbenchStore } from "../apps/desktop/workbench-store.mjs";
import { assertDiagnosticSmokeAction, sourceDiagnosticMode } from "../apps/desktop/diagnostic-smoke-scope.mjs";
import { portableDiagnosticMode } from "../apps/desktop/portable-mode.mjs";

const secret = "PRIVATE_DIAGNOSTIC_CANARY_8F2A";
const at = "2026-10-23T05:30:00.000Z";
const build = { packaged: true, applicationVersion: "0.0.1", sourceRevision: "a".repeat(40), piCommit: "b".repeat(40), electronVersion: "44.9.0", nodeVersion: "24.0.0", platform: "win32", architecture: "x64", path: secret };
const input = () => ({ build, runtime: { available: true, exitObserved: false, probeBusy: false, uiConnected: true, uiRecovering: false, uiReplacements: 0, command: secret },
	workbench: { version: 1, schemaVersion: 1, rootCount: 1, taskCount: 1, active: false, executionBlocked: true, configurationBlocked: false, path: secret, tasks: [{ kind: "check", state: "failed", error: "CHECK_DID_NOT_PASS", createdAt: at, startedAt: at, finishedAt: at, prompt: secret, response: secret, sessionFile: secret, eventCount: 2, invocationCount: 1, events: [{ sequence: 2, kind: "command-output", at, text: secret, code: secret }, { sequence: 1, kind: "task", at, state: "running" }], invocations: [{ name: "workspace_check", state: "failed", error: "CHECK_DID_NOT_PASS", createdAt: at, finishedAt: at, exitCode: 2, treeConfirmed: true, streamsDrained: true, stdout: secret, arguments: { key: secret } }] }] },
	game: { phase: "blocked", runtimeAvailable: true, busy: false, developmentFrozen: true, nativeInputExclusion: false, error: "COMMIT_RECEIPT_UNAVAILABLE", tasks: [{ id: secret, state: "blocked", scope: { sessionId: secret }, details: { prompt: secret }, intent: { state: "unknown", idempotencyKey: secret, actionId: null, acceptance: null, terminal: null } }], unresolved: [{ key: secret }], events: [{ sequence: 1, kind: "assistant", at: Date.parse(at), text: secret }, { sequence: 2, kind: "stage", at: Date.parse(at), text: "planning" }] },
	bridge: { busy: false, error: null, selected: { path: secret }, metadata: { protocolVersion: "2025-06-18", serverVersion: "0.4.0.0", toolCount: 64, resourceCount: 1, researchAvailable: true, secret }, observation: { connected: false, session: { data: { saveName: secret, restartResumeToken: secret } } }, requestPerformance: { version: 1, started: 7, responses: 6, rpcErrors: 0, aborted: 1, pending: 0, peakPending: 1, durationMs: { meanMs: 3, p95Ms: 5, maxMs: 5 }, lifetime: { state: "exit_observed", basis: "launch_request", durationMs: 123, endedAgeMs: 7 }, payload: secret } },
});
async function directory(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-diagnostic-test-")));
	t.after(async () => { const path = await realpath(root); assert.equal(path, root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith("commanddeck-diagnostic-test-")); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root;
}
function manager(extra = {}) {
	const owner = {}, current = { owner, generation: 1 }, clock = { value: 10 };
	const exports = new DiagnosticExports({ capture: async () => input(), isCurrent: (value, generation) => value === current.owner && generation === current.generation, now: () => clock.value, wallNow: () => Date.parse(at), ...extra });
	return { exports, owner, current, clock };
}

test("diagnostic snapshots retain structured failures and metrics while omitting identities, paths and free text", () => {
	const report = buildDiagnosticReport(input(), {}, { reportId: "public-report", generatedAt: at }), text = JSON.stringify(report);
	assert.ok(!text.includes(secret)); assert.equal(report.game.pendingCount, 1); assert.equal(report.game.tasks[0].intent.hasActionId, false); assert.equal(report.game.events[1].stage, "planning"); assert.equal(report.workbench.tasks[0].code, "CHECK_DID_NOT_PASS"); assert.equal(report.workbench.tasks[0].invocations[0].exitCode, 2); assert.equal(report.workbench.tasks[0].events[0].code, "UNRECOGNIZED_ERROR_CODE");
	assert.equal(report.bridge.rpc.responses, 6); assert.equal(report.bridge.rpc.aborted, 1); assert.equal(report.bridge.rpc.durationMs.p95Ms, 5); assert.equal(report.build.installationVerified, false);
	assert.ok(!("path" in report)); assert.ok(!("idempotencyKey" in report.game.tasks[0].intent));
});

test("omitted and unavailable diagnostic sections stay distinct from empty or zero measurements", () => {
	const missing = buildDiagnosticReport({ build, workbench: { unavailableCode: "RUNTIME_UNAVAILABLE" }, game: { unavailableCode: secret }, bridge: { unavailableCode: secret } }, {}, { reportId: "r", generatedAt: at });
	assert.equal(missing.workbench.state, "unavailable"); assert.equal(missing.workbench.code, "RUNTIME_UNAVAILABLE"); assert.equal(missing.game.state, "unavailable"); assert.equal(missing.bridge.code, "UNRECOGNIZED_ERROR_CODE"); assert.ok(!JSON.stringify(missing).includes(secret));
	const omitted = buildDiagnosticReport(input(), { includeTasks: false, includePerformance: false }, { reportId: "r", generatedAt: at }); assert.equal(omitted.game.state, "omitted"); assert.equal(omitted.workbench.state, "omitted"); assert.equal(omitted.bridge.rpc.state, "omitted");
	for (const options of [{ path: "arbitrary.json" }, { includeTasks: 1 }, [], null]) assert.throws(() => diagnosticOptions(options), /INVALID_DIAGNOSTIC_OPTIONS/);
});

test("bounded diagnostic task and event windows explicitly report truncation", () => {
	const value = input(); value.workbench.taskCount = 20; value.workbench.tasks = Array.from({ length: 20 }, () => ({ ...value.workbench.tasks[0], eventCount: 100, events: Array.from({ length: 100 }, (_, sequence) => ({ sequence, kind: "assistant", text: secret })) })); value.game.events = Array.from({ length: 100 }, (_, sequence) => ({ sequence, kind: "assistant", text: secret }));
	const report = buildDiagnosticReport(value, {}, { reportId: "r", generatedAt: at });
	assert.equal(report.workbench.tasks.length, diagnosticLimits.tasks); assert.equal(report.workbench.tasksTruncated, true); assert.equal(report.workbench.tasks[0].events.length, diagnosticLimits.eventsPerTask); assert.equal(report.workbench.tasks[0].eventsTruncated, true); assert.equal(report.game.events.length, diagnosticLimits.gameEvents); assert.equal(report.game.eventsTruncated, true); assert.ok(!JSON.stringify(report).includes(secret));
});

test("diagnostics preserve unavailable package metadata and malformed component rows without fabricating measurements", () => {
	const value = input(); value.build.sourceRevision = secret; value.workbench.tasks = [null]; value.game.tasks = [null]; value.game.events = [null, { at: Number.MAX_VALUE }];
	const report = buildDiagnosticReport(value, {}, { reportId: "r", generatedAt: at });
	assert.equal(report.build.state, "package-metadata-unavailable"); assert.equal(report.build.sourceRevision, null); assert.equal(report.workbench.tasks[0].state, "unknown"); assert.equal(report.game.events[1].at, null); assert.ok(!JSON.stringify(report).includes(secret));
	const unavailable = buildDiagnosticReport({ workbench: { state: "unavailable", code: "WORKBENCH_RESPONSE_TIMEOUT" } }, {}, { reportId: "r", generatedAt: at }); assert.equal(unavailable.workbench.code, "WORKBENCH_RESPONSE_TIMEOUT");
});

test("the diagnostic UI fixture requires an explicit isolated role and cannot allocate model, MCP or game work", () => {
	assert.equal(sourceDiagnosticMode(["app", "--smoke", "--smoke-diagnostics"]), true); assert.equal(sourceDiagnosticMode(["app", "--managed-ui", "--smoke-ui", "--smoke-diagnostics-ui"]), true); assert.equal(sourceDiagnosticMode(["app"]), false);
	for (const args of [["--smoke-diagnostics"], ["--smoke", "--smoke-diagnostics", "--smoke-game"], ["--managed-ui", "--smoke-ui", "--smoke-diagnostics"], ["--smoke", "--smoke-diagnostics=true"]]) assert.throws(() => sourceDiagnosticMode(args), /EXPLICIT_DIAGNOSTIC_SMOKE_REQUIRED/);
	for (const [action, args] of [["probe", { mode: "offline" }], ["probe", { mode: "live" }], ["game", { action: "start" }], ["bridge", { action: "refresh" }], ["bridge-select", "arbitrary"], ["workbench", { action: "check" }], ["profiles-manage", { action: "save" }]]) assert.throws(() => assertDiagnosticSmokeAction(action, args), /DIAGNOSTIC_SMOKE_ACTION_REJECTED/);
	assert.doesNotThrow(() => assertDiagnosticSmokeAction("diagnostics-preview", {})); assert.doesNotThrow(() => assertDiagnosticSmokeAction("workbench", { action: "ui-save" }));
	assert.equal(portableDiagnosticMode(["--portable-smoke", "--portable-diagnostics"]), true); assert.equal(portableDiagnosticMode([]), false);
	for (const args of [["--portable-diagnostics"], ["--portable-smoke", "--portable-diagnostics=yes"], ["--portable-smoke", "--portable-diagnostics", "--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-diagnostics", "--portable-mcp-loss=accepted"]]) assert.throws(() => portableDiagnosticMode(args), /PACKAGED_PORTABLE_DIAGNOSTIC_MODE_REQUIRED/);
});

test("the real workbench store supplies diagnostics under SQLite query-only with original bytes and rows retained", () => {
	const store = new WorkbenchStore(":memory:"); const db = store.db;
	try {
		db.prepare("INSERT INTO roots(id,path_key,path,label,can_write,can_execute,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run("root", secret, secret, secret, 1, 1, "{}", at, at);
		db.prepare("INSERT INTO tasks(id,root_id,kind,state,prompt,response,provider,model,session_file,scope,created_at,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("task", "root", "check", "failed", secret, secret, secret, secret, secret, "{}", at, "CHECK_DID_NOT_PASS");
		db.prepare("INSERT INTO invocations(id,task_id,name,arguments,state,created_at,result,error) VALUES(?,?,?,?,?,?,?,?)").run("invocation", "task", "workspace_check", JSON.stringify({ secret }), "failed", at, JSON.stringify({ exitCode: 3, treeConfirmed: true, streamsDrained: true, stdout: secret }), "CHECK_DID_NOT_PASS");
		store.event("task", "command-output", { text: secret, error: "CHECK_DID_NOT_PASS" });
		const before = db.prepare("SELECT * FROM tasks").all(); db.exec("PRAGMA query_only=ON");
		const result = captureWorkbenchDiagnostics(store, { active: false, executionBlocked: true, configurationBlocked: false });
		assert.equal(result.taskCount, 1); assert.equal(result.tasks[0].invocations[0].exitCode, 3); assert.equal(result.tasks[0].invocations[0].treeConfirmed, true); assert.equal(result.tasks[0].events[0].code, "CHECK_DID_NOT_PASS"); assert.ok(!JSON.stringify(result).includes(secret)); assert.deepEqual(db.prepare("SELECT * FROM tasks").all(), before);
		const report = buildDiagnosticReport({ ...input(), workbench: result }, {}, { reportId: "r", generatedAt: at }); assert.equal(report.workbench.tasks[0].invocations[0].exitCode, 3); assert.equal(report.workbench.tasks[0].invocations[0].tool, "workspace_check"); assert.equal(report.workbench.tasks[0].code, "CHECK_DID_NOT_PASS");
	} finally { store.close(); }
});

test("save writes the exact preview once to a new file and no capability enters its contents", async t => {
	const root = await directory(t), f = manager(), preview = await f.exports.preview(f.owner, 1, {}), grant = f.exports.beginSave(f.owner, 1, preview.id), path = join(root, "report.json");
	assert.ok(!preview.text.includes(preview.id)); assert.ok(!preview.text.includes(grant.grant)); assert.ok(!preview.text.includes(secret));
	const saved = await f.exports.save(f.owner, 1, grant.grant, path); assert.equal(saved.sha256, preview.sha256); assert.equal(saved.bytes, preview.bytes); assert.equal(await readFile(path, "utf8"), preview.text);
	await assert.rejects(f.exports.save(f.owner, 1, grant.grant, join(root, "replay.json")), /DIAGNOSTIC_PREVIEW_REQUIRED/); assert.deepEqual(await readdir(root), ["report.json"]);
});

test("native-picker cancellation keeps the same reviewed preview reusable without writing", async t => {
	const root = await directory(t), f = manager(), preview = await f.exports.preview(f.owner, 1, {}), first = f.exports.beginSave(f.owner, 1, preview.id);
	assert.equal(f.exports.cancelSave(f.owner, 1, first.grant).cancelled, true); assert.deepEqual(await readdir(root), []);
	const second = f.exports.beginSave(f.owner, 1, preview.id); assert.notEqual(second.grant, first.grant); await f.exports.save(f.owner, 1, second.grant, join(root, "report.json")); assert.equal(await readFile(join(root, "report.json"), "utf8"), preview.text);
});

test("a changed UI, document generation, expired preview or forged owner cannot export", async t => {
	const root = await directory(t), f = manager(), preview = await f.exports.preview(f.owner, 1, {});
	assert.throws(() => f.exports.beginSave({}, 1, preview.id), /DIAGNOSTIC_UI_CHANGED/); f.current.generation = 2; assert.throws(() => f.exports.beginSave(f.owner, 1, preview.id), /DIAGNOSTIC_UI_CHANGED/);
	const current = await f.exports.preview(f.owner, 2, {}); f.clock.value += 300000; assert.throws(() => f.exports.beginSave(f.owner, 2, current.id), /DIAGNOSTIC_PREVIEW_EXPIRED/);
	const final = await f.exports.preview(f.owner, 2, {}), grant = f.exports.beginSave(f.owner, 2, final.id); f.exports.invalidate(f.owner); await assert.rejects(f.exports.save(f.owner, 2, grant.grant, join(root, "report.json")), /DIAGNOSTIC_PREVIEW_REQUIRED/); assert.deepEqual(await readdir(root), []);
});

test("a delayed snapshot cannot create an approval for a document replaced during collection", async () => {
	let finish; const waiting = new Promise(resolve => { finish = resolve; }), f = manager({ capture: () => waiting }), pending = f.exports.preview(f.owner, 1, {}); f.current.generation = 2; finish(input()); await assert.rejects(pending, /DIAGNOSTIC_UI_CHANGED/);
	assert.throws(() => f.exports.beginSave(f.owner, 2, "a".repeat(36)), /DIAGNOSTIC_PREVIEW_REQUIRED/);
});

test("existing files, protected profile folders, alternate streams and non-JSON names are refused", async t => {
	const root = await directory(t), profile = join(root, "profile"); await mkdir(profile); const existing = join(root, "existing.json"); await writeFile(existing, secret);
	await assert.rejects(writeNewDiagnostic(existing, Buffer.from("{}")), /DIAGNOSTIC_DESTINATION_EXISTS/); assert.equal(await readFile(existing, "utf8"), secret);
	await assert.rejects(writeNewDiagnostic(join(profile, "new.json"), Buffer.from("{}"), [profile]), /DIAGNOSTIC_PROTECTED_DESTINATION/); assert.deepEqual(await readdir(profile), []);
	for (const name of ["file.json:stream", "CON.json", "file.txt", "trailing.json."]) await assert.rejects(writeNewDiagnostic(join(root, name), Buffer.from("{}")), /INVALID_DIAGNOSTIC_DESTINATION/);
});

test("shutdown drains an already accepted export while blocking another write or replay", async () => {
	let finish, started; const waiting = new Promise(resolve => { finish = resolve; }), entered = new Promise(resolve => { started = resolve; }); let writes = 0;
	const f = manager({ write: async () => { writes++; started(); await waiting; return { saved: true }; } }), preview = await f.exports.preview(f.owner, 1, {}), grant = f.exports.beginSave(f.owner, 1, preview.id), saving = f.exports.save(f.owner, 1, grant.grant, "unused.json"); await entered;
	await assert.rejects(f.exports.preview(f.owner, 1, {}), /DIAGNOSTIC_BUSY/); let drained = false; const drain = f.exports.drain().then(() => { drained = true; }); await Promise.resolve(); assert.equal(drained, false); finish(); await saving; await drain; assert.equal(writes, 1); assert.equal(drained, true);
});
