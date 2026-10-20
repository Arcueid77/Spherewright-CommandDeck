import test from "node:test";
import assert from "node:assert/strict";
import { ReadOnlyTelemetry } from "../apps/desktop/telemetry.mjs";

const window = { state: "ready", startGameTick: 601, endGameTick: 1200, elapsedGameTicks: 600, elapsedGameSeconds: 10, wallClockElapsedSeconds: 0, excludedNonGameSeconds: 0, crossedSessionBoundary: false };
function fake(options = {}) {
	const c = { closed: false, calls: [], stats: { toolCalls: 0 }, supports(name) { return !options.unsupported?.includes(name); }, async close() { c.closed = true; } };
	let sessionReads = 0;
	c.read = async (name, args = {}) => {
		c.calls.push({ name, args }); c.stats.toolCalls++;
		await options.before?.(name, args);
		if (name === "spherewright_get_status") return { success: true, status: { bridgeConnected: true, bridgeInstanceId: "bridge-fixture", protocolVersion: 1, pluginVersion: "fixture", gameVersion: "fixture", gameLoaded: true } };
		if (name === "spherewright_get_session_state") return { success: true, result: { bridgeConnected: true, gameLoaded: !options.menu, ownedBySpherewright: !options.restricted, accessRestricted: Boolean(options.restricted), sessionId: options.changeWorld && ++sessionReads > 1 ? "different-world" : "world-fixture", gameTick: 1200, localPlanetId: 1, revision: 4, saveName: "PRIVATE_SAVE_NAME", restartResumeToken: "PRIVATE_RESUME_CREDENTIAL", flightCheckpointReloadToken: "PRIVATE_RELOAD_CREDENTIAL" } };
		const second = Boolean(args.cursor), planetId = second ? 2 : 1, watched = name.endsWith("production");
		const item = { itemId: args.itemIds?.[0], itemName: "Synthetic matrix", producedCount: 0, consumedCount: 1, actualProductionPerMinute: 0, actualConsumptionPerMinute: 6, theoreticalProductionPerMinute: 60, utilization: 0, theoreticalRateSource: "current_runtime_component_formula_v1", theoreticalCoverage: "complete", rateSource: "native_factory_statistics_level_0", findings: [], findingCount: 0, ...options.item };
		const value = { sessionId: "world-fixture", capturedAtGameTick: 1200, snapshotId: watched ? "production-fixture" : "summary-fixture", snapshotExpiresAtUtc: "2099-01-01T00:00:00Z", totalFactoryCount: 2, returnedFactoryCount: 1, planets: [{ planetId, capturedAtGameTick: 1200, planetName: `Fixture planet ${planetId}`, isLocalPlanet: planetId === 1, power: { totalEnergyGenerated: 42 }, logistics: { stationCount: 3 }, ...(watched ? { production: [item] } : {}) }], nextCursor: second ? null : "next", ...(watched ? { requestedItemIds: args.itemIds, window: { ...window, ...options.window }, rateSource: "native_factory_statistics_level_0" } : { research: { currentTechId: 1, currentTechName: "Synthetic research", techQueue: [1, 2], queuedTechCount: 2, techQueueTruncated: false } }) };
		options.mutate?.(name, value, second);
		return { success: true, result: value };
	};
	return c;
}
test("shared telemetry refresh has one flight, complete bound pages, units and a private-data allowlist", async () => {
	let now = 0; const c = fake(), telemetry = new ReadOnlyTelemetry(c, { now: () => now });
	const first = telemetry.refresh(), second = telemetry.refresh(); assert.equal(first, second); await first;
	const snapshot = telemetry.snapshot();
	assert.equal(c.calls.length, 8); assert.equal(snapshot.summary.state, "observed"); assert.equal(snapshot.production.data.planets.length, 2);
	assert.deepEqual(snapshot.summary.data.coverage, { complete: true, returned: 2, total: 2, pages: 2 });
	assert.equal(snapshot.summary.data.planets[0].power.unit, "J/game tick"); assert.equal(snapshot.summary.data.planets[0].power.totalEnergyCapacity, null);
	assert.equal(snapshot.production.data.planets[0].production[0].actualProductionPerMinute, 0);
	for (const value of ["PRIVATE_SAVE_NAME", "PRIVATE_RESUME_CREDENTIAL", "PRIVATE_RELOAD_CREDENTIAL", "world-fixture", "bridge-fixture"]) assert.ok(!JSON.stringify(snapshot).includes(value));
	await telemetry.refresh(); assert.equal(c.calls.length, 8);
	now = 16000; assert.equal(telemetry.snapshot().summary.state, "stale");
	await telemetry.close(); assert.equal(telemetry.snapshot().connected, false); assert.equal(telemetry.snapshot().production.state, "stale");
});
test("menu and restricted sessions issue no production reads and reveal no private world metadata", async () => {
	for (const option of [{ menu: true }, { restricted: true }]) {
		const c = fake(option), telemetry = new ReadOnlyTelemetry(c); await telemetry.refresh();
		assert.equal(c.calls.length, 2); assert.equal(telemetry.snapshot().summary.data, null);
		if (option.restricted) { assert.equal(telemetry.snapshot().summary.state, "restricted"); assert.equal(telemetry.snapshot().session.data.tick, null); assert.equal(telemetry.snapshot().session.data.localPlanetId, null); }
	}
});
test("a world change during collection clears candidate data instead of publishing a mixed snapshot", async () => {
	const telemetry = new ReadOnlyTelemetry(fake({ changeWorld: true })); await telemetry.refresh();
	const snapshot = telemetry.snapshot(); assert.equal(snapshot.summary.data, null); assert.equal(snapshot.production.data, null); assert.equal(snapshot.session.data, null); assert.equal(snapshot.summary.reason, "READ_CONTEXT_CHANGED");
});
test("tick regression or snapshots outside the observed context interval never publish", async () => {
	for (const kind of ["regression", "past", "future"]) {
		const c = fake({ mutate(_name, value) { if (kind === "past") value.capturedAtGameTick = 1199; if (kind === "future") value.capturedAtGameTick = 1201; } }), original = c.read; let reads = 0;
		c.read = async (...args) => { const reply = await original(...args); if (args[0] === "spherewright_get_session_state" && ++reads === 2 && kind === "regression") reply.result.gameTick = 1199; return reply; };
		const telemetry = new ReadOnlyTelemetry(c); await telemetry.refresh();
		assert.equal(telemetry.snapshot().summary.data, null); assert.equal(telemetry.snapshot().production.data, null); assert.equal(telemetry.snapshot().summary.reason, "READ_CONTEXT_TICK_CHANGED");
	}
});
test("repeated cursors, mixed page identity and missing coverage never qualify as complete data", async () => {
	for (const mode of ["cursor", "identity", "coverage"]) {
		const telemetry = new ReadOnlyTelemetry(fake({ mutate(_name, value, second) { if (mode === "cursor") value.nextCursor = "same"; if (mode === "identity" && second) value.snapshotId += "-changed"; if (mode === "coverage") value.totalFactoryCount = 3; } }));
		await telemetry.refresh(); const snapshot = telemetry.snapshot(); assert.equal(snapshot.summary.data, null); assert.equal(snapshot.summary.state, "unavailable"); assert.match(snapshot.summary.reason, /READ_CURSOR_INVALID|READ_PAGE_IDENTITY_CHANGED|READ_PAGE_COVERAGE_MISMATCH/);
	}
});
test("warming and discontinuous windows cannot show zero as measured throughput or theory as actual", async () => {
	for (const state of ["warming_up", "discontinuous"]) {
		const telemetry = new ReadOnlyTelemetry(fake({ window: { state } })); await telemetry.refresh();
		const item = telemetry.snapshot().production.data.planets[0].production[0];
		assert.equal(item.actualProductionPerMinute, null); assert.equal(item.actualConsumptionPerMinute, null); assert.equal(item.utilization, null); assert.equal(item.theoreticalProductionPerMinute, 60); assert.equal(item.theoreticalState, "estimated");
	}
	const unknown = new ReadOnlyTelemetry(fake({ item: { rateSource: "future-source", theoreticalCoverage: "unavailable", producedCount: Number.MAX_SAFE_INTEGER + 1 } })); await unknown.refresh();
	const item = unknown.snapshot().production.data.planets[0].production[0]; assert.equal(item.actualProductionPerMinute, null); assert.equal(item.theoreticalProductionPerMinute, null); assert.equal(item.producedCount, null);
});
test("a ready label without valid inclusive native window evidence cannot qualify actual rates", async () => {
	for (const difference of [{ startGameTick: null }, { startGameTick: Number.MAX_SAFE_INTEGER + 1 }, { startGameTick: 1300 }, { startGameTick: 600 }, { endGameTick: 1199 }, { elapsedGameTicks: 599 }, { elapsedGameSeconds: 9 }]) {
		const telemetry = new ReadOnlyTelemetry(fake({ window: difference })); await telemetry.refresh();
		const item = telemetry.snapshot().production.data.planets[0].production[0]; assert.equal(item.rateState, "unavailable"); assert.equal(item.actualProductionPerMinute, null); assert.equal(item.utilization, null);
	}
});
test("watch changes invalidate in-flight results and late data cannot restore the old selection", async () => {
	let release, entered; const barrier = new Promise((done) => { entered = done; }); let held = false;
	const c = fake({ async before(name) { if (!held && name === "spherewright_get_overseer_summary") { held = true; entered(); await new Promise((done) => { release = done; }); } } });
	const telemetry = new ReadOnlyTelemetry(c), pending = telemetry.refresh(); await barrier;
	telemetry.watch([1001, 1002]); release(); await pending;
	assert.deepEqual(telemetry.snapshot().itemIds, [1001, 1002]); assert.equal(telemetry.snapshot().production.data, null);
	await telemetry.refresh(true); assert.deepEqual(telemetry.snapshot().production.data.requestedItemIds, [1001, 1002]);
	assert.throws(() => telemetry.watch([1, 1]), /INVALID_WATCHED/);
});
test("unsupported read schemas remain unavailable and UI polling does not manufacture game windows", async () => {
	let now = 0; const c = fake({ unsupported: ["spherewright_get_overseer_summary"] }), telemetry = new ReadOnlyTelemetry(c, { now: () => now });
	await telemetry.refresh(); const before = telemetry.snapshot().production.data.window;
	assert.equal(telemetry.snapshot().summary.state, "unsupported"); assert.equal(telemetry.snapshot().summary.data, null);
	for (let index = 0; index < 5; index++) { telemetry.snapshot(); await telemetry.refresh(); }
	assert.equal(c.calls.length, 6); now = 6000; await telemetry.refresh();
	assert.deepEqual(telemetry.snapshot().production.data.window, before);
});
test("the 30-second request-start budget also fences both final context reads", async () => {
	for (const boundary of ["last-page", "final-status"]) {
		let now = 0, statusCalls = 0;
		const c = fake({ before(name, args) {
			if (name === "spherewright_get_status" && ++statusCalls === 2 && boundary === "final-status") now = 30000;
			if (name === "spherewright_get_overseer_production" && args.cursor && boundary === "last-page") now = 30000;
		} });
		const telemetry = new ReadOnlyTelemetry(c, { now: () => now }); await telemetry.refresh();
		assert.equal(c.calls.length, boundary === "last-page" ? 6 : 7); assert.equal(telemetry.snapshot().summary.data, null); assert.equal(telemetry.snapshot().summary.reason, "READ_CYCLE_TIME_LIMIT");
	}
});
