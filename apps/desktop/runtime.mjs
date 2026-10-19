import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { runPiProbe } from "./pi-probe.mjs";

let controller;
export async function dispatchProbe(command, emit) {
	if (controller) throw new Error("PROBE_ALREADY_RUNNING");
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
