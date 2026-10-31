import { fingerprintMcp, launchMcp } from "./mcp-client.mjs";
import { ReadOnlyTelemetry } from "./telemetry.mjs";
import { observationLimits } from "./observation-policy.mjs";

export class BridgeMonitor {
	constructor({ fingerprint = fingerprintMcp, launch = launchMcp, emit = () => {}, researchAuthority, observation } = {}) {
		this.fingerprint = fingerprint; this.launch = launch; this.emit = emit; this.selection = null; this.metadata = null; this.telemetry = null; this.pendingClient = null; this.operation = null; this.closing = false; this.error = null;
		this.observation = observationLimits(observation); this.observationStarted = false;
		this.connectionGeneration = 0;
		this.researchAuthority = this.observation ? null : researchAuthority; this.researchLease = null;
	}
	snapshot() { const observation = this.telemetry?.snapshot() ?? null; return { busy: Boolean(this.operation), selected: this.selection, metadata: this.metadata, error: this.error, observation: observation && this.systemPaused ? { ...observation, connected: false } : observation, requestPerformance: (this.pendingClient ?? this.telemetry?.client)?.requestPerformance?.() ?? null, observationPolicy: this.observation, connectionGeneration: this.connectionGeneration, systemPaused: Boolean(this.systemPaused) }; }
	setSystemPaused(paused) { this.systemPaused = paused; if (paused) this.telemetry?.interrupt(); else this.poll(); this.emit(); }
	mutate(action) {
		if (this.systemPaused) return Promise.reject(new Error("SYSTEM_POWER_PAUSED"));
		if (this.closing) return Promise.reject(new Error("BRIDGE_MONITOR_CLOSING"));
		if (this.researchLease) return Promise.reject(new Error("GAME_TASK_OWNS_BRIDGE"));
		return this.#operate(action);
	}
	#operate(action) {
		if (this.operation) return Promise.reject(new Error("BRIDGE_CONNECTION_BUSY"));
		this.operation = Promise.resolve().then(action).catch((error) => { this.error = /^[A-Z_]+$/.test(error?.message) ? error.message : "BRIDGE_CONNECTION_FAILED"; throw new Error(this.error); }).finally(() => { this.operation = null; this.emit(); });
		return this.operation;
	}
	select(path) { return this.mutate(async () => { if (this.observation && this.observationStarted) throw new Error('OBSERVATION_SCOPE_CONSUMED'); const selection = await this.fingerprint(path); await this.#disconnect(); this.selection = selection; this.metadata = null; this.telemetry = null; this.error = null; await this.#connect(); return this.snapshot(); }); }
	connect() { return this.mutate(async () => { if (this.telemetry?.snapshot().connected) return this.snapshot(); await this.#disconnect(); this.error = null; await this.#connect(); return this.snapshot(); }); }
	disconnect() { return this.mutate(async () => { await this.#disconnect(); return this.snapshot(); }); }
	async #disconnect() {
		if (this.pendingClient) { await this.pendingClient.close(); this.pendingClient = null; }
		if (this.telemetry) await this.telemetry.close();
		// Keep the previous, explicitly stale snapshot. No new process is created until close confirms.
	}
	async #connect() {
		if (this.systemPaused) throw new Error("SYSTEM_POWER_PAUSED");
		if (this.observation && this.observationStarted) throw new Error('OBSERVATION_SCOPE_CONSUMED');
		if (!this.selection) throw new Error("SELECT_MCP_EXECUTABLE_FIRST");
		const selection = await this.fingerprint(this.selection.path);
		if (selection.path !== this.selection.path || selection.cohortHash !== this.selection.cohortHash || selection.fileCount !== this.selection.fileCount) throw new Error("MCP_COHORT_CHANGED_RESELECT_REQUIRED");
		if (this.closing || this.systemPaused) throw new Error(this.systemPaused ? "SYSTEM_POWER_PAUSED" : "BRIDGE_MONITOR_CLOSING");
		if (this.observation) this.observationStarted = true;
		const client = this.launch(selection, { researchAuthority: this.researchAuthority, observation: this.observation }); this.connectionGeneration++; this.pendingClient = client;
		try {
			const metadata = await client.discover(), after = await this.fingerprint(selection.path);
			if (after.cohortHash !== selection.cohortHash || after.path !== selection.path || after.fileCount !== selection.fileCount) throw new Error("MCP_COHORT_CHANGED_DURING_START");
			if (this.closing || this.systemPaused) throw new Error(this.systemPaused ? "SYSTEM_POWER_PAUSED" : "BRIDGE_MONITOR_CLOSING");
			this.metadata = metadata; this.telemetry = new ReadOnlyTelemetry(client, { emit: this.emit }); this.pendingClient = null;
		} catch (error) { await client.close(); this.pendingClient = null; throw error; }
	}
	poll() { if (this.systemPaused || this.closing || this.operation || this.researchLease || !this.telemetry) return; void this.telemetry.refresh().catch(() => { this.error = "READ_REFRESH_FAILED"; this.emit(); }); }
	refresh() { if (!this.systemPaused && !this.operation && !this.closing && !this.researchLease) void this.telemetry?.refresh(true).catch(() => {}); return this.snapshot(); }
	acquireResearch(authority) {
		if (this.systemPaused) throw new Error("SYSTEM_POWER_PAUSED");
		if (!this.researchAuthority || authority !== this.researchAuthority || this.closing || this.operation || this.researchLease || !this.telemetry || this.telemetry.client.closed || !this.metadata?.researchAvailable) throw new Error("RESEARCH_BRIDGE_UNAVAILABLE");
		const client = this.telemetry.client; client.researchPort(authority);
		const lease = Object.freeze({ client, selection: this.selection }); this.researchLease = lease; return lease;
	}
	acquireGame(authority) {
		if (this.systemPaused) throw new Error("SYSTEM_POWER_PAUSED");
		if (!this.researchAuthority || authority !== this.researchAuthority || this.closing || this.operation || this.researchLease || !this.telemetry || this.telemetry.client.closed || !this.metadata?.gameAvailable) throw new Error("GAME_BRIDGE_UNAVAILABLE");
		const client = this.telemetry.client; client.gamePort(authority);
		const lease = Object.freeze({ client, selection: this.selection, generic: true }); this.researchLease = lease; return lease;
	}
	reconnectResearch(lease, binding) {
		if (this.systemPaused) return Promise.reject(new Error("SYSTEM_POWER_PAUSED"));
		if (this.closing) return Promise.reject(new Error("BRIDGE_MONITOR_CLOSING"));
		if (!lease || lease !== this.researchLease || this.selection !== lease.selection || !lease.client.closed) return Promise.reject(new Error("ORIGINAL_MCP_RECONNECT_UNAVAILABLE"));
		if (binding?.cohortHash !== lease.selection.cohortHash || binding?.schemaHash !== this.metadata?.schemaHash) return Promise.reject(new Error("ORIGINAL_MCP_COHORT_REQUIRED"));
		// Keep the original lease throughout close/discovery. Ordinary selection,
		// reconnect and polling remain excluded; the old child's exit is confirmed first.
		return this.#operate(async () => {
			await this.#disconnect(); this.error = null; await this.#connect();
			if (this.closing || this.metadata.schemaHash !== binding.schemaHash || !(lease.generic ? this.metadata.gameAvailable : this.metadata.researchAvailable)) {
				await this.#disconnect(); throw new Error(this.closing ? "BRIDGE_MONITOR_CLOSING" : "ORIGINAL_MCP_COHORT_REQUIRED");
			}
			const replacement = Object.freeze({ client: this.telemetry.client, selection: this.selection, recoveryOnly: true, ...(lease.generic ? { generic: true } : {}) });
			this.researchLease = replacement; return replacement;
		});
	}
	releaseResearch(lease) { if (this.researchLease !== lease) throw new Error("RESEARCH_LEASE_MISMATCH"); this.researchLease = null; this.poll(); }
	watch(itemIds) { if (this.systemPaused || !this.telemetry || this.operation || this.closing) throw new Error("BRIDGE_OBSERVER_UNAVAILABLE"); this.telemetry.watch(itemIds); this.poll(); return this.snapshot(); }
	watchMecha(enabled) { if (this.systemPaused || !this.telemetry || this.operation || this.closing || this.researchLease) throw new Error("BRIDGE_OBSERVER_UNAVAILABLE"); this.telemetry.watchMecha(enabled); this.poll(); return this.snapshot(); }
	resumeAfterCloseFailure() {
		if ((!this.pendingClient || this.pendingClient.exitConfirmed) && (!this.telemetry || this.telemetry.client.exitConfirmed)) this.closing = false;
	}
	async close() { this.closing = true; try { await this.operation; } catch {} try { await this.#disconnect(); } catch { this.error = "MCP_EXIT_NOT_CONFIRMED"; this.emit(); throw new Error(this.error); } }
}
