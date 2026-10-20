import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { runPiProbe } from "./pi-probe.mjs";
import { Workbench } from "./workbench.mjs";

let controller, workbench;
export async function dispatchProbe(command, emit) {
	if (controller || workbench?.store.activeTask()) throw new Error("PROBE_ALREADY_RUNNING");
	controller = new AbortController();
	const timer = setTimeout(
		() => controller?.abort(),
		command.mode === "live" ? 90000 : 15000,
	);
	try {
		return await runPiProbe({
			...command,
			signal: controller.signal,
			onEvent: emit,
		});
	} finally {
		clearTimeout(timer);
		controller = undefined;
	}
}
if (process.parentPort) {
	process.parentPort.on("message", async ({ data }) => {
		if (data.type === "workbench" && typeof data.id === "string") {
			try {
				let result;
				if (data.action === "initialize") {
					if (workbench) throw new Error("WORKBENCH_ALREADY_INITIALIZED");
					workbench = new Workbench({ directory: data.args.directory, helperSource: data.args.helperSource, emit: (event) => process.parentPort.postMessage({ type: "event", event }) });
					for (const root of data.args.roots ?? []) if (!workbench.store.roots().some((existing) => existing.path.toLowerCase() === root.path.toLowerCase())) await workbench.add(root);
					result = workbench.state();
				} else {
					if (!workbench) throw new Error("WORKBENCH_NOT_INITIALIZED");
					if (controller && ["agent", "check", "save"].includes(data.action)) throw new Error("PROBE_ALREADY_RUNNING");
					if (data.action === "drain") result = await workbench.drain();
					else if (data.action === "close-store") { await workbench.close(); result = { closed: true }; }
					else if (data.action === "resume-after-close-failure") { workbench.closing = false; result = { resumed: true }; }
					else result = await workbench.request(data.action, data.args);
				}
				process.parentPort.postMessage({ type: "result", id: data.id, result });
			} catch (error) { process.parentPort.postMessage({ type: "error", id: data.id, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : "WORKBENCH_OPERATION_FAILED" }); }
			return;
		}
		if (data.type === "abort") {
			controller?.abort();
			return;
		}
		if (data.type !== "probe" || typeof data.id !== "string") return;
		try {
			const result = await dispatchProbe(data.command, (event) =>
				process.parentPort.postMessage({ type: "event", event }),
			);
			// Session paths are private runtime metadata, never sent to the renderer.
			const { sessionFile, ...safe } = result;
			process.parentPort.postMessage({
				type: "result",
				id: data.id,
				result: safe,
			});
		} catch {
			process.parentPort.postMessage({
				type: "error",
				id: data.id,
				code: "PROBE_FAILED_OR_CANCELLED",
			});
		}
	});
} else if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const live = process.argv.includes("--live");
	const offline = process.argv.includes("--offline");
	if (live === offline)
		throw new Error("Choose exactly one explicit --offline or --live mode.");
	const option = (name) => {
		const index = process.argv.indexOf(name);
		return index < 0 ? undefined : process.argv[index + 1];
	};
	try {
		const result = await dispatchProbe(
			{
				mode: live ? "live" : "offline",
				providerId: option("--provider"),
				modelId: option("--model"),
				storageRoot: join(
					process.cwd(),
					".local",
					"pi-probe",
					live ? "live" : "offline",
				),
			},
			(event) => {
				if (event.type === "text") process.stdout.write(event.text);
			},
		);
		const { sessionFile, events, ...safe } = result;
		console.log("\n" + JSON.stringify(safe));
	} catch {
		console.error(
			"Probe failed. No game calls were made. Inspect the configured protocol/model and retry only after diagnosis.",
		);
		process.exitCode = 1;
	}
}
