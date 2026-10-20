import { createHash } from "node:crypto";

const text = (value, max = 200) => typeof value === "string" && value.length <= max ? value : null;
const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const boolean = (value) => typeof value === "boolean" ? value : null;
const pick = (object, fields, convert = integer) => Object.fromEntries(fields.map((key) => [key, convert(object?.[key])]));
const empty = (reason = "NOT_CONNECTED") => ({ state: "unavailable", reason, data: null, receivedAt: null });
function failure(reply) {
	if (reply?.success === true) return;
	const code = reply?.error?.code;
	throw new Error(["ACCESS_RESTRICTED", "SESSION_NOT_OWNED", "OWNED_WORLD_REQUIRED", "SESSION_MISMATCH"].includes(code) ? "READ_ACCESS_RESTRICTED" : code === "BRIDGE_NOT_READY" ? "BRIDGE_NOT_READY" : "TOOL_READ_FAILED");
}
function session(value) {
	const allowed = value?.ownedBySpherewright === true && value?.accessRestricted === false;
	return { gameLoaded: boolean(value?.gameLoaded), owned: boolean(value?.ownedBySpherewright), accessRestricted: boolean(value?.accessRestricted), gameVersion: text(value?.gameVersion), tick: allowed ? integer(value?.gameTick) : null, localPlanetId: allowed ? integer(value?.localPlanetId) : null, revision: allowed ? integer(value?.revision) : null, writeHealth: text(value?.writeHealth) };
}
function power(value) {
	return { ...pick(value, ["activeNetworkCount", "returnedNetworkCount", "consumerCount", "generatorCount", "totalEnergyRequired", "totalEnergyServed", "totalEnergyCapacity", "totalEnergyGenerated", "totalEnergyStored"]), networkDetailsTruncated: boolean(value?.networkDetailsTruncated), minimumConsumerRatio: number(value?.minimumConsumerRatio), unit: "J/game tick", storageUnit: "J" };
}
function logistics(value) { return pick(value, ["stationCount", "planetaryStationCount", "interstellarStationCount", "collectorCount", "configuredStorageSlotCount", "storedItemCount", "localSupplySlotCount", "localDemandSlotCount", "remoteSupplySlotCount", "remoteDemandSlotCount", "outstandingLocalOrderSlotCount", "outstandingRemoteOrderSlotCount", "outstandingLocalOrderMagnitude", "outstandingRemoteOrderMagnitude", "poweredStationCount", "underpoweredStationCount", "idleDroneCount", "workingDroneCount", "idleVesselCount", "workingVesselCount", "warperCount"]); }
function research(value) {
	return { ...pick(value, ["currentTechId", "currentHashUploaded", "currentHashRequired", "currentHashRemaining", "runtimeTechStateCount", "unlockedTechCount", "queuedTechCount"]), currentTechName: text(value?.currentTechName), techQueueTruncated: boolean(value?.techQueueTruncated), techQueue: Array.isArray(value?.techQueue) ? value.techQueue.slice(0, 64).map(integer) : null };
}
function windowOf(value) {
	return { state: ["warming_up", "ready", "discontinuous"].includes(value?.state) ? value.state : "unavailable", resetReason: text(value?.resetReason), ...pick(value, ["startGameTick", "endGameTick", "elapsedGameTicks"]), ...pick(value, ["elapsedGameSeconds", "wallClockElapsedSeconds", "excludedNonGameSeconds"], number), crossedSessionBoundary: boolean(value?.crossedSessionBoundary) };
}
function production(planet, watched, window, capturedAtGameTick) {
	if (!Array.isArray(planet.production) || planet.production.length > 64) throw new Error("READ_PRODUCTION_SCHEMA_CHANGED");
	const seen = new Set();
	return planet.production.map((item) => {
		if (!watched.includes(item.itemId) || seen.has(item.itemId)) throw new Error("READ_PRODUCTION_SCOPE_CHANGED"); seen.add(item.itemId);
		// This adapter's declared source is the native inclusive 600-tick level-0 window.
		const completeWindow = window.startGameTick !== null && window.endGameTick !== null && window.endGameTick >= window.startGameTick && window.endGameTick - window.startGameTick + 1 === 600 && window.elapsedGameTicks === 600 && window.elapsedGameSeconds === 10 && window.endGameTick === capturedAtGameTick && planet.capturedAtGameTick === capturedAtGameTick;
		const ready = completeWindow && window.state === "ready" && window.crossedSessionBoundary === false && item.rateSource === "native_factory_statistics_level_0" && integer(item.producedCount) !== null && integer(item.consumedCount) !== null && number(item.actualProductionPerMinute) !== null && number(item.actualConsumptionPerMinute) !== null;
		const theory = item.theoreticalRateSource === "current_runtime_component_formula_v1" && ["complete", "partial"].includes(item.theoreticalCoverage) && number(item.theoreticalProductionPerMinute) !== null;
		return { itemId: integer(item.itemId), itemName: text(item.itemName), producedCount: integer(item.producedCount), consumedCount: integer(item.consumedCount), actualProductionPerMinute: ready ? number(item.actualProductionPerMinute) : null, actualConsumptionPerMinute: ready ? number(item.actualConsumptionPerMinute) : null, theoreticalProductionPerMinute: theory ? item.theoreticalProductionPerMinute : null, utilization: ready && theory ? number(item.utilization) : null, rateState: ready ? "observed" : "unavailable", theoreticalState: theory ? "estimated" : "unavailable", rateSource: text(item.rateSource), theoreticalRateSource: text(item.theoreticalRateSource), theoreticalCoverage: text(item.theoreticalCoverage), directDiagnosticCoverage: text(item.directDiagnosticCoverage), findingCount: integer(item.findingCount), findingsTruncated: boolean(item.findingsTruncated), findings: Array.isArray(item.findings) ? item.findings.slice(0, 16).map((finding) => ({ kind: text(finding.kind), confidence: text(finding.confidence), severity: text(finding.severity), objectId: integer(finding.objectId), planetId: integer(finding.planetId) })) : [], unit: "items/min" };
	});
}

export class ReadOnlyTelemetry {
	constructor(client, { now = () => performance.now(), emit = () => {}, intervalMs = 5000, staleMs = 15000 } = {}) {
		this.client = client; this.now = now; this.emit = emit; this.intervalMs = intervalMs; this.staleMs = staleMs;
		this.generation = 0; this.identity = null; this.inFlight = null; this.lastStarted = -Infinity; this.connected = true;
		this.itemIds = [6001, 6002, 6003, 6004]; this.summary = empty(); this.production = empty(); this.bridge = empty(); this.session = empty(); this.events = [];
	}
	snapshot() {
		const qualify = (value) => ({ ...value, state: value.state === "observed" && (!this.connected || this.client.closed || this.now() - value.receivedAt > this.staleMs) ? "stale" : value.state, ageMs: value.receivedAt === null ? null : Math.max(0, this.now() - value.receivedAt) });
		return structuredClone({ connected: this.connected && !this.client.closed, refreshing: Boolean(this.inFlight), itemIds: this.itemIds, bridge: qualify(this.bridge), session: qualify(this.session), summary: qualify(this.summary), production: qualify(this.production), events: this.events, requests: this.client.stats?.toolCalls ?? 0 });
	}
	watch(itemIds) {
		if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 16 || !itemIds.every((id) => Number.isSafeInteger(id) && id > 0) || new Set(itemIds).size !== itemIds.length) throw new Error("INVALID_WATCHED_ITEM_IDS");
		const sorted = [...itemIds].sort((a, b) => a - b);
		if (JSON.stringify(sorted) !== JSON.stringify([...this.itemIds].sort((a, b) => a - b))) { this.generation++; this.itemIds = sorted; this.production = empty("WATCH_CHANGED"); this.lastStarted = -Infinity; }
	}
	#event(reason) { this.events.push({ receivedAt: this.now(), reason }); this.events = this.events.slice(-40); }
	#clearWorld(reason, state = "unavailable") { this.identity = null; this.summary = { ...empty(reason), state }; this.production = { ...empty(reason), state }; }
	refresh(force = false) {
		if (this.inFlight) return this.inFlight;
		if (!this.connected || this.client.closed || this.now() - this.lastStarted < (force ? 1000 : this.intervalMs)) return Promise.resolve(this.snapshot());
		this.lastStarted = this.now();
		const generation = this.generation, watched = [...this.itemIds];
		this.inFlight = this.#cycle(generation, watched).finally(() => { this.inFlight = null; this.emit(); });
		return this.inFlight;
	}
	async #pages(name, activeSession, watched, generation, deadline) {
		if (!this.client.supports(name)) return { ...empty("READ_TOOL_UNSUPPORTED"), state: "unsupported" };
		const planets = [], seenCursors = new Set(), seenPlanets = new Set(); let cursor = "", baseline, pageCount = 0, complete = false;
		for (; pageCount < 32; pageCount++) {
			const reply = await this.#read(name, { sessionId: activeSession, limit: 16, cursor, ...(watched ? { itemIds: watched } : {}) }, generation, deadline); failure(reply);
			const page = reply.result;
			if (!page || page.sessionId !== activeSession || !text(page.snapshotId) || integer(page.capturedAtGameTick) === null || integer(page.totalFactoryCount) === null || !Array.isArray(page.planets) || page.planets.length > 16 || page.returnedFactoryCount !== page.planets.length || !Number.isFinite(Date.parse(page.snapshotExpiresAtUtc))) throw new Error("READ_PAGE_INVALID");
			if (!baseline) baseline = page;
			if (page.snapshotId !== baseline.snapshotId || page.capturedAtGameTick !== baseline.capturedAtGameTick || page.totalFactoryCount !== baseline.totalFactoryCount || page.snapshotExpiresAtUtc !== baseline.snapshotExpiresAtUtc || watched && (JSON.stringify(page.requestedItemIds) !== JSON.stringify(watched) || JSON.stringify(windowOf(page.window)) !== JSON.stringify(windowOf(baseline.window)))) throw new Error("READ_PAGE_IDENTITY_CHANGED");
			if (!watched && JSON.stringify(research(page.research)) !== JSON.stringify(research(baseline.research))) throw new Error("READ_PAGE_IDENTITY_CHANGED");
			for (const planet of page.planets) {
				if (integer(planet.planetId) === null || planet.planetId === 0 || seenPlanets.has(planet.planetId) || integer(planet.capturedAtGameTick) === null) throw new Error("READ_DUPLICATE_OR_INVALID_PLANET");
				seenPlanets.add(planet.planetId);
				planets.push({ planetId: planet.planetId, name: text(planet.planetName), capturedAtGameTick: planet.capturedAtGameTick, isLocalPlanet: boolean(planet.isLocalPlanet), ...(watched ? { production: production(planet, watched, windowOf(page.window), page.capturedAtGameTick) } : { power: power(planet.power), logistics: logistics(planet.logistics) }) });
			}
			if (!page.nextCursor) { complete = true; pageCount++; break; }
			if (typeof page.nextCursor !== "string" || page.nextCursor.length > 8192 || seenCursors.has(page.nextCursor)) throw new Error("READ_CURSOR_INVALID");
			seenCursors.add(page.nextCursor); cursor = page.nextCursor;
		}
		if (planets.length > baseline.totalFactoryCount || complete && planets.length !== baseline.totalFactoryCount) throw new Error("READ_PAGE_COVERAGE_MISMATCH");
		return { state: "observed", reason: complete ? null : "PAGE_LIMIT", receivedAt: this.now(), data: { source: name, scope: "already-created-owned-factories", capturedAtGameTick: baseline.capturedAtGameTick, snapshotId: baseline.snapshotId, expiresAt: baseline.snapshotExpiresAtUtc, coverage: { complete, returned: planets.length, total: baseline.totalFactoryCount, pages: pageCount }, planets, ...(watched ? { requestedItemIds: watched, rateSource: text(baseline.rateSource), window: windowOf(baseline.window) } : { research: research(baseline.research) }) } };
	}
	#read(name, args, generation, deadline) {
		if (generation !== this.generation || !this.connected) throw new Error("READ_CANCELLED");
		if (this.now() >= deadline) throw new Error("READ_CYCLE_TIME_LIMIT");
		return this.client.read(name, args);
	}
	async #context(generation, deadline) {
		if (!this.client.supports("spherewright_get_status") || !this.client.supports("spherewright_get_session_state")) throw new Error("READ_CONTEXT_UNSUPPORTED");
		const status = await this.#read("spherewright_get_status", {}, generation, deadline); failure(status);
		const result = await this.#read("spherewright_get_session_state", {}, generation, deadline); failure(result);
		if (status.status?.bridgeConnected !== true || status.status?.protocolVersion !== 1 || result.result?.bridgeConnected !== true) throw new Error("BRIDGE_PROTOCOL_UNSUPPORTED");
		return { status: status.status, session: result.result };
	}
	async #cycle(generation, watched) {
		const deadline = this.now() + 30000;
		try {
			const initial = await this.#context(generation, deadline); if (generation !== this.generation || !this.connected) return this.snapshot();
			this.bridge = { state: "observed", reason: null, receivedAt: this.now(), data: { pluginVersion: text(initial.status.pluginVersion), protocolVersion: initial.status.protocolVersion, gameVersion: text(initial.status.gameVersion), gameLoaded: boolean(initial.status.gameLoaded), writeHealth: text(initial.status.writeHealth) } };
			this.session = { state: "observed", reason: null, receivedAt: this.now(), data: session(initial.session) };
			if (initial.session.gameLoaded !== true) { this.#clearWorld("MAIN_MENU"); return this.snapshot(); }
			if (initial.session.ownedBySpherewright !== true || initial.session.accessRestricted !== false) { this.#clearWorld("READ_ACCESS_RESTRICTED", "restricted"); return this.snapshot(); }
			if (!text(initial.session.sessionId) || !text(initial.status.bridgeInstanceId) || integer(initial.session.gameTick) === null) throw new Error("READ_CONTEXT_IDENTITY_MISSING");
			const identity = createHash("sha256").update(initial.status.bridgeInstanceId + "\0" + initial.session.sessionId).digest("hex");
			if (this.identity !== identity) { this.#clearWorld("SESSION_CHANGED"); this.identity = identity; }
			const summary = await this.#pages("spherewright_get_overseer_summary", initial.session.sessionId, null, generation, deadline);
			const production = await this.#pages("spherewright_get_overseer_production", initial.session.sessionId, watched, generation, deadline);
			const final = await this.#context(generation, deadline);
			if (generation !== this.generation || !this.connected) return this.snapshot();
			if (final.status.bridgeInstanceId !== initial.status.bridgeInstanceId || final.session.sessionId !== initial.session.sessionId || final.session.gameLoaded !== true || final.session.ownedBySpherewright !== true || final.session.accessRestricted !== false) throw new Error("READ_CONTEXT_CHANGED");
			if (integer(final.session.gameTick) === null || final.session.gameTick < initial.session.gameTick || [summary, production].some((value) => value.data && (value.data.capturedAtGameTick < initial.session.gameTick || value.data.capturedAtGameTick > final.session.gameTick))) throw new Error("READ_CONTEXT_TICK_CHANGED");
			this.summary = summary; this.production = production;
			return this.snapshot();
		} catch (error) {
			if (generation !== this.generation || !this.connected) return this.snapshot();
			const reason = error.message.startsWith("MCP_") ? "MCP_UNAVAILABLE" : /^[A-Z_]+$/.test(error.message) ? error.message : "READ_FAILED";
			if (["READ_ACCESS_RESTRICTED", "READ_CONTEXT_CHANGED", "READ_CONTEXT_TICK_CHANGED"].includes(reason)) { this.#clearWorld(reason, reason === "READ_ACCESS_RESTRICTED" ? "restricted" : "unavailable"); this.session = empty(reason); }
			else { for (const key of ["summary", "production", "bridge", "session"]) this[key] = { ...this[key], state: this[key].data ? "stale" : reason === "READ_CONTEXT_UNSUPPORTED" ? "unsupported" : "unavailable", reason }; }
			this.#event(reason); return this.snapshot();
		}
	}
	async close() { this.connected = false; this.generation++; await this.client.close(); await this.inFlight; }
}
