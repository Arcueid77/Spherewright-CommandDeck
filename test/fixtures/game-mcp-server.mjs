// Synthetic stdio peer. No game, filesystem, provider or external network access.
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal", uri = "spherewright://agent/playbooks/opening-movement-v1";
let loaded = mode !== "new-game", commits = 0, prepared = null, original = null;
const session = "synthetic-game-session", bridge = "synthetic-game-bridge";
const schema = properties => ({ type: "object", properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type }])), required: Object.keys(properties), additionalProperties: false });
const tool = (name, fields, readOnlyHint = true, destructiveHint = false) => ({ name, description: `Synthetic ${name}`, annotations: { readOnlyHint, destructiveHint }, inputSchema: schema(fields) });
const tools = [
	tool("spherewright_get_status", {}), tool("spherewright_get_session_state", {}), tool("spherewright_get_action_result", { actionId: "string" }), tool("spherewright_get_recipe_catalog", {}),
	tool("spherewright_prepare_handcraft", { sessionId: "string", planetId: "integer", recipeId: "integer", count: "integer" }, false), tool("spherewright_commit_handcraft", { sessionId: "string", planetId: "integer", planToken: "string", idempotencyKey: "string" }, false, true),
	tool("spherewright_prepare_new_game", { galaxySeed: "integer", starCount: "integer" }, false), tool("spherewright_commit_new_game", { planToken: "string", idempotencyKey: "string" }, false, true),
	tool("spherewright_prepare_save_import", { sessionId: "string" }, false), tool("spherewright_commit_save_import", { planToken: "string", idempotencyKey: "string" }, false, true),
];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line), id = request.id, name = request.params?.name, args = request.params?.arguments ?? {};
	if (id === undefined) continue;
	if (request.method === "initialize") { send(id, { protocolVersion: "2025-06-18", serverInfo: { name: "NO DSP synthetic Spherewright", version: "0.0.0" }, capabilities: { tools: {}, resources: {} } }); continue; }
	if (request.method === "tools/list") { send(id, { tools }); continue; }
	if (request.method === "resources/list") { send(id, { resources: [{ uri, name: "Synthetic playbook" }] }); continue; }
	if (request.method === "resources/read") { send(id, { contents: [{ uri, text: "Synthetic only. Use fresh prepare, native confirmation, one commit and original-action readback." }] }); continue; }
	let reply;
	if (name === "spherewright_get_status") reply = { success: true, status: { bridgeConnected: true, protocolVersion: 1, bridgeInstanceId: bridge, gameLoaded: loaded, writesConfigured: true, writeHealth: "healthy", syntheticCommitCount: commits } };
	else if (name === "spherewright_get_session_state") reply = { success: true, result: { bridgeConnected: true, gameLoaded: loaded, ownedBySpherewright: loaded, accessRestricted: !loaded, sessionId: loaded ? session : null, localPlanetId: loaded ? 1 : null, gameTick: 1234, revision: commits, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [] } };
	else if (name === "spherewright_get_recipe_catalog") reply = { success: true, result: { items: [{ itemId: 1001, name: "Synthetic ore" }], saveName: "PRIVATE_SYNTHETIC_SAVE", resumeToken: "PRIVATE_SYNTHETIC_TICKET" } };
	else if (name?.startsWith("spherewright_prepare_")) {
		prepared = { family: name.slice("spherewright_prepare_".length), token: "PRIVATE_SYNTHETIC_NATIVE_TOKEN_" + String(commits), args };
		reply = { success: true, result: { ...(prepared.family === "new_game" ? { commitAllowed: true, peacefulMode: true, sandboxMode: false, resourceMultiplier: 1 } : { prepared: true, actionKind: "handcraft", commitAllowedNow: true, commitBlockers: [], itemBudget: [{ itemId: 1001, count: args.count }], completionCondition: "Native handcraft queue accepts requested count" }), planToken: prepared.token, expiresAtUtc: new Date(Date.now() + 30000).toISOString(), saveName: "PRIVATE_SYNTHETIC_SAVE" } };
	} else if (name?.startsWith("spherewright_commit_")) {
		if (!prepared || args.planToken !== prepared.token) throw new Error("BAD_SYNTHETIC_PLAN");
		commits++; const newGame = prepared.family === "new_game"; loaded = true;
		original = { actionId: `synthetic-action-${commits}`, actionKind: newGame ? "new-game" : "handcraft", sessionId: session, planetId: 1, idempotencyKey: args.idempotencyKey, state: mode === "pending" ? "executing" : mode === "unknown" ? "outcome_unknown" : "completed", terminal: mode !== "pending", succeeded: !["pending", "unknown"].includes(mode), completedAtGameTick: 1234 };
		if (mode === "lost-ack") process.exit(0);
		reply = { success: true, result: { actionId: original.actionId, accepted: true, ...(newGame ? { saveName: "PRIVATE_SYNTHETIC_SAVE" } : { actionKind: original.actionKind, idempotencyKey: args.idempotencyKey }) } }; prepared = null;
	} else if (name === "spherewright_get_action_result") {
		if (!original || args.actionId !== original.actionId) reply = { success: false, error: "NOT_FOUND" };
		else { const result = { ...original }; if (result.actionKind === "new-game") { delete result.idempotencyKey; delete result.completedAtGameTick; } if (mode === "wrong-key") result.idempotencyKey = "wrong-original-key"; reply = { success: true, result }; }
	} else reply = { success: false, error: "UNSUPPORTED" };
	send(id, { content: [{ type: "text", text: "Synthetic result" }], structuredContent: reply });
}
