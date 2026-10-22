const kinds = ['metadata', 'tool', 'resource'];
const counts = () => ({ started: 0, responses: 0, rpcErrors: 0, aborted: 0 });
const capacity = 128;

// Client-local monotonic measurements. No arguments, payloads, names or identities are retained.
export class McpPerformance {
	#now; #start; #basis; #end = null; #endState = null; #samples = []; #pending = 0; #peak = 0;
	#counts = Object.fromEntries(kinds.map(kind => [kind, counts()]));
	constructor({ now = () => performance.now(), startedAt } = {}) { this.#now = now; this.#start = startedAt ?? now(); this.#basis = startedAt === undefined ? 'client_attachment' : 'launch_request'; }
	begin(kind) {
		if (!kinds.includes(kind) || this.#end !== null) throw new Error('MCP_MEASUREMENT_CLOSED');
		const started = this.#now(), counters = this.#counts[kind];
		counters.started++; this.#pending++; this.#peak = Math.max(this.#peak, this.#pending);
		let ended = false;
		return outcome => {
			if (ended) return;
			if (!['responses', 'rpcErrors', 'aborted'].includes(outcome)) throw new Error('MCP_MEASUREMENT_OUTCOME_INVALID');
			ended = true; counters[outcome]++; this.#pending--;
			const finished = this.#now();
			this.#samples.push({ kind, started, finished, duration: Math.max(0, finished - started) });
			if (this.#samples.length > capacity) this.#samples.shift();
		};
	}
	endLifetime(state) {
		if (this.#end !== null) return;
		if (!['exit_observed', 'launch_failed'].includes(state)) throw new Error('MCP_MEASUREMENT_END_INVALID');
		this.#end = this.#now(); this.#endState = state;
	}
	snapshot() {
		const now = this.#now();
		const timing = samples => {
			if (!samples.length) return { sampleCount: 0, windowDurationMs: null, lastCompletedAgeMs: null, durationMs: null };
			const durations = samples.map(value => value.duration).sort((a, b) => a - b), last = Math.max(...samples.map(value => value.finished));
			return { sampleCount: samples.length, windowDurationMs: Math.max(0, last - Math.min(...samples.map(value => value.started))), lastCompletedAgeMs: Math.max(0, now - last), durationMs: { meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length, p95Ms: durations[Math.ceil(durations.length * 0.95) - 1], maxMs: durations.at(-1) } };
		};
		const byKind = Object.fromEntries(kinds.map(kind => [kind, { ...this.#counts[kind], ...timing(this.#samples.filter(value => value.kind === kind)) }]));
		const total = kinds.reduce((sum, kind) => { for (const key of Object.keys(sum)) sum[key] += this.#counts[kind][key]; return sum; }, counts());
		return { version: 1, source: 'mcp_client_monotonic_v1', scope: 'this-client', sampleCapacity: capacity, ...total, pending: this.#pending, peakPending: this.#peak, ...timing(this.#samples), byKind,
			lifetime: { state: this.#endState ?? 'running', basis: this.#basis, durationMs: Math.max(0, (this.#end ?? now) - this.#start), endedAgeMs: this.#end === null ? null : Math.max(0, now - this.#end) } };
	}
}
