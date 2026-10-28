import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeMonitor } from "../apps/desktop/bridge-monitor.mjs";
import { GameTasks } from "../apps/desktop/game-tasks.mjs";
import { ReadOnlyMcpClient } from "../apps/desktop/mcp-client.mjs";
import { ResearchAdapter } from "../apps/desktop/research-adapter.mjs";
import { syntheticMcpEnvironment } from "../apps/desktop/synthetic-scope.mjs";

async function fixture(t, mode = "mcp-drop-after-accept", { driftTemp = false } = {}) {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-mcp-recovery-"))), runId = randomUUID(), worldPath = join(directory, "synthetic-research-world.json");
	await writeFile(worldPath, JSON.stringify({ version: 1, runId, commits: 0, techId: null, key: null, tick: 1200, lossInjected: false, launches: 0, prepares: 0, resultReads: 0 }), { flag: "wx" });
	const otherTemp = join(directory, "different-child-temp"); if (driftTemp) await mkdir(otherTemp);
	const marker = join(directory, "Spherewright.Mcp.exe"); await writeFile(marker, "OWNED_SYNTHETIC_MCP_RECOVERY", { flag: "wx" });
	const authority = {}, approval = {}, clients = [], hosts = [], diagnostics = []; let frozen = false, modelRequests = 0, cohortChanged = false;
	const bridge = new BridgeMonitor({ researchAuthority: authority,
		fingerprint: async path => { assert.equal(path, marker); return { path, cohortHash: cohortChanged ? "changed-cohort" : "original-cohort", fileCount: 1 }; },
		launch: (_selection, options) => {
			const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/research-mcp-server.mjs", import.meta.url)), mode, worldPath, runId], { stdio: "pipe", windowsHide: true, env: syntheticMcpEnvironment({ ...process.env, ...(driftTemp ? { TEMP: otherTemp, Temp: otherTemp, TMP: otherTemp, Tmp: otherTemp, TMPDIR: otherTemp } : {}) }) });
			let stderr = ""; child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-2048); const code = stderr.match(/SYNTHETIC_WORLD_INIT_[A-Z0-9_]+/)?.[0]; if (code) diagnostics.push(code); });
			const client = new ReadOnlyMcpClient(child, { researchAuthority: options.researchAuthority, timeoutMs: 1000 }); clients.push(client); return client;
		},
	});
	const open = () => { const host = new GameTasks({ directory, bridge, researchAuthority: authority, approvalAuthority: approval, planner: async () => { modelRequests++; return { proposedTechId: 100 }; }, freezeDevelopment: async () => { frozen = true; }, releaseDevelopment: async () => { frozen = false; }, pollMilliseconds: 0 }); hosts.push(host); return host; };
	t.after(async () => {
		for (const host of hosts) if (!host.ledger.closed) { await host.drain(); host.close(); }
		await bridge.close(); for (const client of clients) { await client.close(); assert.equal(client.exitConfirmed, true); }
		const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-mcp-recovery-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	});
	try { await bridge.select(marker); } catch (error) { throw new Error(diagnostics.at(-1) ?? error.message); } const host = open();
	const start = target => (target ?? host).start({ mode: "assist", techId: 100, providerId: "synthetic-provider", modelId: "fixture", prompt: "One normal enqueue only" });
	async function submitted(expectedCommits = 1) { start(); const before = await host.settled(), challenge = host.confirmation(before.currentTaskId, 1); host.confirm(approval, challenge.nonce, 1); const value = await host.settled(); await clients[0].exited; assert.equal(clients[0].exitConfirmed, true); assert.equal(value.phase, "blocked"); assert.equal(value.developmentFrozen, true); const world = JSON.parse(await readFile(worldPath, "utf8")); assert.equal(world.commits, expectedCommits); assert.equal(world.commitRequests, 1); assert.equal(world.lastCommitRequestKey, value.unresolved[0].idempotencyKey); assert.equal(world.prepares, 1); assert.equal(world.launches, 1); return value.unresolved[0]; }
	return { host, open, start, submitted, bridge, authority, approval, clients, world: async () => JSON.parse(await readFile(worldPath, "utf8")), frozen: () => frozen, modelRequests: () => modelRequests, changeCohort: () => { cohortChanged = true; } };
}

test("the persistent normal storage fixture retains one original action across a service restart without injecting a disconnect", async t => {
	const f = await fixture(t, "storage-normal"); f.start(); const prepared = await f.host.settled(), challenge = f.host.confirmation(prepared.currentTaskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const completed = await f.host.settled(); assert.equal(completed.phase, "completed"); const original = completed.tasks[0].intent;
	await f.bridge.disconnect(); assert.equal(f.clients[0].exitConfirmed, true); await f.bridge.connect();
	const client = f.clients[1], result = await client.researchPort(f.authority).result({ actionId: original.actionId }); assert.equal(result.result.actionId, original.actionId); assert.equal(result.result.idempotencyKey, original.idempotencyKey);
	const world = await f.world(); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.launches, 2); assert.equal(world.resultReads, 2); assert.equal(world.lossInjected, false); assert.equal(f.modelRequests(), 1);
});

for (const nonceBeforeLoss of [false, true]) test("MCP exit " + (nonceBeforeLoss ? "after an approval nonce exists" : "before an approval nonce exists") + " cannot allocate an intent or submit a commit", async t => {
	const f = await fixture(t, "storage-normal"); f.start(); const prepared = await f.host.settled(), taskId = prepared.currentTaskId;
	assert.equal(prepared.phase, "awaiting_approval"); assert.equal(prepared.tasks[0].intent, null); assert.deepEqual(prepared.unresolved, []);
	let challenge = nonceBeforeLoss ? f.host.confirmation(taskId, 1) : null;
	const client = f.clients[0], requests = client.stats.requests;
	assert.equal(client.child.kill(), true); await client.exited; assert.equal(client.exitConfirmed, true); assert.equal(client.closed, true);
	challenge ??= f.host.confirmation(taskId, 1);
	f.host.confirm(f.approval, challenge.nonce, 1); const refused = await f.host.settled();
	assert.equal(refused.phase, "failed"); assert.equal(refused.error, "MCP_READ_NOT_SUPPORTED"); assert.equal(refused.tasks[0].intent, null); assert.deepEqual(refused.unresolved, []);
	assert.equal(refused.developmentFrozen, false); assert.equal(client.stats.requests, requests);
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.throws(() => f.host.confirmation(taskId, 1), /GAME_CONFIRMATION_UNAVAILABLE/);
	await f.host.drain(); const retained = f.host.snapshot().tasks; f.host.close();
	const reopened = f.open(); await reopened.initialize(); assert.deepEqual(reopened.snapshot().tasks, retained); assert.deepEqual(reopened.snapshot().unresolved, []);
	assert.throws(() => reopened.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/); assert.throws(() => reopened.confirmation(taskId, 1), /GAME_CONFIRMATION_UNAVAILABLE/);
	assert.equal(f.clients.length, 1); assert.equal(f.modelRequests(), 1); assert.equal(f.frozen(), false); assert.equal(client.stats.requests, requests);
	const world = await f.world(); assert.equal(world.prepares, 1); assert.equal(world.commits, 0); assert.equal(world.commitRequests ?? 0, 0); assert.equal(world.key, null); assert.equal(world.launches, 1); assert.equal(world.resultReads, 0);
});

test("MCP exit with a real buffered fresh-check reply cannot advance approval into an intent", async t => {
	const f = await fixture(t, "storage-normal"); f.start(); const prepared = await f.host.settled(), challenge = f.host.confirmation(prepared.currentTaskId, 1), client = f.clients[0], requests = client.stats.requests;
	client.child.stdout.pause(); f.host.confirm(f.approval, challenge.nonce, 1);
	while (!client.child.stdout.readableLength && !client.closed) await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(client.child.stdout.readableLength > 0); assert.equal(client.closed, false); assert.equal(client.requestPerformance().pending, 1); assert.equal(client.stats.requests, requests + 1);
	assert.equal(f.host.snapshot().phase, "confirming"); assert.equal(f.host.snapshot().tasks[0].intent, null); assert.deepEqual(f.host.snapshot().unresolved, []);
	assert.equal(client.child.kill(), true); await client.exited; client.child.stdout.resume(); const refused = await f.host.settled();
	assert.equal(refused.phase, "failed"); assert.equal(refused.error, "MCP_EXITED"); assert.equal(client.requestPerformance().transportStopReason, "MCP_EXITED"); assert.equal(refused.tasks[0].intent, null); assert.deepEqual(refused.unresolved, []); assert.equal(refused.developmentFrozen, false);
	assert.throws(() => f.host.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	await f.host.drain(); const original = f.host.snapshot().tasks; f.host.close(); const reopened = f.open(); await reopened.initialize(); assert.deepEqual(reopened.snapshot().tasks, original);
	assert.throws(() => reopened.confirm(f.approval, challenge.nonce, 1), /FRESH_RESEARCH_APPROVAL_REQUIRED/);
	assert.equal(client.stats.requests, requests + 1); assert.equal(f.clients.length, 1); assert.equal(f.modelRequests(), 1);
	const world = await f.world(); assert.equal(world.prepares, 1); assert.equal(world.commitRequests ?? 0, 0); assert.equal(world.commits, 0); assert.equal(world.launches, 1);
});

test("accepted MCP exit can explicitly reconnect and reconcile only the original action without replay", async t => {
	const f = await fixture(t), original = await f.submitted(); assert.equal(original.state, "accepted"); assert.equal(original.actionId, "synthetic-action");
	assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/); await assert.rejects(f.bridge.connect(), /GAME_TASK_OWNS_BRIDGE/);
	f.host.reconcile(original.intentId); const done = await f.host.settled();
	assert.equal(done.phase, "completed", JSON.stringify({ error: done.error, clients: f.clients.length, world: await f.world() }));
	assert.equal(done.tasks[0].intent.idempotencyKey, original.idempotencyKey); assert.equal(done.tasks[0].intent.actionId, original.actionId); assert.deepEqual(done.tasks[0].intent.acceptance, original.acceptance);
	assert.equal(done.unresolved.length, 0); assert.equal(f.frozen(), false); assert.equal(f.clients.length, 2); assert.equal(f.modelRequests(), 1);
	const world = await f.world(); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.resultReads, 2); assert.equal(world.launches, 2);
});

for (const [mode, commits] of [["mcp-lost-ack", 1], ["mcp-drop-before-accept", 0]]) test(mode + " remains blocked without allocating a replacement MCP or inventing an action ID, including restart", async t => {
	const f = await fixture(t, mode), original = await f.submitted(commits); assert.equal(original.state, "unknown"); assert.equal(original.actionId, null); assert.equal(original.acceptance, null);
	assert.throws(() => f.host.reconcile(original.intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize();
	assert.deepEqual(reopened.snapshot().unresolved, [original]); assert.throws(() => reopened.reconcile(original.intentId), /UNKNOWN_COMMIT_HAS_NO_ACTION_ID/); assert.throws(() => f.start(reopened), /GAME_TASK_START_BLOCKED/);
	assert.equal(f.clients.length, 1); assert.equal(f.modelRequests(), 1); assert.equal(f.frozen(), true); const world = await f.world(); assert.equal(world.commits, commits); assert.equal(world.commitRequests, 1); assert.equal(world.lastCommitRequestKey, original.idempotencyKey); assert.equal(world.prepares, 1); assert.equal(world.launches, 1);
});

for (const [suffix, delivery] of [["duplicate", "same-result"], ["late", "next-status"]]) test("a conflicting " + suffix + " receipt cannot overwrite the original result or satisfy a later RPC", async t => {
	const f = await fixture(t, "mcp-drop-after-accept-" + suffix), original = await f.submitted();
	f.host.reconcile(original.intentId); const done = await f.host.settled(), current = done.tasks[0].intent;
	assert.equal(done.phase, "completed"); assert.equal(done.error, null); assert.equal(done.unresolved.length, 0); assert.equal(done.developmentFrozen, false);
	assert.equal(current.actionId, original.actionId); assert.equal(current.idempotencyKey, original.idempotencyKey); assert.deepEqual(current.acceptance, original.acceptance);
	assert.equal(current.terminal.actionId, original.actionId); assert.deepEqual(current.terminal.afterQueue, [99, 100]);
	assert.equal(f.clients[1].stats.duplicateReplies, 1);
	const world = await f.world(); assert.equal(world.duplicateRepliesSent, 1); assert.equal(world.duplicateDelivery, delivery);
	assert.equal(world.commitRequests, 1); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.resultReads, 2); assert.equal(world.launches, 2);
});

test("recovery refuses changed MCP source, changed schema or changed world while retaining the accepted identity", async t => {
	for (const kind of ["cohort", "schema", "world"]) {
		const f = await fixture(t, kind === "cohort" ? "mcp-drop-after-accept" : "mcp-drop-after-accept-" + kind), original = await f.submitted();
		if (kind === "cohort") f.changeCohort(); f.host.reconcile(original.intentId); const value = await f.host.settled();
		assert.equal(value.phase, "blocked"); assert.equal(value.error, kind === "cohort" ? "MCP_COHORT_CHANGED_RESELECT_REQUIRED" : kind === "schema" ? "ORIGINAL_MCP_COHORT_REQUIRED" : "GAME_CONTEXT_CHANGED");
		assert.deepEqual(value.unresolved, [original]); assert.equal(f.frozen(), true); assert.equal(f.clients.length, kind === "cohort" ? 1 : 2);
		const world = await f.world(); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.resultReads, 1);
	}
});

test("a mismatched original receipt after reconnect enters durable isolation and a second reconciliation makes no requests", async t => {
	const f = await fixture(t, "mcp-drop-after-accept-key"), original = await f.submitted(); f.host.reconcile(original.intentId); const isolated = await f.host.settled();
	assert.equal(isolated.error, "INDEPENDENT_GAME_AUDIT_REQUIRED"); assert.equal(isolated.unresolved[0].actionId, original.actionId); assert.equal(isolated.unresolved[0].idempotencyKey, original.idempotencyKey); assert.equal(f.clients.length, 2);
	const requests = f.clients[1].stats.requests, before = await f.world(); f.host.reconcile(original.intentId); const repeated = await f.host.settled();
	assert.equal(repeated.error, "INDEPENDENT_GAME_AUDIT_REQUIRED"); assert.equal(f.clients[1].stats.requests, requests); assert.deepEqual(await f.world(), before); assert.equal(f.frozen(), true);
});

for (const [suffix, state, recoveryRequired, succeeded] of [["unknown", "outcome_unknown", false, false], ["recovery", "recovery_required", false, false], ["failed", "action_failed", false, false], ["recovery-flag", "completed", true, true]]) test("native " + suffix + " after MCP reconnect remains isolated across coordinator restart without further requests", async t => {
	const f = await fixture(t, "mcp-drop-after-accept-" + suffix), original = await f.submitted();
	f.host.reconcile(original.intentId); const blocked = await f.host.settled();
	assert.equal(blocked.phase, "blocked"); assert.equal(blocked.error, "INDEPENDENT_GAME_AUDIT_REQUIRED");
	assert.deepEqual(blocked.unresolved, [{ ...original, state: "unknown" }]);
	assert.equal(f.host.ledger.db.prepare("SELECT reason FROM game_gate WHERE id=1").get().reason, "NATIVE_OUTCOME_REQUIRES_AUDIT");
	const world = await f.world(), count = f.clients[1].stats.requests;
	assert.deepEqual(world.nativeOutcome, { state, terminal: true, succeeded, recoveryRequired });
	assert.equal(world.resultReads, 2); assert.equal(world.commits, 1); assert.equal(world.prepares, 1);
	f.host.reconcile(original.intentId); assert.equal((await f.host.settled()).error, "INDEPENDENT_GAME_AUDIT_REQUIRED");
	assert.equal(f.clients[1].stats.requests, count); assert.deepEqual(await f.world(), world);
	await f.bridge.close(); assert.equal(f.clients[1].exitConfirmed, true);
	await f.host.drain(); f.host.close(); const reopened = f.open(); await reopened.initialize();
	assert.deepEqual(reopened.snapshot().unresolved, blocked.unresolved); assert.equal(reopened.snapshot().developmentFrozen, true);
	reopened.reconcile(original.intentId); assert.equal((await reopened.settled()).error, "INDEPENDENT_GAME_AUDIT_REQUIRED");
	assert.equal(f.clients[1].stats.requests, count); assert.deepEqual(await f.world(), world); assert.equal(f.clients.length, 2); assert.equal(f.modelRequests(), 1);
	assert.throws(() => f.start(reopened), /GAME_TASK_START_BLOCKED/);
});

test("a recovery adapter refuses prepare and commit before allocating either request", async t => {
	const f = await fixture(t), lease = f.bridge.acquireResearch(f.authority), adapter = new ResearchAdapter({ ...lease, authority: f.authority, recoveryOnly: true }), before = f.clients[0].stats.requests;
	await assert.rejects(adapter.prepareResearch({}, {}), /READ_ONLY_RESEARCH_RECOVERY/); await assert.rejects(adapter.commit({}), /READ_ONLY_RESEARCH_RECOVERY/);
	assert.equal(f.clients[0].stats.requests, before); f.bridge.releaseResearch(lease);
});

test("MCP recovery rejects a live or forged lease and never starts a replacement when original close fails", async t => {
	const f = await fixture(t), lease = f.bridge.acquireResearch(f.authority), binding = { cohortHash: lease.selection.cohortHash, schemaHash: f.clients[0].metadata.schemaHash };
	await assert.rejects(f.bridge.reconnectResearch({ ...lease }, binding), /ORIGINAL_MCP_RECONNECT_UNAVAILABLE/);
	await assert.rejects(f.bridge.reconnectResearch(lease, binding), /ORIGINAL_MCP_RECONNECT_UNAVAILABLE/); assert.equal(f.clients.length, 1); f.bridge.releaseResearch(lease);
	const original = await f.submitted(), mockedClose = t.mock.method(f.clients[0], "close", async () => { throw new Error("MCP_EXIT_NOT_CONFIRMED"); });
	try { f.host.reconcile(original.intentId); const value = await f.host.settled(); assert.equal(value.error, "MCP_EXIT_NOT_CONFIRMED"); assert.deepEqual(value.unresolved, [original]); assert.equal(f.clients.length, 1); assert.equal(f.frozen(), true); }
	finally { mockedClose.mock.restore(); }
});

test("ordinary selection and another task stay excluded for the complete original-client recovery", async t => {
	const f = await fixture(t), original = await f.submitted(), oldLease = f.bridge.researchLease;
	let entered, finish, timer; const entering = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { finish = resolve; }), fingerprint = f.bridge.fingerprint;
	t.mock.method(f.bridge, "fingerprint", async (...args) => { entered(); await barrier; return fingerprint(...args); });
	f.host.reconcile(original.intentId);
	try {
		await Promise.race([entering, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("RECOVERY_DID_NOT_ENTER")), 3000); })]); clearTimeout(timer);
		assert.equal(f.bridge.researchLease, oldLease); assert.equal(f.frozen(), true);
		for (const action of [() => f.bridge.connect(), () => f.bridge.disconnect(), () => f.bridge.select("unrelated.exe")]) await assert.rejects(action(), /GAME_TASK_OWNS_BRIDGE/);
		assert.throws(() => f.host.reconcile(original.intentId), /GAME_TASK_BUSY/); assert.throws(() => f.start(), /GAME_TASK_START_BLOCKED/);
	} finally { clearTimeout(timer); finish(); }
	assert.equal((await f.host.settled()).phase, "completed"); assert.equal(f.clients.length, 2); assert.equal((await f.world()).commits, 1);
});

test("synthetic-world admission reports only a fixed scope error, emits no MCP response and leaves the file untouched", async t => {
	const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-world-refusal-"))), path = join(directory, "synthetic-research-world.json"), before = '{"privateCanary":"preserve original bytes"}';
	await writeFile(path, before, { flag: "wx" });
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/research-mcp-server.mjs", import.meta.url)), "mcp-drop-after-accept", path, randomUUID()], { stdio: "pipe", windowsHide: true, env: syntheticMcpEnvironment() });
	t.after(async () => { assert.notEqual(child.exitCode, null); const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-world-refusal-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; }); child.stdin.on("error", () => {}); child.stdin.end('{"jsonrpc":"2.0","id":"init","method":"initialize","params":{}}\n');
	const [code] = await once(child, "close"); assert.equal(code, 2); assert.equal(stdout, ""); assert.equal(stderr.trim(), "SYNTHETIC_WORLD_INIT_TEMP_PREFIX"); assert.equal(await readFile(path, "utf8"), before);
});

test("the synthetic MCP keeps its owner's canonical temp scope despite conflicting child temp aliases", async t => {
	const f = await fixture(t, "mcp-drop-after-accept", { driftTemp: true }), original = await f.submitted();
	f.host.reconcile(original.intentId); assert.equal((await f.host.settled()).phase, "completed"); const world = await f.world(); assert.equal(world.commits, 1); assert.equal(world.prepares, 1); assert.equal(world.launches, 2);
});

test("Windows DOS directory aliases resolve to the same physical temp scope", async t => {
	if (process.platform !== "win32" || !process.env.ProgramFiles) return t.skip("Windows directory alias unavailable");
	const alias = join(parse(process.env.ProgramFiles).root, "PROGRA~1"); let physical;
	try { physical = await realpath(alias); if (physical.toLowerCase() !== (await realpath(process.env.ProgramFiles)).toLowerCase() || physical.toLowerCase() === alias.toLowerCase()) return t.skip("No matching DOS directory alias"); } catch { return t.skip("No matching DOS directory alias"); }
	// This child only reads directory metadata; no fixture or file is created there.
	const source = `import {syntheticMcpEnvironment} from ${JSON.stringify(new URL("../apps/desktop/synthetic-scope.mjs", import.meta.url).href)};import {realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';const expected=await realpath(tmpdir());const env=syntheticMcpEnvironment();if(env.TEMP.toLowerCase()!==expected.toLowerCase())throw new Error('TEMP_SCOPE_ALIAS_MISMATCH');console.log('PHYSICAL_TEMP_SCOPE_MATCHED');`;
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:TEMP|TMP|TMPDIR|NODE_COMPILE_CACHE)$/i.test(key))); Object.assign(env, { TEMP: alias, TMP: alias, TMPDIR: alias });
	const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); let stdout = "", stderr = ""; child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-2048); });
	const [code] = await once(child, "close"); assert.equal(code, 0, stderr.includes("TEMP_SCOPE_ALIAS_MISMATCH") ? "TEMP_SCOPE_ALIAS_MISMATCH" : "TEMP_SCOPE_ALIAS_PROBE_FAILED"); assert.equal(stdout.trim(), "PHYSICAL_TEMP_SCOPE_MATCHED");
});
