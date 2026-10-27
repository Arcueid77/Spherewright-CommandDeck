const codeOf = error => /^[A-Z0-9_]{1,96}$/.test(error?.message) ? error.message : "SYSTEM_POWER_CHECK_FAILED";

// Power events invalidate admission, not the durable identity of in-flight work.
export class PowerLifecycle {
	constructor({ quiesce, check, restore, notify = () => {}, now = () => performance.now() }) {
		this.quiesce = quiesce; this.check = check; this.restore = restore; this.notify = notify; this.now = now;
		this.phase = "ready"; this.generation = 0; this.error = null; this.wakeObserved = false; this.disposed = false;
		this.drain = Promise.resolve({ ok: true }); this.draining = false; this.operation = null; this.watchdogAfter = 0;
	}
	snapshot() { return { phase: this.phase, generation: this.generation, draining: this.draining, error: this.error, canRetry: !this.disposed && this.phase === "blocked" && this.wakeObserved && !this.operation }; }
	get ready() { return !this.disposed && this.phase === "ready"; }
	watchdogUnavailable() { return !this.ready || this.now() < this.watchdogAfter; }
	#emit() { if (!this.disposed) this.notify(this.snapshot()); }
	#drain(generation) {
		this.draining = true;
		try { this.drain = Promise.resolve(this.quiesce()).then(() => ({ ok: true }), error => ({ ok: false, code: codeOf(error) })); }
		catch (error) { this.drain = Promise.resolve({ ok: false, code: codeOf(error) }); }
		const drain = this.drain;
		void drain.then(() => { if (this.disposed || generation !== this.generation || drain !== this.drain) return; this.draining = false; this.#emit(); });
	}
	suspend() {
		if (this.disposed || this.phase === "suspended") return;
		this.generation++; this.phase = "suspended"; this.error = null; this.wakeObserved = false;
		this.#drain(this.generation); this.#emit();
	}
	wake() {
		if (this.disposed) return Promise.resolve(this.snapshot());
		if (this.phase === "ready") this.suspend(); // Also invalidate when only resume was delivered.
		this.wakeObserved = true;
		return this.#check();
	}
	deferWake() {
		if (this.disposed) return;
		this.wakeObserved = true;
		if (this.phase !== "ready") { this.phase = "blocked"; this.error = "SYSTEM_WAKE_CHECK_DEFERRED"; }
		this.#emit();
	}
	retry() {
		if (this.disposed || !this.wakeObserved || this.phase === "suspended") throw new Error("SYSTEM_WAKE_NOT_OBSERVED");
		if (this.operation?.generation === this.generation) return this.operation.promise;
		if (this.phase === "ready") return Promise.resolve(this.snapshot());
		this.#drain(this.generation); return this.#check();
	}
	#check() {
		if (this.operation?.generation === this.generation) return this.operation.promise;
		const generation = this.generation, current = () => !this.disposed && this.generation === generation && this.phase === "checking";
		this.phase = "checking"; this.error = null;
		const record = { generation, promise: null }; this.operation = record;
		record.promise = (async () => {
			try {
				const drained = await this.drain; if (!current()) return;
				if (!drained.ok) throw new Error(drained.code);
				await this.check(current); if (!current()) return;
				await this.restore(current); if (!current()) return;
				this.phase = "ready"; this.watchdogAfter = this.now() + 1000;
			} catch (error) { if (current()) { this.phase = "blocked"; this.error = codeOf(error); } }
			finally { if (this.operation === record) { this.operation = null; this.#emit(); } }
			return this.snapshot();
		})();
		this.#emit(); return record.promise;
	}
	assertAction(action, args) {
		if (this.ready) return;
		if (["status", "snapshot", "targets", "profiles", "viewport", "focus-ui", "close", "detach", "abort", "resume-system", "diagnostics-preview", "diagnostics-begin-save", "diagnostics-write", "diagnostics-cancel-save", "diagnostics-discard"].includes(action)) return;
		if (action === "workbench" && ["state", "task", "ui-get", "ui-save", "list", "read", "diff", "change-diff", "read-reference", "search", "checks"].includes(args?.action)) return;
		if (action === "bridge" && args?.action === "snapshot" || action === "game" && ["snapshot", "stop"].includes(args?.action) || action === "profiles-manage" && ["list", "describe"].includes(args?.action)) return;
		throw new Error("SYSTEM_POWER_PAUSED");
	}
	dispose() { this.disposed = true; this.generation++; }
}

export function bindPowerMonitor(monitor, lifecycle, active = () => true) {
	const suspend = () => lifecycle.suspend();
	const resume = () => { if (active()) void lifecycle.wake(); else lifecycle.deferWake(); };
	monitor.on("suspend", suspend); monitor.on("resume", resume);
	return () => { monitor.removeListener("suspend", suspend); monitor.removeListener("resume", resume); lifecycle.dispose(); };
}
