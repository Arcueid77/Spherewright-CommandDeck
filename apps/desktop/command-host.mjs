import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, copyFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, isAbsolute } from "node:path";

const files = ["CommandDeck.CommandHost.exe", "CommandDeck.CommandHost.dll", "CommandDeck.CommandHost.deps.json", "CommandDeck.CommandHost.runtimeconfig.json"];
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Run a frozen cohort so a source rebuild cannot replace or lock the helper in use.
export async function prepareCommandHost(source, cache) {
	const bytes = await Promise.all(files.map((name) => readFile(join(source, name))));
	const identity = hash(Buffer.concat(bytes));
	const directory = join(cache, identity);
	await mkdir(directory, { recursive: true });
	for (const [index, name] of files.entries()) {
		const target = join(directory, name);
		try { await copyFile(join(source, name), target, constants.COPYFILE_EXCL); } catch (error) { if (error.code !== "EEXIST") throw error; }
		if (hash(await readFile(target)) !== hash(bytes[index])) throw new Error("COMMAND_HOST_COHORT_CHANGED");
	}
	return { executable: await realpath(join(directory, files[0])), identity };
}

// This manages normal Windows job descendants, not an OS sandbox for arbitrary same-user repository code.
export function runManagedCommand({ host, executable, args = [], cwd, timeoutMs = 180000, signal, onOutput = () => {} }) {
	if (process.platform !== "win32" || !isAbsolute(host) || !isAbsolute(executable) || !isAbsolute(cwd) || !Array.isArray(args) || args.some((value) => typeof value !== "string" || value.length > 8192 || value.includes("\0")) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error("INVALID_MANAGED_COMMAND");
	if (signal?.aborted) return Promise.reject(new Error("COMMAND_CANCELLED_BEFORE_START"));
	const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_?KEY|TOKEN|SECRET|PASSWORD|^PI_|^NODE_OPTIONS$|^ELECTRON_)/i.test(key)));
	return new Promise((resolve, reject) => {
		const child = spawn(host, [], { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		let buffer = "", receipt, created = false, started = false, protocolFailed = false, ownedTermination = false;
		const abort = () => { if (!child.stdin.destroyed) child.stdin.write("cancel\n", () => {}); };
		const fail = () => { protocolFailed = true; abort(); };
		child.stdin.on("error", () => {});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			if (buffer.length > 131072) { buffer = ""; fail(); return; }
			let end;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
				try {
					const message = JSON.parse(line);
					if (receipt) throw new Error("LATE_COMMAND_MESSAGE");
					if (message.type === "created" && !created && message.inJob === true) created = true;
					else if (message.type === "started" && created && !started) started = true;
					else if (message.type === "output" && started && ["stdout", "stderr"].includes(message.stream) && typeof message.text === "string" && message.text.length <= 4096) onOutput({ stream: message.stream, text: message.text });
					else if (message.type === "result" && started && ["exited", "cancelled", "timeout"].includes(message.reason) && Number.isInteger(message.exitCode) && typeof message.treeConfirmed === "boolean" && typeof message.streamsDrained === "boolean") receipt = message;
					else if (message.type === "error" && typeof message.code === "string" && /^[A-Z_]+$/.test(message.code)) receipt = message;
					else throw new Error("INVALID_COMMAND_MESSAGE");
				} catch { fail(); }
			}
		});
		child.stderr.on("data", () => {});
		child.on("error", () => fail());
		const deadline = setTimeout(() => { ownedTermination = true; child.kill(); }, timeoutMs + 15000);
		signal?.addEventListener("abort", abort, { once: true });
		child.stdin.write(JSON.stringify({ executable, arguments: args, directory: cwd, timeoutMs }) + "\n");
		child.on("close", (code) => {
			clearTimeout(deadline); signal?.removeEventListener("abort", abort);
			if (!child.stdin.destroyed) child.stdin.end();
			if (protocolFailed || ownedTermination || !receipt || receipt.type !== "result" || receipt.treeConfirmed !== true || receipt.streamsDrained !== true || code !== 0) {
				const error = new Error(receipt?.type === "error" ? receipt.code : "COMMAND_OUTCOME_UNKNOWN");
				error.unknown = created || started || !receipt?.treeConfirmed;
				reject(error);
			} else resolve({ exitCode: receipt.exitCode, reason: receipt.reason, treeConfirmed: true, streamsDrained: true, outputTruncated: receipt.outputTruncated === true });
		});
	});
}
