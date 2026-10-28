import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { nativeResearchStateHash } from "../../apps/desktop/research-preview.mjs";
import { syntheticCommitReceiptReleased, publishSyntheticResearchWorld } from "../../apps/desktop/synthetic-scope.mjs";
const mode = process.argv[2] ?? "normal", playbook = "spherewright://agent/playbooks/opening-movement-v1";
const persistent = ["mcp-commit-timeout", "mcp-before-intent-preview", "mcp-before-intent-confirmation", "mcp-before-intent-revalidation", "mcp-drop-after-accept", "mcp-drop-after-accept-duplicate", "mcp-drop-after-accept-late", "mcp-drop-before-accept", "mcp-drop-after-accept-world", "mcp-drop-after-accept-schema", "mcp-drop-after-accept-key", "mcp-drop-after-accept-unknown", "mcp-drop-after-accept-recovery", "mcp-drop-after-accept-failed", "mcp-drop-after-accept-recovery-flag", "mcp-lost-ack", "mcp-lost-ack-storage", "storage-normal"].includes(mode);
let world, worldPath;
if (persistent) {
	let stage = "ARGUMENTS";
	try {
	const path = process.argv[3], runId = process.argv[4]; assert.match(runId ?? "", /^[0-9a-f-]{36}$/);
	stage = "DIRECTORY_REALPATH";
	const directory = realpathSync.native(dirname(path)), scoped = relative(realpathSync.native(tmpdir()), directory);
	stage = "TEMP_ESCAPE"; assert.ok(!scoped.startsWith("..")); stage = "TEMP_PREFIX"; assert.match(scoped.split(sep)[0], /^commanddeck-(?:mcp-recovery|desktop-smoke)-/);
	stage = "FILE_NAME"; assert.equal(basename(path), "synthetic-research-world.json"); worldPath = join(directory, basename(path)); stage = "FILE_REALPATH"; assert.equal(realpathSync.native(path).toLowerCase(), worldPath.toLowerCase());
	const info = lstatSync(path); stage = "FILE_TYPE"; assert.ok(info.isFile() && !info.isSymbolicLink()); stage = "FILE_LINKS"; assert.equal(info.nlink, 1); stage = "FILE_SIZE"; assert.ok(info.size <= 4096);
	stage = "JSON"; world = JSON.parse(readFileSync(path, "utf8")); stage = "VERSION"; assert.equal(world.version, 1); stage = "IDENTITY"; assert.equal(world.runId, runId);
	for (const field of ["commits", "tick", "launches", "prepares", "resultReads"]) { stage = "COUNTER_" + field.toUpperCase(); assert.ok(Number.isSafeInteger(world[field]) && world[field] >= 0 && world[field] <= 10000); }
	stage = "BOUNDS"; assert.equal(typeof world.lossInjected, "boolean"); assert.ok(world.commits <= 1 && world.launches < 8);
	stage = "COMMIT_IDENTITY";
	if (world.commits) { assert.equal(world.techId, 100); assert.match(world.key, /^[0-9a-f-]{36}$/); assert.equal(world.tick, 1201); }
	else { assert.equal(world.techId, null); assert.equal(world.key, null); }
	stage = "SAVE"; world.launches++; publishSyntheticResearchWorld(worldPath, world);
	} catch { process.stderr.write("SYNTHETIC_WORLD_INIT_" + stage + "\n", () => process.exit(2)); await new Promise(() => {}); }
}
const send = (id, result, done) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n", done);
const field = (type) => ({ type });
const tool = (name, fields, readOnly = true, destructive = false, optional = []) => ({ name, annotations: { readOnlyHint: readOnly, destructiveHint: destructive }, inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, field(type)])), required: Object.keys(fields).filter((key) => !optional.includes(key)) } });
const scope = { sessionId: "synthetic-session", planetId: 1 }, local = { sessionId: "string", planetId: "integer" };
const tools = [tool("spherewright_get_status", {}), tool("spherewright_get_session_state", {}), tool("spherewright_get_progression_state", local), tool("spherewright_get_player_state", local), tool("spherewright_prepare_select_research", { ...local, techId: "integer", expectedSelectionStateHash: "string", stateHashVersion: "integer", prioritizeQueued: "boolean" }, false, false, ["stateHashVersion", "prioritizeQueued"]), tool("spherewright_commit_select_research", { ...local, planToken: "string", idempotencyKey: "string" }, false, true), tool("spherewright_get_action_result", { actionId: "string" })];
if (mode === "bad-schema" || mode === "mcp-drop-after-accept-schema" && world.launches > 1) tools[4].inputSchema.required.push("unrecognized");
if (mode === "bad-commit-hint") tools[5].annotations.destructiveHint = false;
let commits = 0, preparedTech, key, tick = 1200, resultReads = 0, progressions = 0, failedContext = false, delayedReceipt;
if (world) { commits = world.commits; preparedTech = world.techId ?? undefined; key = world.key ?? undefined; tick = world.tick; resultReads = world.resultReads; }
const persist = () => { if (world) { Object.assign(world, { commits, techId: commits ? preparedTech : null, key: key ?? null, tick, resultReads }); publishSyntheticResearchWorld(worldPath, world); } };
const hash = () => "sha256:" + (commits ? "b" : "a").repeat(64);
const budget = () => [{ itemId: 1202, name: "磁线圈", count: 10, direction: "research-consumption" }];
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line); if (request.id === undefined) return;
	if (request.method === "initialize") return send(request.id, { protocolVersion: "2025-06-18", serverInfo: { version: "synthetic" }, capabilities: { tools: {}, resources: {} } });
	if (request.method === "tools/list") return send(request.id, { tools });
	if (request.method === "resources/list") return send(request.id, { resources: [{ uri: playbook, name: "Synthetic playbook" }] });
	if (request.method === "resources/read") return send(request.id, { contents: [{ uri: playbook, text: "Synthetic playbook: normal enqueue only. Retain original action; never replay a lost acknowledgement." }] });
	if (request.method !== "tools/call") return;
	const { name, arguments: args } = request.params; let value;
	if (name === "spherewright_get_status" && delayedReceipt) {
		// Deliver an old result ID while a different RPC is pending. It must not
		// satisfy that RPC or replace the already consumed terminal result.
		world.duplicateRepliesSent = (world.duplicateRepliesSent ?? 0) + 1; world.duplicateDelivery = "next-status"; persist();
		send(delayedReceipt.id, delayedReceipt.result); delayedReceipt = null;
	}
	if (["native-unknown-context-failure", "wrong-key-context-failure"].includes(mode) && name === "spherewright_get_status" && resultReads && !failedContext) { failedContext = true; return send(request.id, { isError: true, structuredContent: { success: false } }); }
	if (name === "spherewright_get_status") return send(request.id, { structuredContent: { success: true, status: { bridgeConnected: true, bridgeInstanceId: mode === "world-switch" && progressions || mode === "mcp-drop-after-accept-world" && world.launches > 1 ? "different-bridge" : "synthetic-bridge", protocolVersion: 1, gameLoaded: true, writesConfigured: mode !== "writes-disabled", writeHealth: "healthy", syntheticCommitCount: commits } } });
	if (name === "spherewright_get_session_state") value = { bridgeConnected: true, gameLoaded: true, ownedBySpherewright: mode !== "unowned", accessRestricted: false, ...scope, localPlanetId: 1, gameTick: tick, revision: 1, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [], saveName: "PRIVATE_SAVE_MUST_NOT_ESCAPE", restartResumeToken: "PRIVATE_RESUME_MUST_NOT_ESCAPE" };
	if (name === "spherewright_get_player_state") value = { ...scope, capturedAtGameTick: tick, stateHash: hash(), stateHashVersion: 1, inventory: [{ name: "PRIVATE_PLAYER_MUST_NOT_ESCAPE" }] };
	if (name === "spherewright_get_progression_state") { progressions++; value = { ...scope, capturedAtGameTick: tick, selectionStateHash: mode === "stale-selection" && progressions > 1 ? "sha256:" + "c".repeat(64) : hash(), selectionStateHashVersion: 1, techQueue: commits ? [99, preparedTech] : [99], technologies: [{ techId: 99, name: "Existing research", unlocked: false, isQueued: true, prerequisiteTechIds: [], itemRequirements: [] }, { techId: 100, name: "Synthetic research", unlocked: false, isQueued: Boolean(commits), prerequisiteTechIds: [], itemRequirements: [{ itemId: 1202, name: "磁线圈", requiredItemCount: mode === "budget-unsafe-requirement" ? Number.MAX_SAFE_INTEGER + 1 : mode === "budget-changed-at-confirm" && preparedTech ? 11 : 10, nativePrivate: "PRIVATE_REQUIREMENT_MUST_NOT_ESCAPE" }] }] }; }
	if (name === "spherewright_prepare_select_research") {
		if (world) { world.prepares++; persist(); }
		preparedTech = args.techId; value = { prepared: true, actionKind: "select-research", planToken: "PRIVATE_SYNTHETIC_NATIVE_PLAN_TOKEN_0001", expectedStateHash: nativeResearchStateHash({ kind: "select-research", ...scope, techId: args.techId, selectionStateHash: args.expectedSelectionStateHash }), stateHashVersion: 1, researchQueueReadbackVersion: 1, expiresAtUtc: new Date(Date.now() + 30000).toISOString(), commitAllowedNow: true, commitBlockers: [], itemBudget: budget() };
		if (mode === "readback-unsupported") delete value.researchQueueReadbackVersion;
		if (mode === "budget-missing") value.itemBudget = [];
		if (mode === "budget-extra") value.itemBudget.push({ ...budget()[0], itemId: 1203 });
		if (mode === "budget-wrong-id") value.itemBudget[0].itemId = 1203;
		if (mode === "budget-wrong-count") value.itemBudget[0].count = 11;
		if (mode === "budget-wrong-direction") value.itemBudget[0].direction = "consume";
		if (mode === "budget-duplicate") value.itemBudget.push(budget()[0]);
		if (mode === "budget-unsafe") value.itemBudget[0].count = Number.MAX_SAFE_INTEGER + 1;
	}
	if (name === "spherewright_commit_select_research") {
		// Match the native Guid requirement, including when a test bypasses the host argument validator.
		if (typeof args.idempotencyKey !== "string" || args.idempotencyKey.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.idempotencyKey)) return send(request.id, { isError: true, structuredContent: { success: false, error: { code: "INVALID_REQUEST", message: "A UUID idempotency key is required." } } });
		if (world) { world.commitRequests = (world.commitRequests ?? 0) + 1; world.lastCommitRequestKey = args.idempotencyKey; persist(); }
		if (mode === "mcp-drop-before-accept") { world.lossInjected = true; persist(); process.exit(0); return; }
		commits++; tick = 1201; key = args.idempotencyKey; persist(); if (mode === "lost-ack" || mode === "mcp-lost-ack" || mode === "mcp-lost-ack-storage") { process.exit(0); return; } value = { accepted: true, actionKind: "select-research", actionId: "synthetic-action", idempotencyKey: key, state: "queued", syntheticCommitCount: commits };
		if (mode === "mcp-commit-timeout") {
			world.commitReceiptWaiting = true; world.lossInjected = true; persist();
			const receipt = value, deadline = performance.now() + 15000;
			const timer = setInterval(() => {
				try {
					if (syntheticCommitReceiptReleased(dirname(worldPath), world.runId)) {
						clearInterval(timer); send(request.id, { structuredContent: { success: true, result: receipt } }, () => { world.commitReceiptWritten = true; persist(); });
					} else if (performance.now() >= deadline) throw new Error("RELEASE_TIMEOUT");
				} catch { clearInterval(timer); process.stderr.write("SYNTHETIC_COMMIT_RELEASE_FAILED\n", () => process.exit(2)); }
			}, 10);
			return;
		}
	}
	if (name === "spherewright_get_action_result") { resultReads++; if (world && !world.lossInjected && mode.startsWith("mcp-drop-after-accept")) { world.lossInjected = true; persist(); process.exit(0); return; } persist(); const pending = mode === "pending" && resultReads < 2, unknown = mode === "native-unknown" || mode === "native-unknown-context-failure" && resultReads === 1; value = { ...scope, actionId: "synthetic-action", actionKind: "select-research", idempotencyKey: mode === "mcp-drop-after-accept-key" && world.launches > 1 ? "different-native-key" : key, state: unknown ? "outcome_unknown" : pending ? "executing" : "completed", terminal: !pending, succeeded: !unknown && !pending, completedAtGameTick: 1201, recoveryRequired: unknown, researchQueueReadback: { capturedAtGameTick: 1201, beforeQueue: [99], afterQueue: mode === "wrong-queue" ? [99, 101] : [99, preparedTech], inventoryPreserved: true, researchProgressPreserved: true }, flightCheckpointReloadToken: "PRIVATE_FLIGHT_MUST_NOT_ESCAPE", syntheticCommitCount: commits }; }
	if (name === "spherewright_get_action_result" && resultReads === 2 && world?.launches > 1) {
		const outcome = {
			"mcp-drop-after-accept-unknown": { state: "outcome_unknown", succeeded: false, recoveryRequired: false },
			"mcp-drop-after-accept-recovery": { state: "recovery_required", succeeded: false, recoveryRequired: false },
			"mcp-drop-after-accept-failed": { state: "action_failed", succeeded: false, recoveryRequired: false },
			"mcp-drop-after-accept-recovery-flag": { state: "completed", succeeded: true, recoveryRequired: true },
		}[mode];
		if (outcome) {
			Object.assign(value, outcome);
			world.nativeOutcome = { state: value.state, terminal: value.terminal, succeeded: value.succeeded, recoveryRequired: value.recoveryRequired };
			persist();
		}
		// A third result read would look successful. Durable isolation must stop
		// that read entirely rather than waiting for a favorable later receipt.
	}
	if (name === "spherewright_get_action_result" && mode === "wrong-result-then-valid" && resultReads === 1) value.actionId = "different-native-action";
	if (name === "spherewright_get_action_result" && mode === "wrong-key-context-failure" && resultReads === 1) value.idempotencyKey = "different-native-key";
	if (name === "spherewright_get_action_result" && mode === "missing-readback") delete value.researchQueueReadback;
	send(request.id, { structuredContent: { success: true, result: value } });
	if (name === "spherewright_get_action_result" && resultReads === 2 && ["mcp-drop-after-accept-duplicate", "mcp-drop-after-accept-late"].includes(mode)) {
		const stale = { structuredContent: { success: true, result: { ...value, idempotencyKey: "conflicting-stale-key", state: "outcome_unknown", succeeded: false, recoveryRequired: true } } };
		if (mode === "mcp-drop-after-accept-late") delayedReceipt = { id: request.id, result: stale };
		else { world.duplicateRepliesSent = (world.duplicateRepliesSent ?? 0) + 1; world.duplicateDelivery = "same-result"; persist(); send(request.id, stale); }
	}
});
