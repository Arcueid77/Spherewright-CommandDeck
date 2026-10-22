type Delivery = { id: number; requested: number; received: number; epoch: number };
type RpcSample = { requested: number; ended: number; duration: number };
type FrameSample = { requested: number; ended: number; commit: number; nextFrame: number; total: number };
type Options = { now?: () => number; requestFrame?: (callback: () => void) => number; cancelFrame?: (handle: number) => void; visible?: boolean };
const capacity = 128;
function statistics(values: number[]) {
	if (!values.length) return null;
	const sorted = values.slice().sort((a, b) => a - b);
	return { meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted[sorted.length - 1] };
}

// One renderer's readonly snapshot path. No payloads or cross-process timestamps are retained.
export class UiPerformance {
	#now; #requestFrame; #cancelFrame; #visible; #epoch = 0; #sequence = 0;
	#delivery: Delivery | null = null; #frame: number | null = null;
	#rpc: RpcSample[] = []; #frames: FrameSample[] = [];
	#counts = { started: 0, received: 0, failed: 0, discarded: 0, pending: 0, hiddenOrTransition: 0, coalesced: 0, interrupted: 0, frameUnavailable: 0, frames: 0 };
	constructor({ now = () => performance.now(), requestFrame = callback => requestAnimationFrame(callback), cancelFrame = handle => cancelAnimationFrame(handle), visible = true }: Options = {}) {
		this.#now = now; this.#requestFrame = requestFrame; this.#cancelFrame = cancelFrame; this.#visible = visible;
	}
	setVisible(visible: boolean) {
		if (visible === this.#visible) return;
		this.#visible = visible; this.#epoch++; this.interrupt();
	}
	#drop(reason: 'interrupted' | 'coalesced') {
		if (!this.#delivery) return;
		this.#counts[reason]++; this.#delivery = null;
		if (this.#frame !== null) { try { this.#cancelFrame(this.#frame); } catch { this.#counts.frameUnavailable++; } this.#frame = null; }
	}
	interrupt() { this.#drop('interrupted'); }
	beginSnapshot() {
		const requested = this.#now(), epoch = this.#epoch, visible = this.#visible;
		this.#counts.started++; this.#counts.pending++;
		let settled = false;
		const finish = (outcome: 'received' | 'failed' | 'discarded') => {
			if (settled) return false;
			settled = true; this.#counts.pending--; this.#counts[outcome]++; return true;
		};
		return {
			failed: () => { finish('failed'); }, discarded: () => { finish('discarded'); },
			received: () => {
				if (!finish('received')) return null;
				if (!visible || !this.#visible || epoch !== this.#epoch) { this.#counts.hiddenOrTransition++; return null; }
				const received = this.#now();
				this.#rpc.push({ requested, ended: received, duration: Math.max(0, received - requested) });
				if (this.#rpc.length > capacity) this.#rpc.shift();
				this.#drop('coalesced');
				this.#delivery = { id: ++this.#sequence, requested, received, epoch };
				return this.#delivery.id;
			},
		};
	}
	committed(id: number) {
		const delivery = this.#delivery;
		if (!delivery || delivery.id !== id || this.#frame !== null || !this.#visible || delivery.epoch !== this.#epoch) return;
		const committed = this.#now();
		try {
			this.#frame = this.#requestFrame(() => {
				if (this.#delivery !== delivery) return;
				this.#frame = null;
				if (!this.#visible || delivery.epoch !== this.#epoch) { this.interrupt(); return; }
				const ended = this.#now(); this.#delivery = null; this.#counts.frames++;
				this.#frames.push({ requested: delivery.requested, ended, commit: Math.max(0, committed - delivery.received), nextFrame: Math.max(0, ended - committed), total: Math.max(0, ended - delivery.requested) });
				if (this.#frames.length > capacity) this.#frames.shift();
			});
		} catch { this.#counts.frameUnavailable++; this.#delivery = null; this.#frame = null; }
	}
	snapshot() {
		const now = this.#now();
		const windowOf = (samples: { requested: number; ended: number }[]) => ({ sampleCount: samples.length, windowDurationMs: samples.length ? Math.max(0, Math.max(...samples.map(value => value.ended)) - Math.min(...samples.map(value => value.requested))) : null, latestAgeMs: samples.length ? Math.max(0, now - Math.max(...samples.map(value => value.ended))) : null });
		return { version: 1, source: 'renderer_snapshot_frame_v1', scope: 'this-ui', sampleCapacity: capacity, visible: this.#visible, ...this.#counts,
			rpc: { ...windowOf(this.#rpc), durationMs: statistics(this.#rpc.map(value => value.duration)) },
			frame: { ...windowOf(this.#frames), commitMs: statistics(this.#frames.map(value => value.commit)), nextFrameMs: statistics(this.#frames.map(value => value.nextFrame)), totalMs: statistics(this.#frames.map(value => value.total)) } };
	}
}
export type UiPerformanceSnapshot = ReturnType<UiPerformance['snapshot']>;
