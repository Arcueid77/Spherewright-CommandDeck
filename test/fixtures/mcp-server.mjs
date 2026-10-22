import { createInterface } from "node:readline";
import { runtimePerformanceFixture } from './runtime-performance.mjs';
const mode = process.argv[2] ?? "normal";
const send = (value) => { const write = () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n"); if (mode === "slow-metadata") setTimeout(write, 750); else write(); };
const tool = (name, properties = {}, required = []) => ({ name, inputSchema: { type: "object", properties: Object.fromEntries(Object.entries(properties).map(([key, type]) => [key, type === "array" ? { type, items: { type: "integer" } } : { type }])), required }, annotations: { readOnlyHint: true, destructiveHint: false } });
const tools = [tool("spherewright_get_status"), tool("spherewright_get_session_state"), tool("spherewright_get_overseer_summary", { sessionId: "string", limit: "integer", cursor: "string" }, ["sessionId"]), tool("spherewright_get_overseer_production", { sessionId: "string", itemIds: "array", limit: "integer", cursor: "string" }, ["sessionId", "itemIds"]), tool("spherewright_commit_select_research")];
if (mode === "bad-hint") tools[0].annotations.readOnlyHint = false;
if (mode === "bad-schema") tools[0].inputSchema.required = ["unexpected"];
if (mode === "invalid-suffix") tools.push(tool("spherewright_get_status"));
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const message = JSON.parse(line); if (message.id === undefined || !message.method) return;
	if (mode === "malformed") { process.stdout.write("not MCP JSON\n"); return; }
	if (mode === "stall") return;
	let result;
	if (message.method === "initialize") result = { protocolVersion: "2025-06-18", serverInfo: { name: "Synthetic Spherewright", version: "fixture" }, capabilities: { tools: {}, resources: {} } };
	if (message.method === "tools/list") result = mode === "repeat-cursor" ? { tools: [], nextCursor: "same" } : message.params?.cursor ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: "second" };
	if (message.method === "resources/list") result = { resources: [{ uri: "spherewright://fixture", name: "Fixture" }] };
	if (message.method === "tools/call") {
		if (mode === "error") { send({ id: message.id, error: { code: -1, message: "SYNTHETIC_RAW_DIAGNOSTIC_MUST_NOT_ESCAPE" } }); return; }
		result = { structuredContent: { success: true, status: { bridgeConnected: false } }, content: [] };
		if (mode === "telemetry") {
			const name = message.params.name, args = message.params.arguments;
			let value;
			if (name === "spherewright_get_status") value = { success: true, status: { bridgeConnected: true, bridgeInstanceId: "synthetic-bridge", protocolVersion: 1, pluginVersion: "synthetic", gameVersion: "synthetic", gameLoaded: true, runtimePerformance: runtimePerformanceFixture() } };
			else if (name === "spherewright_get_session_state") value = { success: true, result: { bridgeConnected: true, sessionId: "synthetic-session", gameLoaded: true, ownedBySpherewright: true, accessRestricted: false, gameTick: 1200, localPlanetId: 1, revision: 1, saveName: "PRIVATE_SYNTHETIC_SAVE", restartResumeToken: "PRIVATE_SYNTHETIC_TOKEN" } };
			else {
				const production = name.endsWith("production"), planetId = args.cursor ? 2 : 1;
				const body = { sessionId: "synthetic-session", capturedAtGameTick: 1200, snapshotId: production ? "synthetic-production" : "synthetic-summary", snapshotExpiresAtUtc: "2099-01-01T00:00:00Z", totalFactoryCount: 2, returnedFactoryCount: 1, nextCursor: args.cursor ? null : "next", planets: [{ planetId, planetName: `Fixture planet ${planetId}`, capturedAtGameTick: 1200, isLocalPlanet: planetId === 1, power: { totalEnergyGenerated: 1000000, totalEnergyCapacity: 1200000, totalEnergyRequired: 800000, totalEnergyServed: 800000, minimumConsumerRatio: 1 }, logistics: { stationCount: 2, storedItemCount: 120, workingDroneCount: 1, idleDroneCount: 4, workingVesselCount: 0, idleVesselCount: 2, underpoweredStationCount: 0, outstandingLocalOrderSlotCount: 1, outstandingRemoteOrderSlotCount: 0 }, ...(production ? { production: args.itemIds.map((itemId) => ({ itemId, itemName: `Synthetic matrix ${itemId}`, producedCount: 4, consumedCount: 1, actualProductionPerMinute: 24, actualConsumptionPerMinute: 6, theoreticalProductionPerMinute: 30, utilization: 0.8, theoreticalCoverage: "complete", theoreticalRateSource: "current_runtime_component_formula_v1", rateSource: "native_factory_statistics_level_0", findingCount: 0, findingsTruncated: false, findings: [] })) } : {}) }] };
				if (production) Object.assign(body, { requestedItemIds: args.itemIds, rateSource: "native_factory_statistics_level_0", window: { state: "ready", startGameTick: 601, endGameTick: 1200, elapsedGameTicks: 600, elapsedGameSeconds: 10, wallClockElapsedSeconds: 0, excludedNonGameSeconds: 0, crossedSessionBoundary: false } });
				else body.research = { currentTechId: 1, currentTechName: "Synthetic research", currentHashUploaded: 5, currentHashRequired: 100, currentHashRemaining: 95, runtimeTechStateCount: 10, unlockedTechCount: 3, queuedTechCount: 2, techQueueTruncated: false, techQueue: [1, 2] };
				value = { success: true, result: body };
			}
			result = { structuredContent: value, content: [] };
		}
		if (mode === "tool-error" || mode === "bad-error-flag") result = { isError: mode === "tool-error" ? true : "true", structuredContent: { success: false, diagnostic: "SYNTHETIC_RAW_TOOL_ERROR_MUST_NOT_ESCAPE" }, content: [{ type: "text", text: "SYNTHETIC_RAW_TOOL_ERROR_MUST_NOT_ESCAPE" }] };
	}
	send({ id: message.id, result });
	if (mode === "duplicate" && message.method === "tools/call") send({ id: message.id, result });
	if (mode === "revoke" && message.method === "tools/call") send({ method: "notifications/tools/list_changed" });
});
