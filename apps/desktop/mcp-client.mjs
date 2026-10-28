import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, toNamespacedPath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { researchDefinitions, supportedResearchTool, validResearchArguments, researchPlaybookUri } from "./research-contract.mjs";
import { McpPerformance } from "./mcp-performance.mjs";
import { observationLimits } from "./observation-policy.mjs";

const definitions = {
	spherewright_get_status: {}, spherewright_get_session_state: {},
	spherewright_get_player_state: { sessionId: "string", planetId: "integer" },
	spherewright_get_overseer_summary: { sessionId: "string", limit: "integer", cursor: "string" },
	spherewright_get_overseer_production: { sessionId: "string", itemIds: "array", limit: "integer", cursor: "string" },
};
const required = { spherewright_get_player_state: ["sessionId", "planetId"], spherewright_get_overseer_summary: ["sessionId"], spherewright_get_overseer_production: ["sessionId", "itemIds"] };
const pendingCapacity = 8;
export function supportedReadTool(tool) {
	if (!tool || !Object.hasOwn(definitions, tool.name) || tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true) return false;
	const schema = tool.inputSchema, fields = definitions[tool.name];
	if (schema?.type !== "object" || (schema.required ?? []).some((key) => !Object.hasOwn(fields, key))) return false;
	return Object.entries(fields).every(([key, type]) => schema.properties?.[key]?.type === type && (type !== "array" || schema.properties[key].items?.type === "integer")) && (required[tool.name] ?? []).every((key) => schema.required?.includes(key));
}
function validArguments(name, args) {
	if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((key) => !Object.hasOwn(definitions[name], key))) return false;
	if (required[name] && (typeof args.sessionId !== "string" || !args.sessionId.length || args.sessionId.length > 128)) return false;
	if (name === "spherewright_get_player_state" && (!Number.isSafeInteger(args.planetId) || args.planetId <= 0)) return false;
	if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 16)) return false;
	if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 8192)) return false;
	if (name === "spherewright_get_overseer_production" && (!Array.isArray(args.itemIds) || !args.itemIds.length || args.itemIds.length > 64 || new Set(args.itemIds).size !== args.itemIds.length || !args.itemIds.every((id) => Number.isSafeInteger(id) && id > 0))) return false;
	return true;
}

export async function fingerprintMcp(executable) {
	const path = await realpath(executable), directory = dirname(path);
	if (basename(path).toLowerCase() !== "spherewright.mcp.exe") throw new Error("EXPECTED_SPHEREWRIGHT_MCP_EXECUTABLE");
	const names = (await readdir(directory)).filter((name) => name === basename(path) || /\.dll$/i.test(name) || /\.(?:deps|runtimeconfig)\.json$/i.test(name)).sort();
	if (!names.length || names.length > 256) throw new Error("MCP_COHORT_LIMIT");
	const hash = createHash("sha256"); let bytes = 0;
	for (const name of names) {
		const file = join(directory, name), info = await lstat(file);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 134217728 || (bytes += info.size) > 268435456) throw new Error("MCP_COHORT_INVALID");
		hash.update(name.toLowerCase() + "\0"); hash.update(createHash("sha256").update(await readFile(file)).digest());
	}
	return { path, cohortHash: hash.digest("hex"), fileCount: names.length };
}
export function launchMcp(selection, { descriptorPath, researchAuthority, observation } = {}) {
	const limits = observationLimits(observation);
	if (limits && researchAuthority) throw new Error('OBSERVATION_REQUIRES_READ_ONLY_CLIENT');
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|SPHEREWRIGHT_BRIDGE_DESCRIPTOR)/i.test(key)));
	const startedAt = performance.now();
	const child = spawn(toNamespacedPath(selection.path), descriptorPath ? ["--bridge-descriptor", descriptorPath] : [], { cwd: dirname(selection.path), env, shell: false, windowsHide: true, stdio: "pipe" });
	return new ReadOnlyMcpClient(child, { researchAuthority, startedAt, observation: limits });
}

// Closed read adapter. Research writes require the supervisor's object identity.
export class ReadOnlyMcpClient {
	#pending = new Map(); #sequence = 0; #buffer = ""; #tools = new Map(); #stage = "new"; #discoveryDeadline = Infinity;
	#researchTools = new Set(); #researchAuthority; #hasPlaybook = false;
	#performance;
	#observation; #observationStarted; #observationTools = 0; #observationTimer = null; #stopReason = null;
	constructor(child, { timeoutMs = 12000, discoveryTimeoutMs = 30000, researchAuthority, startedAt, observation } = {}) {
		this.#observation = observationLimits(observation);
		if (this.#observation && researchAuthority) throw new Error('OBSERVATION_REQUIRES_READ_ONLY_CLIENT');
		this.#observationStarted = startedAt ?? performance.now();
		this.#performance = new McpPerformance({ startedAt });
		this.#researchAuthority = researchAuthority && typeof researchAuthority === "object" ? researchAuthority : null;
		this.child = child; this.timeoutMs = timeoutMs; this.discoveryTimeoutMs = discoveryTimeoutMs; this.closed = false; this.exitConfirmed = false;
		this.stats = { requests: 0, toolCalls: 0, duplicateReplies: 0, rejectedCalls: 0 };
		this.exited = new Promise((resolve) => { child.once("exit", () => { this.exitConfirmed = true; this.#performance.endLifetime('exit_observed'); this.#fail("MCP_EXITED"); this.#clearObservationTimer(); resolve(); }); child.once("error", () => { if (!child.pid) { this.exitConfirmed = true; this.#performance.endLifetime('launch_failed'); } this.#fail("MCP_LAUNCH_FAILED"); resolve(); }); });
		const decoder = new StringDecoder("utf8");
		child.stderr.on("data", () => {}); // Never expose raw subprocess diagnostics or descriptor data.
		child.stdout.on("data", (bytes) => {
			if (this.closed) return;
			this.#buffer += decoder.write(bytes);
			if (Buffer.byteLength(this.#buffer) > 2097152) { this.#fail("MCP_FRAME_LIMIT"); return; }
			while (this.#buffer.includes("\n") && !this.closed) {
				const end = this.#buffer.indexOf("\n"), line = this.#buffer.slice(0, end).trim(); this.#buffer = this.#buffer.slice(end + 1);
				if (!line) continue;
				try { this.#receive(JSON.parse(line)); } catch { this.#fail("MCP_INVALID_MESSAGE"); }
			}
		});
		child.stdin.on("error", () => this.#fail("MCP_STDIN_CLOSED"));
		if (this.#observation) this.#observationTimer = setTimeout(() => this.#fail('MCP_OBSERVATION_TIME_LIMIT'), Math.max(0, this.#observation.maxDurationMs - (performance.now() - this.#observationStarted)));
	}
	#clearObservationTimer() { if (this.#observationTimer !== null) clearTimeout(this.#observationTimer); this.#observationTimer = null; }
	#send(message) { if (this.closed) throw new Error("MCP_DISCONNECTED"); this.child.stdin.write(JSON.stringify(message) + "\n", (error) => { if (error) this.#fail("MCP_STDIN_CLOSED"); }); }
	#receive(message) {
		if (!message || message.jsonrpc !== "2.0") throw new Error("MCP_INVALID_MESSAGE");
		if (message.method) {
			if (message.method === "notifications/tools/list_changed") { this.#fail("MCP_CAPABILITIES_CHANGED"); return; }
			if (message.id !== undefined) this.#send({ jsonrpc: "2.0", id: message.id, ...(message.method === "ping" ? { result: {} } : { error: { code: -32601, message: "Client capability unavailable" } }) });
			return;
		}
		const pending = this.#pending.get(message.id);
		if (!pending) { this.stats.duplicateReplies++; return; }
		this.#pending.delete(message.id); clearTimeout(pending.timer);
		message.error ? pending.reject(new Error("MCP_REQUEST_REJECTED")) : pending.resolve(message.result);
		if (this.#observation && this.#observationTools >= this.#observation.maxToolRequests && this.#pending.size === 0) this.#fail('MCP_OBSERVATION_REQUEST_LIMIT');
	}
	#fail(code) {
		if (this.closed) return; this.closed = true;
		this.#stopReason = code;
		this.#clearObservationTimer();
		for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)); }
		this.#pending.clear(); if (!this.exitConfirmed) this.child.kill();
	}
	#request(method, params) {
		if (this.closed || this.#pending.size >= pendingCapacity) return Promise.reject(new Error("MCP_UNAVAILABLE_OR_BUSY"));
		if (this.#observation && (performance.now() - this.#observationStarted >= this.#observation.maxDurationMs || method === 'tools/call' && this.#observationTools >= this.#observation.maxToolRequests)) {
			const reason = performance.now() - this.#observationStarted >= this.#observation.maxDurationMs ? 'MCP_OBSERVATION_TIME_LIMIT' : 'MCP_OBSERVATION_REQUEST_LIMIT'; this.#fail(reason); return Promise.reject(new Error(reason));
		}
		const remaining = this.#stage === "discovering" ? this.#discoveryDeadline - performance.now() : Infinity;
		if (remaining <= 0) return Promise.reject(new Error("MCP_DISCOVERY_TIMEOUT"));
		const id = "deck-read:" + String(++this.#sequence); this.stats.requests++;
		if (this.#observation && method === 'tools/call') this.#observationTools++;
		const finish = this.#performance.begin(method === "tools/call" ? "tool" : method === "resources/read" ? "resource" : "metadata");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.#fail(remaining < this.timeoutMs ? "MCP_DISCOVERY_TIMEOUT" : "MCP_REQUEST_TIMEOUT"), Math.min(this.timeoutMs, remaining));
			this.#pending.set(id, { resolve: value => { finish('responses'); resolve(value); }, reject: error => { finish(error.message === 'MCP_REQUEST_REJECTED' ? 'rpcErrors' : 'aborted'); reject(error); }, timer });
			try { this.#send({ jsonrpc: "2.0", id, method, params }); } catch { this.#fail("MCP_SEND_FAILED"); }
		});
	}
	requestPerformance() { return { ...this.#performance.snapshot(), pendingCapacity, transportClosed: this.closed, transportStopReason: this.#stopReason, duplicateReplies: this.stats.duplicateReplies, rejectedBeforeAdmission: this.stats.rejectedCalls, ...(this.#observation ? { observationLimit: { ...this.#observation, toolRequests: this.#observationTools, remainingToolRequests: this.#observation.maxToolRequests - this.#observationTools, stopReason: this.#stopReason } } : {}) }; }
	async discover() {
		if (this.#stage !== "new") throw new Error("MCP_DISCOVERY_ALREADY_STARTED");
		this.#stage = "discovering";
		this.#discoveryDeadline = performance.now() + this.discoveryTimeoutMs;
		try { return await this.#discoverMetadata(); }
		catch (error) { this.#fail("MCP_DISCOVERY_FAILED"); throw new Error(/^[A-Z_]+$/.test(error?.message) ? error.message : "MCP_DISCOVERY_FAILED"); }
	}
	async #discoverMetadata() {
		const init = await this.#request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Spherewright CommandDeck read-only bridge", version: "0.0.1" } });
		if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(init?.protocolVersion) || typeof init.serverInfo?.version !== "string" || init.serverInfo.version.length > 80) throw new Error("MCP_INITIALIZE_UNSUPPORTED");
		this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
		async function pages(client, method, field) {
			const entries = [], seen = new Set(); let cursor;
			for (let page = 0; page < 16; page++) {
				const value = await client.#request(method, cursor ? { cursor } : {});
				if (!Array.isArray(value?.[field]) || entries.length + value[field].length > 256) throw new Error("MCP_DISCOVERY_LIMIT");
				entries.push(...value[field]);
				if (!value.nextCursor) return entries;
				if (typeof value.nextCursor !== "string" || seen.has(value.nextCursor) || value.nextCursor.length > 8192) throw new Error("MCP_DISCOVERY_CURSOR_INVALID");
				seen.add(value.nextCursor); cursor = value.nextCursor;
			}
			throw new Error("MCP_DISCOVERY_LIMIT");
		}
		const tools = init.capabilities?.tools ? await pages(this, "tools/list", "tools") : [], resources = init.capabilities?.resources ? await pages(this, "resources/list", "resources") : [];
		const names = new Set(), accepted = new Map();
		const research = new Set();
		for (const tool of tools) { if (typeof tool?.name !== "string" || names.has(tool.name)) throw new Error("MCP_DUPLICATE_OR_INVALID_TOOL"); names.add(tool.name); if (supportedReadTool(tool)) accepted.set(tool.name, tool); if (supportedResearchTool(tool)) research.add(tool.name); }
		this.#tools = accepted; this.#stage = "ready";
		this.#researchTools = research; this.#hasPlaybook = resources.filter((value) => value?.uri === researchPlaybookUri).length === 1;
		this.metadata = { protocolVersion: init.protocolVersion, serverVersion: init.serverInfo.version, toolCount: tools.length, resourceCount: resources.length, readTools: [...this.#tools.keys()], researchAvailable: !this.#observation && this.#hasPlaybook && Object.keys(researchDefinitions).every((name) => research.has(name)), schemaHash: createHash("sha256").update(JSON.stringify(tools.map(({ name, inputSchema, annotations }) => ({ name, inputSchema, annotations })))).digest("hex") };
		return this.metadata;
	}
	supports(name) { return !this.closed && this.#stage === "ready" && this.#tools.has(name); }
	async read(name, args = {}) {
		if (!this.supports(name) || !validArguments(name, args)) { this.stats.rejectedCalls++; throw new Error("MCP_READ_NOT_SUPPORTED"); }
		return this.#callTool(name, args);
	}
	researchPort(authority) {
		if (!this.#researchAuthority || authority !== this.#researchAuthority || this.closed || this.#stage !== "ready" || !this.metadata.researchAvailable) throw new Error("TRUSTED_RESEARCH_CAPABILITY_REQUIRED");
		const call = (name, args) => {
			if (this.closed || !this.#researchTools.has(name) || !validResearchArguments(name, args)) { this.stats.rejectedCalls++; return Promise.reject(new Error("RESEARCH_CALL_NOT_SUPPORTED")); }
			return this.#callTool(name, args);
		};
		return Object.freeze({
			progression: (args) => call("spherewright_get_progression_state", args),
			player: (args) => call("spherewright_get_player_state", args),
			prepare: (args) => call("spherewright_prepare_select_research", args),
			commit: (args) => call("spherewright_commit_select_research", args),
			result: (args) => call("spherewright_get_action_result", args),
			playbook: async () => {
				if (this.closed || !this.#hasPlaybook) throw new Error("RESEARCH_PLAYBOOK_UNAVAILABLE");
				const reply = await this.#request("resources/read", { uri: researchPlaybookUri });
				if (!Array.isArray(reply?.contents) || reply.contents.length !== 1 || reply.contents[0].uri !== researchPlaybookUri || typeof reply.contents[0].text !== "string" || !reply.contents[0].text.length || Buffer.byteLength(reply.contents[0].text) > 262144) throw new Error("RESEARCH_PLAYBOOK_INVALID");
				return reply.contents[0].text;
			},
		});
	}
	async #callTool(name, args) {
		this.stats.toolCalls++;
		const reply = await this.#request("tools/call", { name, arguments: args });
		if (reply?.isError !== undefined && typeof reply.isError !== "boolean") throw new Error("MCP_TOOL_ERROR_FLAG_INVALID");
		if (reply?.isError === true) throw new Error("MCP_TOOL_REJECTED");
		if (!reply?.structuredContent || typeof reply.structuredContent !== "object" || Array.isArray(reply.structuredContent)) throw new Error("MCP_STRUCTURED_RESULT_REQUIRED");
		return reply.structuredContent;
	}
	async close() {
		if (!this.#stopReason) this.#stopReason = this.#observation ? 'MCP_OBSERVATION_DISCONNECTED' : 'MCP_DISCONNECTED';
		this.#clearObservationTimer();
		if (!this.closed) { this.closed = true; for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("MCP_DISCONNECTED")); } this.#pending.clear(); this.child.stdin.end(); }
		let timer;
		try { await Promise.race([this.exited, new Promise((done) => { timer = setTimeout(done, 1500); })]); } finally { clearTimeout(timer); }
		if (!this.exitConfirmed) this.child.kill();
		try { await Promise.race([this.exited, new Promise((done) => { timer = setTimeout(done, 1500); })]); } finally { clearTimeout(timer); }
		if (!this.exitConfirmed) throw new Error("MCP_EXIT_NOT_CONFIRMED");
	}
}
