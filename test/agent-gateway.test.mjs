import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentGateway } from "../apps/desktop/agent-gateway.mjs";
import { gatewayObservation, gatewayQuery, gatewayLimits } from "../apps/desktop/agent-gateway-contract.mjs";
import { gatewayPipePrefix, gatewayMac, gatewayNonce, readGateway } from "../apps/desktop/agent-gateway-wire.mjs";
import { GatewayMcpSession, serveGatewayStdio } from "../apps/desktop/agent-gateway-stdio.mjs";
import { GatewaySmokeClient } from "../apps/desktop/agent-gateway-smoke-client.mjs";
import { assertObservationAction } from "../apps/desktop/observation-policy.mjs";
import { assertPortableAction } from "../apps/desktop/portable-mode.mjs";
import { PowerLifecycle } from "../apps/desktop/power-lifecycle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const datum = data => ({ state: "observed", ageMs: 2, data });
function snapshot() {
	const planets = [1, 2].map(planetId => ({ planetId, capturedAtGameTick: 1200, name: "PRIVATE_WORLD", power: { totalEnergyGenerated: 1000000 }, logistics: { stationCount: 2 }, production: [{ itemId: 6001, itemName: "Synthetic matrix", actualProductionPerMinute: 24, theoreticalProductionPerMinute: 30, findings: [] }] }));
	return { selection: { path: "PRIVATE_PATH" }, observation: { connected: true, bridge: datum({ pluginVersion: "0.4.0", gameVersion: "synthetic", protocolVersion: 1, gameLoaded: true }), session: datum({ gameLoaded: true, owned: true, accessRestricted: false, tick: 1200, localPlanetId: 1, saveName: "PRIVATE_SAVE", restartResumeToken: "PRIVATE_TOKEN" }), summary: datum({ snapshotId: "summary", source: "synthetic", scope: "local", capturedAtGameTick: 1200, coverage: { complete: true, returned: 2, total: 2, pages: 2 }, research: { currentTechId: 1, currentTechName: "Synthetic research", techQueue: [1, 2] }, planets }), production: datum({ snapshotId: "production", source: "synthetic", scope: "local", capturedAtGameTick: 1200, coverage: { complete: true, returned: 2, total: 2, pages: 2 }, window: { state: "ready", elapsedGameTicks: 600 }, planets }) } };
}
const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });
const init = version => request(1, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
async function ready(session, version = "2025-11-25") { const reply = await session.handle(init(version)); await session.handle({ jsonrpc: "2.0", method: "notifications/initialized" }); return reply; }
async function raw(binding, value) {
	const socket = createConnection(binding.pipe); socket.on("error", () => {}); let output = Buffer.alloc(0);
	socket.on("data", bytes => { output = Buffer.concat([output, bytes]); });
	const ended = new Promise(resolve => socket.once("close", resolve));
	await once(socket, "connect"); socket.write(value); await ended; return output;
}
const signed = (binding, query, nonce = gatewayNonce()) => JSON.stringify({ version: 1, nonce, query, mac: gatewayMac(binding.key, "request", nonce, query) }) + "\n";

test("gateway shares only bounded projected cache data with snapshot-bound paging and units", () => {
	const value = snapshot();
	for (const section of ["status", "research", "production", "power", "logistics"]) assert.ok(!JSON.stringify(gatewayObservation(value, { section })).includes("PRIVATE"));
	const first = gatewayObservation(value, { section: "production", limit: 1 }); assert.equal(first.state, "observed"); assert.equal(first.planets[0].production[0].actualProductionPerMinute, 24); assert.equal(first.planets[0].production[0].unit, "items/min"); assert.equal(first.page.nextOffset, 1);
	const second = gatewayObservation(value, { section: "production", offset: 1, limit: 1, snapshotId: first.snapshotId }); assert.equal(second.planets[0].planetId, 2); assert.equal(second.page.nextOffset, null);
	assert.equal(gatewayObservation(value, { section: "power" }).planets[0].power.unit, "J/game tick");
	assert.throws(() => gatewayObservation(value, { section: "production", snapshotId: "old" }), /SNAPSHOT_CHANGED/);
	assert.throws(() => gatewayObservation(value, { section: "production", offset: 3 }), /INVALID_QUERY/);
	for (const args of [{ section: "write" }, { section: "research", limit: 1 }, { section: "status", snapshotId: "s" }, { section: "power", limit: 17 }, { section: "power", refresh: true }]) assert.throws(() => gatewayQuery(args), /INVALID_QUERY/);
});

test("lost ownership, restrictions or main menu cannot leak old world cache or session coordinates", () => {
	for (const patch of [{ owned: false }, { accessRestricted: true }, { gameLoaded: false }, { accessRestricted: undefined }]) {
		const value = snapshot(); Object.assign(value.observation.session.data, patch);
		for (const section of ["research", "production", "power", "logistics"]) { const result = gatewayObservation(value, { section }); assert.equal(result.data, null); assert.equal(result.snapshotId, undefined); assert.ok(!JSON.stringify(result).includes("Synthetic")); }
		assert.equal(gatewayObservation(value, { section: "status" }).session.data.tick, null);
	}
	const value = snapshot(); value.observation.session.state = "unavailable"; assert.equal(gatewayObservation(value, { section: "research" }).data, null);
	value.observation.session.state = "observed"; value.observation.bridge.data.gameLoaded = false; assert.equal(gatewayObservation(value, { section: "research" }).data, null);
});

test("disconnected, old and paused cache never becomes fresh and partial coverage remains explicit", () => {
	for (const change of [value => { value.observation.connected = false; }, value => { value.systemPaused = true; }, value => { value.observation.production.ageMs = 15001; }, value => { value.observation.production.ageMs = null; }]) { const value = snapshot(); change(value); const result = gatewayObservation(value, { section: "production" }); assert.equal(result.state, "stale"); assert.equal(result.planets[0].production[0].actualProductionPerMinute, 24); }
	const value = snapshot(); value.observation.production.data.coverage.complete = false; assert.equal(gatewayObservation(value, { section: "production" }).sourceCoverage.complete, false);
});

test("named pipe verifies credentials, frame bounds and replay before reading cache; restart revokes old config", async t => {
	let reads = 0; const gateway = new AgentGateway({ snapshot: () => { reads++; return snapshot(); } }); t.after(() => gateway.stop());
	assert.equal(gateway.snapshot().enabled, false); await gateway.start(); const binding = gateway.connection();
	assert.equal(JSON.stringify(gateway.snapshot()).includes(binding.key), false);
	assert.equal((await readGateway(binding, { section: "research" })).data.currentTechId, 1);
	await assert.rejects(readGateway({ ...binding, key: "0".repeat(64) }, { section: "status" }), /UNAVAILABLE/);
	for (const payload of ["{}\n", "x".repeat(gatewayLimits.requestBytes + 1), signed(binding, { section: "status" }) + "{}\n"]) assert.equal((await raw(binding, payload)).length, 0);
	const replay = signed(binding, { section: "status" }); assert.ok((await raw(binding, replay)).length); assert.equal((await raw(binding, replay)).length, 0);
	const invalid = JSON.parse(await raw(binding, signed(binding, { section: "status", execute: true }))); assert.equal(invalid.body.error, "GATEWAY_INVALID_QUERY"); assert.equal(reads, 2);
	await gateway.stop(); await gateway.start(); const current = gateway.connection(); assert.notEqual(current.pipe, binding.pipe); assert.notEqual(current.key, binding.key);
	await assert.rejects(readGateway(binding, { section: "status" }), /UNAVAILABLE/); assert.equal((await readGateway(current, { section: "status" })).readOnly, true);
});

test("gateway rate bound resets only after its window and stop closes partial clients", async t => {
	let now = 0, reads = 0; const gateway = new AgentGateway({ now: () => now, snapshot: () => { reads++; return snapshot(); } }); t.after(() => gateway.stop()); await gateway.start();
	for (let index = 0; index < gatewayLimits.requestsPerMinute; index++) await readGateway(gateway.connection(), { section: "status" });
	await assert.rejects(readGateway(gateway.connection(), { section: "status" }), /RATE_LIMIT/); assert.equal(reads, gatewayLimits.requestsPerMinute);
	now = 60000; await readGateway(gateway.connection(), { section: "status" });
	const socket = createConnection(gateway.connection().pipe); socket.on("error", () => {}); const closed = new Promise(resolve => socket.once("close", resolve)); await once(socket, "connect"); socket.write("{"); await gateway.stop(); await closed; assert.equal(gateway.snapshot().activeConnections, 0);
	const starting = gateway.start(); const rejected = assert.rejects(starting, /START_CANCELLED/); await gateway.stop(); await rejected; assert.equal(gateway.snapshot().enabled, false);
});

test("gateway client rejects forged response, supports cancellation and does not retry", async t => {
	let connects = 0; const binding = { pipe: gatewayPipePrefix + randomUUID(), key: "a".repeat(64) };
	const sockets = new Set(), server = createServer(socket => { connects++; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {}); if (connects === 1) socket.on("data", () => socket.end('{"version":1,"nonce":"wrong","body":{},"mac":"wrong"}\n')); });
	t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }); await new Promise(resolve => server.listen(binding.pipe, resolve));
	await assert.rejects(readGateway(binding, { section: "status" }), /RESPONSE_INVALID/);
	const accepted = once(server, "connection"), controller = new AbortController(), pending = assert.rejects(readGateway(binding, { section: "status" }, controller.signal), /REQUEST_CANCELLED/); await accepted; controller.abort(); await pending;
	assert.equal(connects, 2);
});

test("gateway limits simultaneous unframed peers and rejects an oversized projected response", async t => {
	const value = snapshot(); let reads = 0; const gateway = new AgentGateway({ snapshot: () => { reads++; return value; } }); t.after(() => gateway.stop()); await gateway.start();
	const peers = []; for (let index = 0; index < gatewayLimits.connections; index++) { const peer = createConnection(gateway.connection().pipe); peer.on("error", () => {}); peers.push(peer); await once(peer, "connect"); }
	const deadline = performance.now() + 2000; while (gateway.snapshot().activeConnections !== 8) { assert.ok(performance.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
	await assert.rejects(readGateway(gateway.connection(), { section: "status" }), /UNAVAILABLE/); assert.equal(reads, 0);
	await gateway.stop(); for (const peer of peers) peer.destroy();
	const hugeItem = { itemId: 6001, findings: Array.from({ length: 16 }, () => ({ kind: "x".repeat(200), confidence: "x".repeat(200), severity: "x".repeat(200) })) };
	value.observation.production.data.planets = Array.from({ length: 16 }, (_, index) => ({ planetId: index + 1, production: Array.from({ length: 64 }, () => hugeItem) }));
	await gateway.start(); await assert.rejects(readGateway(gateway.connection(), { section: "production", limit: 16 }), /RESPONSE_TOO_LARGE/); assert.equal(reads, 1);
});

test("observation-only, portable baseline and power pause cannot enable or copy a gateway", () => {
	const power = new PowerLifecycle({ quiesce: () => {}, check: () => {}, restore: () => {} }); power.suspend();
	for (const action of ["start", "copy"]) {
		assert.throws(() => assertObservationAction({ maxToolRequests: 12, maxDurationMs: 10000 }, "gateway", { action }), /READ_ONLY_OBSERVATION_MODE/);
		assert.throws(() => assertPortableAction("gateway", { action }), /PORTABLE_SMOKE_ACTION_REJECTED/);
		assert.throws(() => power.assertAction("gateway", { action }), /SYSTEM_POWER_PAUSED/);
	}
	power.assertAction("gateway", { action: "snapshot" }); power.assertAction("gateway", { action: "stop" }); power.dispose();
});

test("MCP negotiates protocols and initialization, exposes only the read tool and rejects writes without a pipe request", async () => {
	for (const version of ["2025-11-25", "2025-06-18", "unknown"]) {
		let reads = 0; const session = new GatewayMcpSession(async query => { reads++; return gatewayObservation(snapshot(), query); });
		assert.equal((await session.handle(request(2, "tools/list"))).error.code, -32002);
		const initialized = await ready(session, version); assert.equal(initialized.result.protocolVersion, version === "unknown" ? "2025-11-25" : version); assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
		const listed = await session.handle(request(2, "tools/list")); assert.equal(listed.result.tools.length, 1); assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
		for (const message of [request(3, "resources/read", {}), request(4, "tools/call", { name: "commit", arguments: {} }), request(5, "tools/call", { name: "deck_observe", arguments: { section: "status", refresh: true } })]) assert.ok((await session.handle(message)).error);
		assert.equal(reads, 0); assert.equal((await session.handle(request(6, "tools/call", { name: "deck_observe", arguments: { section: "research" } }))).result.structuredContent.data.currentTechId, 1);
		session.close(); assert.equal(await session.handle(request(7, "ping")), null);
	}
});

test("MCP cancellation suppresses its result and duplicate active ids cannot start another read", async () => {
	let reads = 0; const session = new GatewayMcpSession((_query, signal) => { reads++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancel")), { once: true })); }); await ready(session);
	const call = request(8, "tools/call", { name: "deck_observe", arguments: { section: "status" } }), pending = session.handle(call);
	assert.equal((await session.handle(call)).error.code, -32600); assert.equal(reads, 1);
	await session.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8 } }); assert.equal(await pending, null); session.close();
});

test("stdio reports malformed input without echo, limits frames, and propagates output failures instead of hanging", async () => {
	const input = new PassThrough(), lines = [], output = new Writable({ write(bytes, _encoding, callback) { lines.push(bytes.toString()); callback(); } });
	const serving = serveGatewayStdio(() => { throw new Error("NO_READ"); }, input, output); input.end('{PRIVATE_BAD_JSON}\n'); await serving;
	assert.equal(JSON.parse(lines.join("")).error.code, -32700); assert.ok(!lines.join("").includes("PRIVATE"));
	const oversized = new PassThrough(), quiet = new PassThrough(); quiet.resume(); const limited = assert.rejects(serveGatewayStdio(() => {}, oversized, quiet), /INPUT_LIMIT/); oversized.end(Buffer.alloc(8193, 65)); await limited;
	const brokenInput = new PassThrough(), brokenOutput = new Writable({ write(_bytes, _encoding, callback) { callback(new Error("PRIVATE_OUTPUT_ERROR")); } });
	const broken = assert.rejects(serveGatewayStdio(() => {}, brokenInput, brokenOutput), /GATEWAY_STDIO_OUTPUT_FAILED/); brokenInput.write(JSON.stringify(init("2025-11-25")) + "\n"); await broken;
});

test("stdin close aborts an in-flight read and never emits its cancelled result", async () => {
	let entered, cancelled = false; const started = new Promise(resolve => { entered = resolve; }), input = new PassThrough(), lines = [];
	const output = new Writable({ write(bytes, _encoding, callback) { lines.push(bytes.toString()); callback(); } });
	const serving = serveGatewayStdio((_query, signal) => new Promise((_resolve, reject) => { entered(); signal.addEventListener("abort", () => { cancelled = true; reject(new Error("cancel")); }, { once: true }); }), input, output);
	for (const message of [init("2025-11-25"), { jsonrpc: "2.0", method: "notifications/initialized" }, request(9, "tools/call", { name: "deck_observe", arguments: { section: "status" } })]) input.write(JSON.stringify(message) + "\n");
	await started; input.end(); await serving; assert.equal(cancelled, true); assert.deepEqual(lines.join("").trim().split("\n").map(line => JSON.parse(line).id), [1]);
});

test("actual Node and Electron stdio entries handshake, read cache and exit on stdin close without starting a UI", async t => {
	const gateway = new AgentGateway({ snapshot }); t.after(() => gateway.stop()); await gateway.start(); const binding = gateway.connection();
	for (const command of [process.execPath, join(root, "node_modules/electron/dist/electron.exe")]) {
		const peer = new GatewaySmokeClient({ command, args: [join(root, "apps/desktop/agent-gateway-stdio.mjs")], env: { ELECTRON_RUN_AS_NODE: "1", COMMANDDECK_GATEWAY_PIPE: binding.pipe, COMMANDDECK_GATEWAY_KEY: binding.key } }, root);
		try { assert.equal((await peer.initialize("2025-06-18")).result.protocolVersion, "2025-06-18"); assert.equal((await peer.request("tools/list")).result.tools[0].name, "deck_observe"); assert.equal((await peer.observe({ section: "production" })).result.structuredContent.planets[0].production[0].actualProductionPerMinute, 24); }
		finally { const exit = await peer.close(); assert.equal(exit.code, 0); }
	}
});
