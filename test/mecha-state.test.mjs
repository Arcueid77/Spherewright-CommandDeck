import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { projectMechaState } from "../apps/desktop/mecha-state.mjs";
import { ReadOnlyTelemetry } from "../apps/desktop/telemetry.mjs";
import { ReadOnlyMcpClient, supportedReadTool } from "../apps/desktop/mcp-client.mjs";
import { ageObservation } from "../apps/renderer/src/observation-state.ts";
import { BridgeMonitor } from "../apps/desktop/bridge-monitor.mjs";

const scope = { sessionId: "owned-fixture", planetId: 1 };
const player = () => ({ ...scope, capturedAtGameTick: 1200, position: { x: 10, y: -20, z: 30 }, movementState: "Fly", isAlive: true, isOnPlanet: true, isFlying: true, isSailing: false, speed: 12.5, coreEnergy: 75, coreEnergyCapacity: 100, reactorItemId: 1006, reactorItemName: "Fixture fuel", autoReplenishFuel: true, fuelStorage: [{ itemId: 1006, name: "Fixture fuel", count: 0, slotCount: 1, privateField: "PRIVATE_MECHA" }], handcraftQueue: [{ queueIndex: 0, recipeId: 1, recipeName: "Fixture craft", remainingCraftCount: 3, progress: 20, progressRequired: 60, inputs: ["PRIVATE_MECHA"] }], constructionDrones: { enabled: true, constructionEnabled: true, total: 4, alive: 3, idle: 2, working: 1, pendingBuildTargets: 0, pendingRepairTargets: 0 }, stateHash: "PRIVATE_MECHA", checkpointToken: "PRIVATE_MECHA", inventory: ["PRIVATE_MECHA"] });
function fixture(options = {}) {
	let reads = 0;
	const client = { closed: false, calls: [], stats: { toolCalls: 0 }, supports: name => ["spherewright_get_status", "spherewright_get_session_state"].includes(name) || name === "spherewright_get_player_state" && !options.unsupported, async close() { this.closed = true; }, async read(name, args) {
		this.calls.push({ name, args }); this.stats.toolCalls++; await options.before?.(name);
		if (name.endsWith("get_status")) return { success: true, status: { bridgeConnected: true, bridgeInstanceId: "bridge-fixture", protocolVersion: 1, gameLoaded: true } };
		if (name.endsWith("get_session_state")) { reads++; return { success: true, result: { bridgeConnected: true, gameLoaded: !options.menu, ownedBySpherewright: !options.restricted, accessRestricted: Boolean(options.restricted), sessionId: options.switchWorld && reads > 1 ? "another-world" : scope.sessionId, localPlanetId: options.noPlanet ? 0 : options.switchPlanet && reads > 1 ? 2 : 1, gameTick: 1200 } }; }
		assert.equal(name, "spherewright_get_player_state"); return { success: true, result: options.player?.() ?? player() };
	} };
	return client;
}

test("mecha projection retains native zeroes and signed positions while omitting private state and inventory", () => {
	const value = projectMechaState(player(), scope);
	assert.equal(value.coreEnergyFraction, 0.75); assert.equal(value.position.y, -20); assert.equal(value.speedMetresPerSecond, 12.5);
	assert.equal(value.fuelStorage[0].count, 0); assert.equal(value.constructionDrones.working, 1); assert.equal(value.constructionDrones.pendingBuildTargets, 0);
	assert.equal(value.handcraftQueue[0].remainingCraftCount, 3); assert.ok(!JSON.stringify(value).includes("PRIVATE_MECHA")); assert.ok(!JSON.stringify(value).includes(scope.sessionId));
	const malformed = player(); malformed.position.x = NaN; malformed.speed = Infinity; malformed.coreEnergyCapacity = 0; malformed.constructionDrones.total = -1;
	const unknown = projectMechaState(malformed, scope); assert.equal(unknown.position.x, null); assert.equal(unknown.speedMetresPerSecond, null); assert.equal(unknown.coreEnergyFraction, null); assert.equal(unknown.constructionDrones.total, null);
	for (const bad of [{ ...player(), sessionId: "foreign" }, { ...player(), planetId: 2 }]) assert.throws(() => projectMechaState(bad, scope), /READ_CONTEXT_CHANGED/);
	for (const bad of [{ ...player(), capturedAtGameTick: 2 ** 54 }, { ...player(), fuelStorage: Array(65).fill({}) }, { ...player(), handcraftQueue: Array(33).fill({}) }]) assert.throws(() => projectMechaState(bad, scope), /READ_MECHA_SCHEMA_CHANGED/);
});

test("mecha observation is opt-in and pause stops only its extra read while retaining explicitly stale data", async () => {
	let now = 0; const client = fixture(), telemetry = new ReadOnlyTelemetry(client, { now: () => now });
	await telemetry.refresh(); assert.equal(client.calls.length, 4); assert.equal(telemetry.snapshot().mechaEnabled, false); assert.equal(telemetry.snapshot().mecha.data, null);
	telemetry.watchMecha(true); await telemetry.refresh(); assert.equal(client.calls.filter(call => call.name.endsWith("get_player_state")).length, 1);
	const observed = telemetry.snapshot(); assert.equal(observed.mecha.state, "observed"); assert.deepEqual(client.calls.find(call => call.name.endsWith("get_player_state")).args, scope);
	telemetry.watchMecha(false); await telemetry.refresh(); assert.equal(client.calls.filter(call => call.name.endsWith("get_player_state")).length, 1); assert.equal(telemetry.snapshot().mecha.state, "stale");
	assert.deepEqual(telemetry.snapshot().mecha.data, observed.mecha.data); assert.throws(() => telemetry.watchMecha("true"), /INVALID_MECHA_OBSERVATION/);
	telemetry.watchMecha(true); await telemetry.refresh(); now = 16001; assert.equal(telemetry.snapshot().mecha.state, "stale");
	const disconnected = ageObservation(observed, 0, true); assert.equal(disconnected.mecha.state, "stale"); assert.equal(disconnected.mecha.reason, "UI_CONNECTION_UNAVAILABLE"); await telemetry.close();
});

test("restricted, menu, unsupported and planetless sessions cannot issue an optional player read", async () => {
	for (const options of [{ restricted: true }, { menu: true }, { unsupported: true }, { noPlanet: true }]) {
		const client = fixture(options), telemetry = new ReadOnlyTelemetry(client); telemetry.watchMecha(true); await telemetry.refresh();
		assert.equal(client.calls.filter(call => call.name.endsWith("get_player_state")).length, 0); assert.equal(telemetry.snapshot().mecha.data, null);
		if (options.unsupported) assert.equal(telemetry.snapshot().mecha.state, "unsupported");
		if (options.noPlanet) assert.equal(telemetry.snapshot().mecha.reason, "NO_LOCAL_PLANET"); await telemetry.close();
	}
});

test("a mecha response from another world, planet or tick cannot become a fresh premise", async () => {
	for (const options of [{ switchWorld: true }, { switchPlanet: true }, { player: () => ({ ...player(), sessionId: "foreign" }) }, { player: () => ({ ...player(), capturedAtGameTick: 1300 }) }]) {
		const telemetry = new ReadOnlyTelemetry(fixture(options)); telemetry.watchMecha(true); await telemetry.refresh(); assert.equal(telemetry.snapshot().mecha.data, null); await telemetry.close();
	}
	let now = 0; const telemetry = new ReadOnlyTelemetry(fixture({ before(name) { if (name.endsWith("get_player_state")) now += 20000; } }), { now: () => now });
	telemetry.watchMecha(true); await telemetry.refresh(); assert.equal(telemetry.snapshot().mecha.state, "stale"); assert.equal(telemetry.snapshot().mecha.ageMs, 20000); await telemetry.close();
});

test("disabling mecha observation invalidates an already in-flight response", async () => {
	let entered, release; const ready = new Promise(resolve => { entered = resolve; });
	const client = fixture({ async before(name) { if (name.endsWith("get_player_state")) { entered(); await new Promise(resolve => { release = resolve; }); } } }), telemetry = new ReadOnlyTelemetry(client);
	telemetry.watchMecha(true); const pending = telemetry.refresh(); await ready; telemetry.watchMecha(false); release(); await pending;
	assert.equal(telemetry.snapshot().mechaEnabled, false); assert.equal(telemetry.snapshot().mecha.data, null); await telemetry.close();
});

test("the public player reader requires a read-only schema, exact native scope and no action fields", async t => {
	const tool = { name: "spherewright_get_player_state", annotations: { readOnlyHint: true, destructiveHint: false }, inputSchema: { type: "object", properties: { sessionId: { type: "string" }, planetId: { type: "integer" } }, required: ["sessionId", "planetId"] } };
	assert.equal(supportedReadTool(tool), true);
	for (const bad of [{ ...tool, annotations: { readOnlyHint: false } }, { ...tool, annotations: { readOnlyHint: true, destructiveHint: true } }, { ...tool, inputSchema: { ...tool.inputSchema, required: ["sessionId"] } }]) assert.equal(supportedReadTool(bad), false);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), "telemetry-mecha"], { stdio: "pipe", windowsHide: true }), client = new ReadOnlyMcpClient(child);
	t.after(async () => { await client.close(); assert.equal(client.exitConfirmed, true); }); await client.discover();
	for (const args of [{ sessionId: "synthetic-session" }, { sessionId: "synthetic-session", planetId: 0 }, { sessionId: "synthetic-session", planetId: 1.5 }, { sessionId: "synthetic-session", planetId: 1, planToken: "not-a-read" }]) await assert.rejects(client.read(tool.name, args), /MCP_READ_NOT_SUPPORTED/);
	assert.equal(client.stats.toolCalls, 0); const reply = await client.read(tool.name, { sessionId: "synthetic-session", planetId: 1 }); assert.equal(reply.result.speed, 12.5);
	await assert.rejects(client.read("spherewright_commit_select_research", {}), /MCP_READ_NOT_SUPPORTED/); assert.equal(client.stats.toolCalls, 1);
});

test("mecha toggles cannot reset a real bounded MCP client's request budget", async t => {
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url)), "telemetry-mecha"], { stdio: "pipe", windowsHide: true }), client = new ReadOnlyMcpClient(child, { observation: { maxToolRequests: 9, maxDurationMs: 15000 } });
	t.after(async () => { await client.close(); assert.equal(client.exitConfirmed, true); }); await client.discover();
	const telemetry = new ReadOnlyTelemetry(client); telemetry.watchMecha(true); await telemetry.refresh(); assert.equal(client.stats.toolCalls, 9); assert.equal(telemetry.snapshot().mecha.data.coreEnergyFraction, 0.75);
	telemetry.watchMecha(false); telemetry.watchMecha(true); await telemetry.refresh(); assert.equal(client.stats.toolCalls, 9); assert.equal(client.closed, true);
	assert.equal(client.requestPerformance().observationLimit.stopReason, "MCP_OBSERVATION_REQUEST_LIMIT"); await telemetry.close();
});

test("mecha observation cannot interrupt a research lease, power suspension or bridge transition", () => {
	const bridge = new BridgeMonitor(); let changes = 0;
	bridge.telemetry = { watchMecha() { changes++; }, snapshot: () => ({}), client: {}, refresh: async () => {} };
	for (const [key, blocked] of [["researchLease", {}], ["systemPaused", true], ["operation", {}], ["closing", true]]) {
		const previous = bridge[key]; bridge[key] = blocked; assert.throws(() => bridge.watchMecha(true), /BRIDGE_OBSERVER_UNAVAILABLE/); bridge[key] = previous;
	}
	assert.equal(changes, 0); bridge.watchMecha(true); assert.equal(changes, 1);
});
