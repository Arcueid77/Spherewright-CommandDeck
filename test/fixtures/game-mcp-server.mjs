// Synthetic stdio peer. No game, filesystem, provider or external network access.
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal", uri = "spherewright://agent/playbooks/opening-movement-v1";
let loaded = mode !== "new-game", commits = 0, prepared = null, original = null;
let actionReads = 0, productionTick = 1234;
const session = "synthetic-game-session", bridge = "synthetic-game-bridge";
const schema = properties => ({ type: "object", properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type, ...(name === "itemIds" ? { items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 64 } : name === "limit" ? { minimum: 0, maximum: 16 } : {}) }])), required: Object.keys(properties), additionalProperties: false });
const tool = (name, fields, readOnlyHint = true, destructiveHint = false) => ({ name, description: `Synthetic ${name}`, annotations: { readOnlyHint, destructiveHint }, inputSchema: schema(fields) });
const tools = [
	tool("spherewright_get_status", {}), tool("spherewright_get_session_state", {}), tool("spherewright_get_action_result", { actionId: "string" }), tool("spherewright_get_recipe_catalog", {}),
	tool("spherewright_get_overseer_production", { sessionId: "string", itemIds: "array", limit: "integer", cursor: "string" }),
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
	else if (name === "spherewright_get_session_state") reply = { success: true, result: { bridgeConnected: true, gameLoaded: loaded, ownedBySpherewright: loaded, accessRestricted: !loaded, sessionId: loaded ? session : null, localPlanetId: loaded ? 1 : null, gameTick: productionTick, revision: commits, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [] } };
	else if (name === "spherewright_get_recipe_catalog" && mode === "refused-read") reply = { success: false, error: { code: "RECIPE_LOCKED", message: "Synthetic recipe is not unlocked" }, result: null };
	else if (name === "spherewright_get_recipe_catalog") reply = { success: true, result: { items: [{ itemId: 1001, name: "Synthetic ore" }], saveName: "PRIVATE_SYNTHETIC_SAVE", resumeToken: "PRIVATE_SYNTHETIC_TICKET" } };
	else if (name?.startsWith("spherewright_prepare_") && mode === "refused") reply = { success: false, error: { code: "INSUFFICIENT_ITEMS", message: "Synthetic material shortage" }, result: { prepared: false, commitAllowedNow: false, commitBlockers: ["Synthetic material shortage"] } };
	else if (name?.startsWith("spherewright_prepare_")) {
		prepared = { family: name.slice("spherewright_prepare_".length), token: "PRIVATE_SYNTHETIC_NATIVE_TOKEN_" + String(commits), args };
		reply = { success: true, result: { ...(prepared.family === "new_game" ? { commitAllowed: true, peacefulMode: true, sandboxMode: false, resourceMultiplier: 1 } : { prepared: true, actionKind: "handcraft", commitAllowedNow: true, commitBlockers: [], itemBudget: [{ itemId: 1001, count: args.count }], completionCondition: "Native handcraft queue accepts requested count" }), planToken: prepared.token, expiresAtUtc: new Date(Date.now() + 30000).toISOString(), saveName: "PRIVATE_SYNTHETIC_SAVE" } };
	} else if (name?.startsWith("spherewright_commit_") && mode === "stale-commit") reply = { success: false, result: null, error: { code: "STALE_STATE", message: "Synthetic player state changed before admission" } };
	else if (name?.startsWith("spherewright_commit_")) {
		if (!prepared || args.planToken !== prepared.token) throw new Error("BAD_SYNTHETIC_PLAN");
		commits++; const newGame = prepared.family === "new_game"; loaded = true;
		actionReads = 0;
		original = { actionId: `synthetic-action-${commits}`, actionKind: newGame ? "new-game" : "handcraft", sessionId: session, planetId: 1, idempotencyKey: args.idempotencyKey, state: ["pending", "goal"].includes(mode) ? "executing" : mode === "unknown" ? "outcome_unknown" : "completed", terminal: !["pending", "goal"].includes(mode), succeeded: !["pending", "goal", "unknown"].includes(mode), completedAtGameTick: 1234 };
		if (mode === "lost-ack") process.exit(0);
		reply = { success: true, result: { actionId: original.actionId, accepted: true, ...(newGame ? { saveName: "PRIVATE_SYNTHETIC_SAVE" } : { actionKind: original.actionKind, idempotencyKey: args.idempotencyKey }) } }; prepared = null;
	} else if (name === "spherewright_get_action_result") {
		if (mode === "goal" && original && ++actionReads >= 2) Object.assign(original, { state: "completed", terminal: true, succeeded: true });
		if (!original || args.actionId !== original.actionId) reply = { success: false, error: "NOT_FOUND" };
		else { const result = { ...original }; if (result.actionKind === "new-game") { delete result.idempotencyKey; delete result.completedAtGameTick; } if (mode === "wrong-key") result.idempotencyKey = "wrong-original-key"; reply = { success: true, result }; }
	} else if (name === "spherewright_get_overseer_production") {
		productionTick += 600;
		const rate = commits === 0 ? 0 : mode === "goal-low-rate" ? 30 : 60, producedCount = rate / 6;
		reply = { success: true, result: { sessionId: session, snapshotId: "synthetic-production-" + productionTick, capturedAtGameTick: productionTick, requestedItemIds: args.itemIds, totalFactoryCount: 1, returnedFactoryCount: 1, nextCursor: null, window: { state: "ready", startGameTick: productionTick - 599, endGameTick: productionTick, elapsedGameTicks: 600, elapsedGameSeconds: 10, crossedSessionBoundary: false }, planets: [{ planetId: 1, capturedAtGameTick: productionTick, production: [{ itemId: args.itemIds[0], itemName: "Synthetic matrix", producedCount, consumedCount: 0, actualProductionPerMinute: rate, actualConsumptionPerMinute: 0, rateSource: "native_factory_statistics_level_0" }] }] } };
	} else reply = { success: false, error: "UNSUPPORTED" };
	send(id, { content: [{ type: "text", text: "Synthetic result" }], structuredContent: reply, ...(mode === "refused" && name?.startsWith("spherewright_prepare_") || mode === "refused-read" && name === "spherewright_get_recipe_catalog" || mode === "stale-commit" && name?.startsWith("spherewright_commit_") ? { isError: true } : {}) });
}
