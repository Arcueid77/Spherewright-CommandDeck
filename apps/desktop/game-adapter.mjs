import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { nativeExecutable } from "./native-client.mjs";

const directory = () => join(process.env.LOCALAPPDATA, "Spherewright", "CommandDeck", "hosts");
const execute = promisify(execFile);
export async function inspectAdapterProcess(descriptor) {
	validate(descriptor);
	const { stdout } = await execute(nativeExecutable, ["--inspect-adapter-process", String(descriptor.gamePid), descriptor.gameStartedTicks, descriptor.kind], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
	return JSON.parse(stdout);
}
function validate(value) {
	if (!value || value.schemaVersion !== 1 || value.adapterVersion !== "0.0.1" ||
		!Number.isSafeInteger(value.gamePid) || value.gamePid < 1 ||
		!["gameStartedTicks", "pipeName", "secret"].every((key) => typeof value[key] === "string") ||
		!/^[0-9]{15,20}$/.test(value.gameStartedTicks) ||
		!/^Spherewright\.CommandDeck\.[a-f0-9]{32}$/.test(value.pipeName) ||
		!/^[A-Za-z0-9+/]{43}=$/.test(value.secret) || !["dsp", "fixture"].includes(value.kind))
		throw new Error("INVALID_ADAPTER_DESCRIPTOR");
	return value;
}
export async function readAdapterDescriptor(path) {
	if ((await stat(path)).size > 4096) throw new Error("ADAPTER_DESCRIPTOR_TOO_LARGE");
	const result = validate(JSON.parse(await readFile(path, "utf8")));
	Object.defineProperty(result, "privatePath", { value: resolve(path) });
	return result;
}
export async function listGameAdapters() {
	let names;
	try { names = (await readdir(directory())).filter((name) => /^[0-9]+-[0-9]+\.json$/.test(name)).slice(0, 32); }
	catch { return []; }
	const entries = await Promise.allSettled(names.map(async (name) => {
		const descriptor = await readAdapterDescriptor(join(directory(), name));
		return { id: `adapter:${name.slice(0, -5)}`, descriptor };
	}));
	return entries.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
}

// This is an authenticated window client, with no process-launch/termination or game-action route.
export class GameAdapterClient extends EventEmitter {
	constructor(descriptor) {
		super();
		this.descriptor = Object.freeze(validate(descriptor));
		this.sequence = 0;
		this.pending = new Map();
		this.buffer = "";
		if (typeof descriptor.privatePath !== "string") throw new Error("PRIVATE_ADAPTER_PATH_REQUIRED");
		this.transport = spawn(nativeExecutable, ["--adapter-client", descriptor.privatePath, String(descriptor.gamePid), descriptor.gameStartedTicks, descriptor.kind, descriptor.pipeName], {
			stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
		});
		this.transport.stdout.setEncoding("utf8");
		this.ready = new Promise((resolve, reject) => {
			this.pending.set("hello", { resolve, reject, timer: setTimeout(() => {
				this.pending.delete("hello"); reject(new Error("ADAPTER_HELLO_TIMEOUT")); this.disconnect();
			}, 12000) });
		});
		this.ready.catch(() => {});
		this.transport.stdout.on("data", (data) => {
			this.buffer += data;
			if (Buffer.byteLength(this.buffer) > 32768) { this.disconnect(); return; }
			let newline;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
				if (Buffer.byteLength(line) > 8192) { this.disconnect(); return; }
				let message;
				try { message = JSON.parse(line); } catch { this.disconnect(); return; }
				const operation = this.pending.get(message.id);
				if (!operation) continue;
				this.pending.delete(message.id); clearTimeout(operation.timer);
				if (!message.ok) {
					const code = typeof message.code === "string" && /^[A-Z_]{1,80}$/.test(message.code) ? `_${message.code}` : "";
					operation.reject(new Error(`ADAPTER_REQUEST_REJECTED${code}`)); continue;
				}
				const value = message.result;
				if (!value || value.gamePid !== descriptor.gamePid || value.gameStartedTicks !== descriptor.gameStartedTicks || value.adapterVersion !== descriptor.adapterVersion || value.kind !== descriptor.kind) {
					operation.reject(new Error("ADAPTER_IDENTITY_MISMATCH")); this.disconnect(); continue;
				}
				this.latest = value;
				operation.resolve(value);
			}
		});
		this.transport.stderr.on("data", (data) => {
			const code = String(data).trim();
			if (/^ADAPTER_TRANSPORT_FAILED(?:_[A-Z_]{1,80})?$/.test(code)) this.transportError = code;
		});
		this.transport.stdin.on("error", () => {});
		this.transport.on("error", () => this.stop());
		this.transport.on("exit", () => this.stop());
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const operation of this.pending.values()) {
			clearTimeout(operation.timer); operation.reject(new Error("ADAPTER_DISCONNECTED" + (this.transportError ? "_" + this.transportError : "")));
		}
		this.pending.clear(); this.emit("stopped");
	}
	async request(method, args = {}) {
		if (!["status", "capture-source", "activate", "adopt", "rect", "detach", "deactivate", "focus-ui"].includes(method))
			throw new Error("WINDOW_METHOD_UNSUPPORTED");
		await this.ready;
		if (this.stopped) throw new Error("ADAPTER_DISCONNECTED");
		const id = String(++this.sequence);
		if (!["status", "capture-source"].includes(method)) this.mayHaveMutated = true;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("ADAPTER_OPERATION_TIMEOUT")); }, 7000);
			this.pending.set(id, { resolve, reject, timer });
			this.transport.stdin.write(JSON.stringify({ ...args, id, method }) + "\n");
		});
	}
	disconnect() { this.transport.stdin.end(); }
}
