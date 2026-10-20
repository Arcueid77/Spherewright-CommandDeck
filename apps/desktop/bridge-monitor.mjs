import { fingerprintMcp, launchMcp } from "./mcp-client.mjs";
import { ReadOnlyTelemetry } from "./telemetry.mjs";

export class BridgeMonitor {
	constructor({ fingerprint = fingerprintMcp, launch = launchMcp, emit = () => {} } = {}) {
		this.fingerprint = fingerprint; this.launch = launch; this.emit = emit; this.selection = null; this.metadata = null; this.telemetry = null; this.pendingClient = null; this.operation = null; this.closing = false; this.error = null;
	}
	snapshot() { return { busy: Boolean(this.operation), selected: this.selection, metadata: this.metadata, error: this.error, observation: this.telemetry?.snapshot() ?? null }; }
	mutate(action) {
		if (this.closing) return Promise.reject(new Error("BRIDGE_MONITOR_CLOSING"));
		if (this.operation) return Promise.reject(new Error("BRIDGE_CONNECTION_BUSY"));
		this.operation = Promise.resolve().then(action).catch((error) => { this.error = /^[A-Z_]+$/.test(error?.message) ? error.message : "BRIDGE_CONNECTION_FAILED"; throw new Error(this.error); }).finally(() => { this.operation = null; this.emit(); });
		return this.operation;
	}
	select(path) { return this.mutate(async () => { const selection = await this.fingerprint(path); await this.#disconnect(); this.selection = selection; this.metadata = null; this.telemetry = null; this.error = null; await this.#connect(); return this.snapshot(); }); }
	connect() { return this.mutate(async () => { if (this.telemetry?.snapshot().connected) return this.snapshot(); await this.#disconnect(); this.error = null; await this.#connect(); return this.snapshot(); }); }
	disconnect() { return this.mutate(async () => { await this.#disconnect(); return this.snapshot(); }); }
	async #disconnect() {
		if (this.pendingClient) { await this.pendingClient.close(); this.pendingClient = null; }
		if (this.telemetry) await this.telemetry.close();
		// Keep the previous, explicitly stale snapshot. No new process is created until close confirms.
	}
	async #connect() {
		if (!this.selection) throw new Error("SELECT_MCP_EXECUTABLE_FIRST");
		const selection = await this.fingerprint(this.selection.path);
		if (selection.path !== this.selection.path || selection.cohortHash !== this.selection.cohortHash || selection.fileCount !== this.selection.fileCount) throw new Error("MCP_COHORT_CHANGED_RESELECT_REQUIRED");
		if (this.closing) throw new Error("BRIDGE_MONITOR_CLOSING");
		const client = this.launch(selection); this.pendingClient = client;
		try {
			const metadata = await client.discover(), after = await this.fingerprint(selection.path);
			if (after.cohortHash !== selection.cohortHash || after.path !== selection.path || after.fileCount !== selection.fileCount) throw new Error("MCP_COHORT_CHANGED_DURING_START");
			if (this.closing) throw new Error("BRIDGE_MONITOR_CLOSING");
			this.metadata = metadata; this.telemetry = new ReadOnlyTelemetry(client, { emit: this.emit }); this.pendingClient = null;
		} catch (error) { await client.close(); this.pendingClient = null; throw error; }
	}
	poll() { if (this.closing || this.operation || !this.telemetry) return; void this.telemetry.refresh().catch(() => { this.error = "READ_REFRESH_FAILED"; this.emit(); }); }
	refresh() { if (!this.operation && !this.closing) void this.telemetry?.refresh(true).catch(() => {}); return this.snapshot(); }
	watch(itemIds) { if (!this.telemetry || this.operation || this.closing) throw new Error("BRIDGE_OBSERVER_UNAVAILABLE"); this.telemetry.watch(itemIds); this.poll(); return this.snapshot(); }
	resumeAfterCloseFailure() {
		if ((!this.pendingClient || this.pendingClient.exitConfirmed) && (!this.telemetry || this.telemetry.client.exitConfirmed)) this.closing = false;
	}
	async close() { this.closing = true; try { await this.operation; } catch {} try { await this.#disconnect(); } catch { this.error = "MCP_EXIT_NOT_CONFIRMED"; this.emit(); throw new Error(this.error); } }
}
