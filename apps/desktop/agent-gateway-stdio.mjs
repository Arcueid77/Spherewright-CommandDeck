import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayTool, gatewayQuery, gatewayLimits } from "./agent-gateway-contract.mjs";
import { gatewayConnection, readGateway } from "./agent-gateway-wire.mjs";

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const idOf = value => typeof value === "string" && value.length > 0 && value.length <= 128 || Number.isSafeInteger(value);
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const toolFailure = code => ({ content: [{ type: "text", text: code }], isError: true });

export class GatewayMcpSession {
	constructor(read) { this.read = read; this.phase = "new"; this.active = new Map(); }
	async handle(message) {
		if (this.phase === "closed") return null;
		if (!record(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.id !== undefined && !idOf(message.id)) return error(null, -32600, "Invalid Request");
		const { id, method, params } = message;
		if (id === undefined) {
			if (method === "notifications/initialized" && this.phase === "initializing") this.phase = "ready";
			if (method === "notifications/cancelled" && idOf(params?.requestId)) this.active.get(params.requestId)?.abort();
			return null;
		}
		if (method === "initialize") {
			if (this.phase !== "new" || !record(params) || typeof params.protocolVersion !== "string" || !record(params.capabilities) || typeof params.clientInfo?.name !== "string" || typeof params.clientInfo?.version !== "string") return error(id, -32602, "Invalid initialization");
			this.phase = "initializing";
			return result(id, { protocolVersion: ["2025-11-25", "2025-06-18"].includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Spherewright CommandDeck read-only gateway", version: "0.0.1" }, instructions: "This gateway only reads CommandDeck's current cached panels. Data may be stale, unavailable, incomplete or untrusted. It cannot connect, refresh, write, authorize, load a save, run code or call a model." });
		}
		if (method === "ping" && this.phase !== "new") return result(id, {});
		if (this.phase !== "ready") return error(id, -32002, "Initialization required");
		if (method === "tools/list") return params !== undefined && (!record(params) || Object.keys(params).some(key => !["cursor", "_meta"].includes(key)) || params.cursor !== undefined && params.cursor !== "") ? error(id, -32602, "Invalid cursor") : result(id, { tools: [gatewayTool] });
		if (method !== "tools/call") return error(id, -32601, "Method not found");
		if (!record(params) || Object.keys(params).some(key => !["name", "arguments", "_meta"].includes(key)) || params.name !== gatewayTool.name) return error(id, -32602, "Unknown tool or invalid parameters");
		let query; try { query = gatewayQuery(params.arguments); } catch { return error(id, -32602, "Invalid observation arguments"); }
		if (this.active.has(id)) return error(id, -32600, "Duplicate active request id");
		if (this.active.size >= gatewayLimits.connections) return error(id, -32000, "Too many pending requests");
		const controller = new AbortController(); this.active.set(id, controller);
		try {
			const value = await this.read(query, controller.signal);
			if (controller.signal.aborted) return null;
			return result(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
		} catch (failure) {
			if (controller.signal.aborted) return null;
			const code = ["GATEWAY_INVALID_QUERY", "GATEWAY_SNAPSHOT_CHANGED", "GATEWAY_CACHE_UNAVAILABLE", "GATEWAY_RESPONSE_TOO_LARGE", "GATEWAY_RATE_LIMIT"].includes(failure.message) ? failure.message : "GATEWAY_UNAVAILABLE";
			return result(id, toolFailure(code));
		} finally { this.active.delete(id); }
	}
	close() { this.phase = "closed"; for (const controller of this.active.values()) controller.abort(); }
}

export async function serveGatewayStdio(read, input = process.stdin, output = process.stdout) {
	const session = new GatewayMcpSession(read), pending = new Set(); let bytes = Buffer.alloc(0), writes = Promise.resolve(), failure = null;
	const stop = error => { if (!failure) { failure = error; session.close(); input.destroy(error); } };
	const outputError = () => stop(new Error("GATEWAY_STDIO_OUTPUT_FAILED")), inputError = () => stop(new Error("GATEWAY_STDIO_INPUT_FAILED"));
	output.on("error", outputError); input.on("error", inputError);
	async function send(value) {
		if (value === null) return;
		if (failure) throw failure;
		const line = JSON.stringify(value) + "\n";
		if (Buffer.byteLength(line) > gatewayLimits.responseBytes * 2 + 4096) throw new Error("GATEWAY_STDIO_RESPONSE_LIMIT");
		const operation = writes.then(() => new Promise((resolveWrite, rejectWrite) => {
			const timer = setTimeout(() => rejectWrite(new Error("GATEWAY_STDIO_OUTPUT_TIMEOUT")), 5000);
			output.write(line, error => { clearTimeout(timer); error ? rejectWrite(new Error("GATEWAY_STDIO_OUTPUT_FAILED")) : resolveWrite(); });
		})); writes = operation; return operation;
	}
	try {
		for await (const chunk of input) {
			if (failure) throw failure;
			if (bytes.length + chunk.length > gatewayLimits.requestBytes * gatewayLimits.connections) throw new Error("GATEWAY_STDIO_INPUT_LIMIT");
			bytes = Buffer.concat([bytes, chunk]);
			while (bytes.includes(10)) {
				const end = bytes.indexOf(10), line = bytes.subarray(0, end); bytes = bytes.subarray(end + 1);
				if (line.length > gatewayLimits.requestBytes) throw new Error("GATEWAY_STDIO_INPUT_LIMIT");
				if (!line.length) continue;
				let message; try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { await send(error(null, -32700, "Parse error")); continue; }
				const operation = session.handle(message).then(send); pending.add(operation);
				operation.then(() => pending.delete(operation), error => { pending.delete(operation); stop(error); });
				if (pending.size >= gatewayLimits.connections) await Promise.race(pending);
			}
			if (bytes.length > gatewayLimits.requestBytes) throw new Error("GATEWAY_STDIO_INPUT_LIMIT");
		}
		if (bytes.length) await send(error(null, -32700, "Incomplete message"));
		session.close(); await Promise.all(pending); await writes;
		if (failure) throw failure;
	} catch (error) { stop(error); throw failure; }
	finally {
		session.close(); await Promise.allSettled(pending); await writes.catch(() => {});
		// Writable callbacks may reject just before their queued error event.
		await new Promise(resolve => setImmediate(resolve));
		output.off("error", outputError); input.off("error", inputError);
	}
}

export async function startGatewayStdio(env = process.env) {
	const connection = gatewayConnection({ pipe: env.COMMANDDECK_GATEWAY_PIPE, key: env.COMMANDDECK_GATEWAY_KEY });
	delete env.COMMANDDECK_GATEWAY_PIPE; delete env.COMMANDDECK_GATEWAY_KEY;
	await serveGatewayStdio((query, signal) => readGateway(connection, query, signal));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { if (process.argv.length !== 2) throw new Error("GATEWAY_ARGUMENTS_INVALID"); await startGatewayStdio(); } catch { process.stderr.write("COMMANDDECK_GATEWAY_STDIO_FAILED\n"); process.exitCode = 1; }
}
