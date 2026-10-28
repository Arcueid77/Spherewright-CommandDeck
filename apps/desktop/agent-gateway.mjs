import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { gatewayLimits, gatewayObservation, gatewayQuery } from "./agent-gateway-contract.mjs";
import { gatewayPipePrefix, gatewayMac, validGatewayMac, decodeGatewayFrame } from "./agent-gateway-wire.mjs";

export class AgentGateway {
	constructor({ snapshot, now = () => performance.now() }) { this.readSnapshot = snapshot; this.now = now; this.server = null; this.binding = null; this.starting = null; this.stopping = null; this.generation = 0; this.sockets = new Set(); this.seen = new Set(); this.reads = 0; this.rejected = 0; this.rateStarted = 0; this.rateRequests = 0; }
	snapshot() { return { enabled: this.binding !== null, busy: Boolean(this.starting || this.stopping), generation: this.generation, reads: this.reads, rejected: this.rejected, activeConnections: this.sockets.size, limits: gatewayLimits, transport: "stdio", readOnly: true, cachedOnly: true }; }
	connection() { if (!this.binding) throw new Error("GATEWAY_DISABLED"); return { ...this.binding }; }
	start() {
		if (process.platform !== "win32") throw new Error("GATEWAY_REQUIRES_WINDOWS");
		if (this.server || this.starting || this.stopping) throw new Error("GATEWAY_ALREADY_OPEN");
		const generation = ++this.generation, binding = { pipe: gatewayPipePrefix + randomUUID(), key: randomBytes(32).toString("hex") };
		this.reads = 0; this.rejected = 0; this.rateStarted = this.now(); this.rateRequests = 0; this.seen.clear();
		const server = createServer(socket => this.#receive(socket, generation, binding)); this.server = server;
		this.starting = new Promise((resolve, reject) => { server.once("error", reject); server.listen(binding.pipe, () => { server.removeListener("error", reject); server.on("error", () => { void this.stop(); }); resolve(); }); })
			.then(async () => { if (generation !== this.generation) throw new Error("GATEWAY_START_CANCELLED"); this.binding = binding; return this.snapshot(); })
			.catch(async error => { if (this.server === server) this.server = null; await new Promise(resolve => server.close(() => resolve())); throw new Error(error.message === "GATEWAY_START_CANCELLED" ? error.message : "GATEWAY_START_FAILED"); })
			.finally(() => { this.starting = null; });
		return this.starting.then(() => this.snapshot());
	}
	stop() {
		if (this.stopping) return this.stopping;
		this.generation++; this.binding = null;
		const socketsClosed = Promise.all([...this.sockets].map(socket => new Promise(resolve => { socket.once("close", resolve); socket.destroy(); })));
		const pending = this.starting, server = this.server;
		this.stopping = (async () => { await pending?.catch(() => {}); if (server) await new Promise(resolve => server.close(() => resolve())); await socketsClosed; if (this.server === server) this.server = null; this.seen.clear(); })().finally(() => { this.stopping = null; });
		return this.stopping.then(() => this.snapshot());
	}
	#receive(socket, generation, binding) {
		if (!this.binding || this.generation !== generation || this.sockets.size >= gatewayLimits.connections) { this.rejected++; socket.destroy(); return; }
		this.sockets.add(socket); socket.on("close", () => this.sockets.delete(socket)); socket.on("error", () => {}); socket.setTimeout(gatewayLimits.timeoutMs, () => socket.destroy());
		let bytes = Buffer.alloc(0), handled = false;
		socket.on("data", chunk => {
			if (handled) { socket.destroy(); return; }
			if (bytes.length + chunk.length > gatewayLimits.requestBytes) { this.rejected++; socket.destroy(); return; }
			bytes = Buffer.concat([bytes, chunk]); const end = bytes.indexOf(10); if (end === -1) return; handled = true;
			let frame;
			try {
				frame = decodeGatewayFrame(bytes.subarray(0, end));
				if (end !== bytes.length - 1 || frame.version !== 1 || Object.keys(frame).sort().join() !== "mac,nonce,query,version" || !validGatewayMac(binding.key, "request", frame, frame.query) || this.seen.has(frame.nonce) || this.generation !== generation || this.binding !== binding) throw new Error();
			} catch { this.rejected++; socket.destroy(); return; }
			this.seen.add(frame.nonce); if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
			let body;
			try {
				if (this.now() - this.rateStarted >= 60000) { this.rateStarted = this.now(); this.rateRequests = 0; }
				if (++this.rateRequests > gatewayLimits.requestsPerMinute) throw new Error("GATEWAY_RATE_LIMIT");
				const query = gatewayQuery(frame.query), result = gatewayObservation(this.readSnapshot(), query); body = { ok: true, result };
				if (Buffer.byteLength(JSON.stringify(body)) > gatewayLimits.responseBytes - 512) throw new Error("GATEWAY_RESPONSE_TOO_LARGE");
				this.reads++;
			} catch (error) { this.rejected++; body = { ok: false, error: ["GATEWAY_INVALID_QUERY", "GATEWAY_SNAPSHOT_CHANGED", "GATEWAY_CACHE_UNAVAILABLE", "GATEWAY_RESPONSE_TOO_LARGE", "GATEWAY_RATE_LIMIT"].includes(error.message) ? error.message : "GATEWAY_CACHE_UNAVAILABLE" }; }
			socket.end(JSON.stringify({ version: 1, nonce: frame.nonce, body, mac: gatewayMac(binding.key, "response", frame.nonce, body) }) + "\n");
		});
	}
}
