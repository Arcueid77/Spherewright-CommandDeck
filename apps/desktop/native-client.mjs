import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { spawnOwnedUi } from "./owned-ui-process.mjs";
export const nativeExecutable = fileURLToPath(
	new URL("../../artifacts/native/CommandDeck.NativeHost.exe", import.meta.url),
);

export class NativeClient extends EventEmitter {
	constructor(args = [], executable = nativeExecutable) {
		super();
		this.sequence = 0;
		this.pending = new Map();
		this.startupPhases = [];
		const launch =
			args.length === 1 && args[0] === "--fixture" ? spawnOwnedUi : spawn;
		this.child = launch(executable, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.ready = new Promise((resolve, reject) => {
			const finish = (error, metadata) => {
				clearTimeout(timer);
				this.off("ready", onReady);
				this.child.off("error", onError);
				this.child.off("exit", onExit);
				error ? reject(error) : resolve(metadata);
			};
			const onReady = (metadata) => finish(undefined, metadata);
			const onError = () => finish(new Error("NATIVE_HOST_START_FAILED"));
			const onExit = () => finish(new Error("NATIVE_HOST_EXITED"));
			const timer = setTimeout(() => {
				finish(new Error(`NATIVE_HOST_READY_TIMEOUT_${this.startupPhases.join("_") || "NO_PHASE"}`));
				// NativeClient launches only our fixture executable; failed startup must not orphan it.
				this.child.kill();
			}, 30000);
			this.once("ready", onReady);
			this.child.once("error", onError);
			this.child.once("exit", onExit);
		});
		this.ready.catch(() => {}); // The paired fixture may still be awaiting its own readiness.
		this.child.on("error", () => {
			this.stopped = true;
		});
		this.lines = createInterface({ input: this.child.stdout });
		this.lines.on("line", (line) => {
			if (line.length > 32768) return;
			try {
				const message = JSON.parse(line);
				if (message.type === "fixture-startup" && /^[a-z-]+$/.test(message.phase ?? ""))
					this.startupPhases = [...this.startupPhases.slice(-3), message.phase];
				if (message.type === "ready") this.emit("ready", message);
				if (message.type === "fixture-diagnostic")
					this.emit("diagnostic", message);
				if (message.type === "fixture") {
					this.latest = message.state ?? message;
					this.emit("state", this.latest);
				}
				const pending = this.pending.get(message.id);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(message.id);
					message.ok
						? pending.resolve(message.result)
						: pending.reject(new Error(message.code ?? "NATIVE_FAILURE"));
				}
			} catch {}
		});
		this.child.stderr.on("data", () => {});
		this.child.stdin.on("error", () => {});
		this.child.once("exit", () => {
			this.stopped = true;
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("NATIVE_HOST_EXITED"));
			}
			this.pending.clear();
			this.emit("stopped");
		});
	}
	async request(method, args = {}) {
		await this.ready;
		if (this.stopped || !this.child.stdin.writable)
			throw new Error("NATIVE_HOST_STOPPED");
		const id = String(++this.sequence);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("NATIVE_TIMEOUT"));
			}, 5000);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(JSON.stringify({ id, method, ...args }) + "\n");
		});
	}
}
