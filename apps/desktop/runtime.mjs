import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { runPiProbe } from "./pi-probe.mjs";
import { Workbench } from "./workbench.mjs";
import { randomUUID } from "node:crypto";

let controller, workbench, gameController, gameTaskId;
const credentialPending = new Map();
const gameReadPending = new Map();
function resolveProfile(task, signal, taskType = "development") {
	if (!process.parentPort || signal.aborted) return Promise.reject(new Error("PROTECTED_PROFILE_UNAVAILABLE"));
	const id = "credential:" + randomUUID();
	return new Promise((resolve, reject) => {
		const finish = (profile, code) => {
			credentialPending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", abort);
			code ? reject(new Error(code)) : resolve(profile);
		};
		const abort = () => finish(null, "DEVELOPMENT_TASK_CANCELLED"), timer = setTimeout(() => finish(null, "PROTECTED_PROFILE_TIMEOUT"), 10000);
		credentialPending.set(id, finish); signal.addEventListener("abort", abort, { once: true });
		process.parentPort.postMessage({ type: "credential-request", id, taskId: task.id, providerId: task.provider, modelId: task.model, taskType });
	});
}
function gameObservation(taskId, signal) {
	if (!process.parentPort || signal.aborted) return Promise.reject(new Error("GAME_MODEL_STOPPED"));
	const id = "game-read:" + randomUUID();
	return new Promise((resolve, reject) => {
		const finish = (value, code) => { gameReadPending.delete(id); clearTimeout(timer); signal.removeEventListener("abort", abort); code ? reject(new Error(code)) : resolve(value); };
		const abort = () => finish(null, "GAME_MODEL_STOPPED"), timer = setTimeout(() => finish(null, "GAME_OBSERVATION_TIMEOUT"), 25000);
		gameReadPending.set(id, finish); signal.addEventListener("abort", abort, { once: true });
		process.parentPort.postMessage({ type: "game-read-request", id, taskId });
	});
}
export async function dispatchProbe(command, emit) {
	if (controller || workbench?.configurationBlocked || workbench && !workbench.gameWritesFrozen || workbench?.store.activeTask()) throw new Error("PROBE_ALREADY_RUNNING");
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
		if (data.type === "game-read-response") { gameReadPending.get(data.id)?.(data.value, data.ok === true ? null : "GAME_OBSERVATION_UNAVAILABLE"); return; }
		if (data.type === "abort-game") { if (gameTaskId === data.taskId) gameController?.abort(); return; }
		if (data.type === "game-planner") {
			if (gameController || controller || !workbench || workbench.gameWritesFrozen || workbench.closing) { process.parentPort.postMessage({ type: "error", id: data.id, code: "GAME_RUNTIME_NOT_RESERVED" }); return; }
			gameController = new AbortController(); gameTaskId = data.command.task.id; const active = gameController;
			const timer = setTimeout(() => active.abort(), 300000);
			try {
				const { runGamePlanner } = await import("./game-agent.mjs");
				const result = await runGamePlanner({ ...data.command, signal: active.signal, observe: () => gameObservation(gameTaskId, active.signal), event: (kind, value) => process.parentPort.postMessage({ type: "game-planner-event", taskId: gameTaskId, kind, value }), resolveProfile: (task, signal) => resolveProfile(task, signal, "game") });
				process.parentPort.postMessage({ type: "result", id: data.id, result });
			} catch (error) { process.parentPort.postMessage({ type: "error", id: data.id, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : "GAME_MODEL_FAILED" }); }
			finally { clearTimeout(timer); gameController = null; gameTaskId = null; }
			return;
		}
		if (data.type === "credential-response") {
			credentialPending.get(data.id)?.(data.profile, data.ok === true ? null : "PROTECTED_PROFILE_UNAVAILABLE");
			return;
		}
		if (data.type === "workbench" && typeof data.id === "string") {
			try {
				let result;
				if (data.action === "initialize") {
					if (workbench) throw new Error("WORKBENCH_ALREADY_INITIALIZED");
					workbench = new Workbench({ directory: data.args.directory, helperSource: data.args.helperSource, resolveProfile, emit: (event) => process.parentPort.postMessage({ type: "event", event }) });
					for (const root of data.args.roots ?? []) if (!workbench.store.roots().some((existing) => existing.path.toLowerCase() === root.path.toLowerCase())) await workbench.add(root);
					result = workbench.state();
				} else {
					if (!workbench) throw new Error("WORKBENCH_NOT_INITIALIZED");
					if (controller && ["agent", "check", "save"].includes(data.action)) throw new Error("PROBE_ALREADY_RUNNING");
					if (data.action === "game-begin") {
						if (gameController || controller || workbench.configurationBlocked || workbench.closing || workbench.operation || workbench.store.activeTask() || workbench.store.ui("execution-blocked")) throw new Error("DEVELOPMENT_RUNTIME_BUSY");
						workbench.gameWritesFrozen = false; workbench.admissionGeneration++; result = { locked: true };
					} else if (data.action === "game-end") { if (gameController) throw new Error("GAME_RUNTIME_NOT_DRAINED"); workbench.gameWritesFrozen = true; workbench.admissionGeneration++; result = { unlocked: true }; }
					else if (data.action === "configuration-begin") {
						if (controller || !workbench.gameWritesFrozen || workbench.closing || workbench.operation || workbench.store.activeTask()) throw new Error("MODEL_CONFIGURATION_BUSY");
						workbench.configurationBlocked = true; workbench.admissionGeneration++; result = { locked: true };
					} else if (data.action === "configuration-end") { workbench.configurationBlocked = false; result = { unlocked: true }; }
					else if (data.action === "drain") result = await workbench.drain();
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
			gameController?.abort();
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
