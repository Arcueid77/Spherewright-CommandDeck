import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal", playbook = "spherewright://agent/playbooks/opening-movement-v1";
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const field = (type) => ({ type });
const tool = (name, fields, readOnly = true, destructive = false, optional = []) => ({ name, annotations: { readOnlyHint: readOnly, destructiveHint: destructive }, inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([key, type]) => [key, field(type)])), required: Object.keys(fields).filter((key) => !optional.includes(key)) } });
const scope = { sessionId: "synthetic-session", planetId: 1 }, local = { sessionId: "string", planetId: "integer" };
const tools = [tool("spherewright_get_status", {}), tool("spherewright_get_session_state", {}), tool("spherewright_get_progression_state", local), tool("spherewright_get_player_state", local), tool("spherewright_prepare_select_research", { ...local, techId: "integer", expectedSelectionStateHash: "string", stateHashVersion: "integer", prioritizeQueued: "boolean" }, false, false, ["stateHashVersion", "prioritizeQueued"]), tool("spherewright_commit_select_research", { ...local, planToken: "string", idempotencyKey: "string" }, false, true), tool("spherewright_get_action_result", { actionId: "string" })];
if (mode === "bad-schema") tools[4].inputSchema.required.push("unrecognized");
if (mode === "bad-commit-hint") tools[5].annotations.destructiveHint = false;
let commits = 0, preparedTech, key, tick = 1200, resultReads = 0, progressions = 0, failedContext = false;
const hash = () => "sha256:" + (commits ? "b" : "a").repeat(64);
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const request = JSON.parse(line); if (request.id === undefined) return;
	if (request.method === "initialize") return send(request.id, { protocolVersion: "2025-06-18", serverInfo: { version: "synthetic" }, capabilities: { tools: {}, resources: {} } });
	if (request.method === "tools/list") return send(request.id, { tools });
	if (request.method === "resources/list") return send(request.id, { resources: [{ uri: playbook, name: "Synthetic playbook" }] });
	if (request.method === "resources/read") return send(request.id, { contents: [{ uri: playbook, text: "Synthetic playbook: normal enqueue only. Retain original action; never replay a lost acknowledgement." }] });
	if (request.method !== "tools/call") return;
	const { name, arguments: args } = request.params; let value;
	if (["native-unknown-context-failure", "wrong-key-context-failure"].includes(mode) && name === "spherewright_get_status" && resultReads && !failedContext) { failedContext = true; return send(request.id, { isError: true, structuredContent: { success: false } }); }
	if (name === "spherewright_get_status") return send(request.id, { structuredContent: { success: true, status: { bridgeConnected: true, bridgeInstanceId: mode === "world-switch" && progressions ? "different-bridge" : "synthetic-bridge", protocolVersion: 1, gameLoaded: true, writesConfigured: mode !== "writes-disabled", writeHealth: "healthy", syntheticCommitCount: commits } } });
	if (name === "spherewright_get_session_state") value = { bridgeConnected: true, gameLoaded: true, ownedBySpherewright: mode !== "unowned", accessRestricted: false, ...scope, localPlanetId: 1, gameTick: tick, revision: 1, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [], saveName: "PRIVATE_SAVE_MUST_NOT_ESCAPE", restartResumeToken: "PRIVATE_RESUME_MUST_NOT_ESCAPE" };
	if (name === "spherewright_get_player_state") value = { ...scope, capturedAtGameTick: tick, stateHash: hash(), stateHashVersion: 1, inventory: [{ name: "PRIVATE_PLAYER_MUST_NOT_ESCAPE" }] };
	if (name === "spherewright_get_progression_state") { progressions++; value = { ...scope, capturedAtGameTick: tick, selectionStateHash: mode === "stale-selection" && progressions > 1 ? "sha256:" + "c".repeat(64) : hash(), selectionStateHashVersion: 1, techQueue: commits ? [99, preparedTech] : [99], technologies: [{ techId: 99, name: "Existing research", unlocked: false, isQueued: true, prerequisiteTechIds: [] }, { techId: 100, name: "Synthetic research", unlocked: false, isQueued: Boolean(commits), prerequisiteTechIds: [] }] }; }
	if (name === "spherewright_prepare_select_research") { preparedTech = args.techId; value = { prepared: true, actionKind: "select-research", planToken: "PRIVATE_SYNTHETIC_NATIVE_PLAN_TOKEN_0001", expectedStateHash: args.expectedSelectionStateHash, stateHashVersion: 1, expiresAtUtc: new Date(Date.now() + 30000).toISOString(), commitAllowedNow: true, commitBlockers: [], itemBudget: [] }; }
	if (name === "spherewright_commit_select_research") { commits++; tick = 1201; key = args.idempotencyKey; if (mode === "lost-ack") { process.exit(0); return; } value = { accepted: true, actionKind: "select-research", actionId: "synthetic-action", idempotencyKey: key, state: "queued", syntheticCommitCount: commits }; }
	if (name === "spherewright_get_action_result") { resultReads++; const pending = mode === "pending" && resultReads < 2, unknown = mode === "native-unknown" || mode === "native-unknown-context-failure" && resultReads === 1; value = { ...scope, actionId: "synthetic-action", actionKind: "select-research", idempotencyKey: key, state: unknown ? "outcome_unknown" : pending ? "executing" : "completed", terminal: !pending, succeeded: !unknown && !pending, completedAtGameTick: 1201, recoveryRequired: unknown, researchQueueReadback: { capturedAtGameTick: 1201, beforeQueue: [99], afterQueue: mode === "wrong-queue" ? [99, 101] : [99, preparedTech], inventoryPreserved: true, researchProgressPreserved: true }, flightCheckpointReloadToken: "PRIVATE_FLIGHT_MUST_NOT_ESCAPE", syntheticCommitCount: commits }; }
	if (name === "spherewright_get_action_result" && mode === "wrong-result-then-valid" && resultReads === 1) value.actionId = "different-native-action";
	if (name === "spherewright_get_action_result" && mode === "wrong-key-context-failure" && resultReads === 1) value.idempotencyKey = "different-native-key";
	send(request.id, { structuredContent: { success: true, result: value } });
});
