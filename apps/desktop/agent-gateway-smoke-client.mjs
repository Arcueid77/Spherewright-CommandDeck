import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// A finite test peer for the copied MCP configuration. No model/game transport.
export class GatewaySmokeClient {
	constructor(config, cwd) {
		const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
		this.child = spawn(config.command, config.args, { cwd, env: { ...inherited, ...config.env }, windowsHide: true, stdio: "pipe" });
		this.pending = new Map(); this.sequence = 0; this.messages = 0; this.stderrBytes = 0; this.failure = null; this.exit = null; let buffer = "";
		this.exited = new Promise(resolve => {
			this.child.once("exit", (code, signal) => { this.exit = { code, signal }; this.fail("GATEWAY_PEER_EXITED"); resolve(this.exit); });
			this.child.once("error", () => { this.exit = { code: null, signal: "launch_failed" }; this.fail("GATEWAY_PEER_LAUNCH_FAILED"); resolve(this.exit); });
		});
		this.child.stdin.on("error", () => this.fail("GATEWAY_PEER_INPUT_FAILED"));
		this.child.stderr.on("data", bytes => { this.stderrBytes += bytes.length; if (this.stderrBytes > 8192) this.fail("GATEWAY_PEER_DIAGNOSTIC_LIMIT"); });
		const decoder = new StringDecoder("utf8");
		this.child.stdout.on("data", bytes => {
			buffer += decoder.write(bytes); if (Buffer.byteLength(buffer) > 1100000) { this.fail("GATEWAY_PEER_OUTPUT_LIMIT"); return; }
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n"), line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
				try {
					const message = JSON.parse(line), pending = this.pending.get(message.id);
					if (message.jsonrpc !== "2.0" || message.method !== undefined || !pending || (message.result === undefined) === (message.error === undefined)) throw new Error();
					this.messages++; this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message);
				} catch { this.fail("GATEWAY_PEER_NON_PROTOCOL_OUTPUT"); }
			}
		});
	}
	fail(code) { this.failure ??= code; for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(code)); } this.pending.clear(); }
	notify(method, params) { if (this.failure) throw new Error(this.failure); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
	request(method, params) {
		if (this.failure || this.pending.size >= 8 || this.sequence >= 64) return Promise.reject(new Error(this.failure ?? "GATEWAY_PEER_REQUEST_LIMIT"));
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("GATEWAY_PEER_REQUEST_TIMEOUT")); }, 5000);
			this.pending.set(id, { resolve, reject, timer }); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}
	async initialize(protocolVersion = "2025-11-25") {
		const reply = await this.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "CommandDeck finite gateway fixture", version: "1" } });
		this.notify("notifications/initialized"); return reply;
	}
	observe(argumentsValue) { return this.request("tools/call", { name: "deck_observe", arguments: argumentsValue }); }
	async close() {
		if (!this.exit) this.child.stdin.end();
		let forced = false; const timer = setTimeout(() => { forced = true; this.child.kill(); }, 5000);
		try { const exit = await this.exited; if (forced || exit.code !== 0 || exit.signal) throw new Error("GATEWAY_PEER_EXIT_UNCONFIRMED"); return { ...exit, protocolReplies: this.messages, stderrBytes: this.stderrBytes }; }
		finally { clearTimeout(timer); }
	}
}
