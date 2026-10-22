import { app, utilityProcess, safeStorage } from "electron";
import { EventEmitter, once } from "node:events";
import { mkdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { WindowHost } from "./window-host.mjs";
import { spawnOwnedUi, registerOwnedUi } from "./owned-ui-process.mjs";
import { publicProfiles } from "./profiles.mjs";
import { runDesktopSmoke } from "./desktop-smoke.mjs";
import { inspectOwnedUi } from "./inspect-ui.mjs";
import { runAdapterDesktopSmoke } from "./adapter-desktop-smoke.mjs";
import { runWorkbenchSmoke } from "./workbench-smoke.mjs";
import { createUiWatchdog } from "./ui-watchdog.mjs";
import { CredentialVault, protectedProvider } from "./credential-vault.mjs";
import { resolveTaskProfile } from "./profile-access.mjs";
import { BridgeMonitor } from "./bridge-monitor.mjs";
import { bridgeFixtureOptions, runBridgeSmoke } from "./bridge-smoke.mjs";
import { settleShutdown } from "./shutdown-drain.mjs";
import { GameTasks } from "./game-tasks.mjs";
import { gameFixtureOptions, runGameSmoke } from "./game-smoke.mjs";
import { observationArguments, assertObservationAction } from "./observation-policy.mjs";
import { runObservationSmoke } from "./observation-smoke.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const smoke = process.argv.includes("--smoke");
const observationPolicy = observationArguments(process.argv);
const watchdogMs = 1000;
const privateDirectory = join(app.getPath("userData"), "supervisor");
mkdirSync(privateDirectory, { recursive: true });
app.setPath("userData", privateDirectory); // The disposable UI keeps its original, separate Chromium profile.
const vault = new CredentialVault(join(privateDirectory, ...(smoke ? ["vault-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID] : []), "profiles.vault.json"), {
	available: () => process.platform === "win32" && safeStorage.isEncryptionAvailable(),
	encrypt: (text) => safeStorage.encryptStringAsync(text), decrypt: async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result,
});
let changingProfiles = false;
function externalProfiles() { try { return publicProfiles().filter((profile) => !protectedProvider(profile.providerId)).map((profile) => ({ ...profile, source: "external" })); } catch { return []; } }
const native = new WindowHost();
const events = new EventEmitter();
const researchAuthority = {}, gameApprovalAuthority = {};
const gameSmoke = smoke && process.argv.includes("--smoke-game");
const bridge = new BridgeMonitor({ ...(gameSmoke ? gameFixtureOptions(root, process.env.COMMANDDECK_SMOKE_RUN_ID) : smoke && (process.argv.includes("--smoke-bridge") || process.argv.includes("--smoke-observation")) ? bridgeFixtureOptions(root, process.env.COMMANDDECK_SMOKE_RUN_ID) : {}), researchAuthority, observation: observationPolicy, emit: () => emit({ type: "bridge-changed" }) });
const game = new GameTasks({ directory: join(privateDirectory, smoke ? "game-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID : "game"), bridge, researchAuthority, approvalAuthority: gameApprovalAuthority, syntheticOnly: gameSmoke,
	freezeDevelopment: async () => { if (!workbenchReady || changingProfiles || state.busy) throw new Error("DEVELOPMENT_RUNTIME_BUSY"); await workbenchCall("game-begin"); },
	releaseDevelopment: () => workbenchCall("game-end"), planner: runGamePlanner, emit: () => emit({ type: "game-changed" }),
});
let bridgeTimer;
const runtimePending = new Map(),
	tests = new Map();
const lifecycle = [];
let lifecycleWrite = Promise.resolve();
function recordUiLifecycle(value) {
	lifecycle.push({ utc: new Date().toISOString(), ...value });
	if (lifecycle.length > 40) lifecycle.shift();
	const snapshot = JSON.stringify(lifecycle, null, 2);
	lifecycleWrite = lifecycleWrite.then(() => writeFile(join(privateDirectory, "ui-lifecycle.private.json"), snapshot)).catch(() => {});
}
let runtime,
	workbenchReady = false,
	ui,
	watchdog,
	epoch = 0,
	probeSequence = 0,
	testSequence = 0,
	restarts = 0;
let recovering = false,
	stopping = false,
	allowQuit = false;
const state = {
	busy: false,
	currentProbeToolFinished: false,
	probeText: "",
	lastProbeResult: null,
	layoutMode: smoke && !process.argv.includes("--smoke-workbench") && !process.argv.includes("--smoke-bridge") && !process.argv.includes("--smoke-observation") && !gameSmoke ? "m0" : "development",
	events: [],
};
const safeEnvironment = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key),
		),
	);
function send(record, message) {
	if (!record?.child.connected) return;
	try {
		record.child.send(message, () => {});
	} catch {}
}
function emit(event) {
	if (event.type === "text")
		state.probeText = (state.probeText + event.text).slice(-32768);
	else state.events = [...state.events.slice(-39), event];
	send(ui, { type: "event", event });
}
function workbenchCall(action, args = {}) {
	const id = "workbench:" + String(++testSequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { runtimePending.delete(id); reject(new Error("WORKBENCH_RESPONSE_TIMEOUT")); }, 25000);
		runtimePending.set(id, { resolve, reject, timer });
		runtime.postMessage({ type: "workbench", id, action, args });
	});
}
function runGamePlanner(command) {
	const id = "game-planner:" + randomUUID(), { signal, observe, event, ...data } = command;
	return new Promise((resolve, reject) => {
		const abort = () => runtime?.postMessage({ type: "abort-game", taskId: data.task.id });
		const finish = (value, error) => { signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
		const timer = setTimeout(() => { runtimePending.delete(id); abort(); finish(null, new Error("GAME_RUNTIME_RESPONSE_TIMEOUT")); }, 310000);
		runtimePending.set(id, { timer, resolve: (value) => finish(value), reject: (error) => finish(null, error) });
		signal.addEventListener("abort", abort, { once: true });
		runtime.postMessage({ type: "game-planner", id, command: { ...data, directory: join(privateDirectory, smoke ? "game-agent-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID : "game-agent") } });
		if (signal.aborted) abort();
	});
}
async function probe(config) {
	if (
		!config ||
		!["offline", "live"].includes(config.mode) ||
		state.busy ||
		changingProfiles ||
		[...runtimePending.keys()].some((id) => !id.startsWith("workbench:"))
	)
		throw new Error("INVALID_OR_BUSY_PROBE");
	if (
		config.mode === "live" &&
		!publicProfiles().some(
			(p) => p.providerId === config.providerId && p.modelId === config.modelId,
		)
	)
		throw new Error("MODEL_NOT_CONFIGURED");
	const id = String(++probeSequence);
	const storageRoot = join(
		privateDirectory,
		"m0-probes",
		id + "-" + Date.now(),
	);
	state.busy = true;
	state.currentProbeToolFinished = false;
	state.probeText = "";
	state.lastProbeResult = null;
	emit({ type: "probe-state", busy: true });
	try {
		await mkdir(storageRoot, { recursive: true });
		if (stopping) throw new Error("SUPERVISOR_CLOSING");
		const result = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				runtimePending.delete(id);
				runtime.postMessage({ type: "abort" });
				reject(new Error("PROBE_TIMEOUT"));
			}, 100000);
			runtimePending.set(id, { resolve, reject, timer });
			runtime.postMessage({
				type: "probe",
				id,
				command: {
					mode: config.mode,
					providerId: config.providerId,
					modelId: config.modelId,
					storageRoot,
					secondLegDelayMs: smoke && config.mode === "offline" ? 2500 : 0,
				},
			});
		});
		state.lastProbeResult = result;
		emit({ type: "probe-result", result });
		return result;
	} finally {
		state.busy = false;
		emit({ type: "probe-state", busy: false });
	}
}
async function api(action, args, source) {
	assertObservationAction(observationPolicy, action, args);
	if (ui?.nativeProbePending && ["viewport", "focus-ui"].includes(action)) return { deferred: true };
	if (ui?.nativeProbePending && ["attach", "start-fixture", "probe"].includes(action)) throw new Error("UI_NATIVE_OPERATION_PENDING");
	if (stopping && ["viewport", "focus-ui"].includes(action))
		return { deferred: true };
	if (
		stopping &&
		!["close", "status", "profiles", "targets", "snapshot"].includes(action)
	)
		throw new Error("SUPERVISOR_CLOSING");
	const recoveryRead = action === "workbench" && ["state", "task", "ui-get", "list", "read", "diff", "change-diff", "read-reference", "search", "checks"].includes(args?.action) || ["bridge", "game"].includes(action) && args?.action === "snapshot";
	if (
		recovering && !recoveryRead &&
		![
			"status",
			"profiles",
			"targets",
			"snapshot",
			"viewport",
			"abort",
		].includes(action)
	)
		throw new Error("UI_RECOVERY_PENDING");
	if (action === "snapshot") return { ...state, events: [...state.events] };
	if (action === "game") {
		if (!args || !["snapshot", "start", "stop", "reconcile", "reprepare", "catalog"].includes(args.action)) throw new Error("INVALID_GAME_ACTION");
		if (args.action === "snapshot") return { ...game.snapshot(), readOnlyObservation: Boolean(observationPolicy) };
		if (ui?.nativeProbePending || !workbenchReady) throw new Error("GAME_RUNTIME_UNAVAILABLE");
		if (args.action === "catalog") return game.catalog();
		if (args.action === "start") return game.start(args.args);
		if (args.action === "stop") return game.stop();
		if (args.action === "reprepare") return game.reprepare();
		return game.reconcile(args.args?.intentId);
	}
	if (action === "game-confirmation" || action === "game-confirmed") {
		if (source !== ui || !source?.registered || ui?.nativeProbePending) throw new Error("TRUSTED_USER_APPROVAL_REQUIRED");
		if (action === "game-confirmation") return game.confirmation(args?.taskId, source.epoch);
		return game.confirm(gameApprovalAuthority, args?.nonce, source.epoch);
	}
	if (action === "bridge-select") {
		if (typeof args !== "string" || !isAbsolute(args) || args.length > 4096 || args.includes("\0")) throw new Error("INVALID_MCP_SELECTION");
		if (observationPolicy) {
			if (!workbenchReady || state.busy || game.operation || game.snapshot().unresolved.length) throw new Error('OBSERVATION_REQUIRES_SETTLED_RUNTIME');
			const work = await workbenchCall('state');
			if (work.activeTask || work.executionBlocked || game.operation || game.snapshot().unresolved.length) throw new Error('OBSERVATION_REQUIRES_SETTLED_RUNTIME');
		}
		return bridge.select(args);
	}
	if (action === "bridge") {
		if (!args || !["snapshot", "refresh", "watch", "disconnect", "connect"].includes(args.action)) throw new Error("INVALID_BRIDGE_ACTION");
		if (args.action === "snapshot") return bridge.snapshot();
		if (args.action === "refresh") return bridge.refresh();
		if (args.action === "watch") return bridge.watch(args.args?.itemIds);
		if (args.action === "disconnect") return bridge.disconnect();
		return bridge.connect();
	}
	if (action === "workbench") {
		if (!workbenchReady || !args || !["state", "add", "refresh", "grants", "list", "read", "diff", "change-diff", "attach-reference", "read-reference", "search", "save", "revert", "checks", "check", "task", "cancel", "ui-get", "ui-save", "agent"].includes(args.action)) throw new Error("INVALID_WORKBENCH_ACTION");
		if (ui?.nativeProbePending && ["add", "grants", "save", "revert", "check", "agent", "attach-reference"].includes(args.action)) throw new Error("UI_NATIVE_OPERATION_PENDING");
		if (changingProfiles && ["agent", "check", "save", "revert"].includes(args.action)) throw new Error("MODEL_CONFIGURATION_BUSY");
		const result = await workbenchCall(args.action, args.args ?? {});
		return observationPolicy && args.action === 'state' ? { ...result, observationOnly: true, executionBlocked: true } : result;
	}
	if (action === "profiles") {
		let profiles = []; try { profiles = (await vault.list()).profiles; } catch {}
		return [...externalProfiles(), ...profiles];
	}
	if (action === "profiles-manage") {
		if (!args || !["list", "describe", "save", "remove"].includes(args.action)) throw new Error("INVALID_PROFILE_ACTION");
		if (args.action === "list") {
			if (!vault.available()) return { available: false, revision: null, profiles: [], external: externalProfiles() };
			return { ...await vault.list(), external: externalProfiles() };
		}
		if (args.action === "describe") return vault.describe(args.args?.id);
		if (ui?.nativeProbePending || changingProfiles || state.busy || !workbenchReady) throw new Error("MODEL_CONFIGURATION_BUSY");
		changingProfiles = true;
		try {
			await workbenchCall("configuration-begin");
			if (stopping) throw new Error("SUPERVISOR_CLOSING");
			const result = args.action === "save" ? await vault.save(args.args ?? {}) : await vault.remove(args.args ?? {});
			emit({ type: "profiles-changed" }); return result;
		} finally { await workbenchCall("configuration-end").catch(() => {}); changingProfiles = false; }
	}
	if (action === "status") return native.request("status");
	if (action === "targets") return native.request("list");
	if (action === "start-fixture") return native.request("start-fixture");
	if (action === "attach") {
		if (typeof args !== "string" || args.length > 200)
			throw new Error("INVALID_TARGET");
		return native.request("attach", { targetId: args });
	}
	if (action === "detach") return native.request("detach");
	if (action === "focus-ui") return native.request("focus-ui");
	if (action === "viewport") {
		if (
			!args ||
			!["x", "y", "width", "height"].every(
				(key) => typeof args[key] === "number" && Number.isFinite(args[key]),
			) ||
			typeof args.visible !== "boolean"
		)
			throw new Error("INVALID_VIEWPORT");
		return native.request("rect", args);
	}
	if (action === "probe") return probe(args);
	if (action === "abort") {
		runtime.postMessage({ type: "abort" });
		return { requested: true };
	}
	if (action === "close") {
		await shutdown();
		return { closed: true };
	}
	throw new Error("UNKNOWN_SUPERVISOR_ACTION");
}
async function attachFromCommandLine(args) {
	const index = args.indexOf("--attach-adapter");
	if (index < 0) return false;
	const target = args[index + 1];
	if (typeof target !== "string" || !/^adapter:[0-9]+-[0-9]+$/.test(target))
		throw new Error("INVALID_ADAPTER_TARGET");
	await api("attach", target);
	emit({ type: "native-state", text: "已按本次启动参数嵌入选定窗口；游戏任务需在独立面板发起。" });
	if (args.includes("--window-probe")) {
		const first = await api("status");
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const last = await api("status");
		const proof = {
			target, first, last,
			updatesAdvance: Number.isSafeInteger(last.unityUpdateSequence) && last.unityUpdateSequence > first.unityUpdateSequence,
			renderSizeAvailable: last.renderWidth > 0 && last.renderHeight > 0,
			gameWorldCalls: 0, physicalInput: "not_tested", renderedPixels: "not_tested",
		};
		await mkdir(join(root, ".local"), { recursive: true });
		await writeFile(join(root, ".local/m0-window-runtime.private.json"), JSON.stringify(proof, null, 2));
		// Explicit, bounded window diagnostics. No focus changes or operation replay.
		void (async () => {
			const samples = [], started = Date.now(), observedAdapter = native.adapter;
			for (let sample = 0; sample < 120 && !stopping; sample++) {
				await new Promise((resolve) => setTimeout(resolve, 1000));
				if (stopping || native.adapter !== observedAdapter) break;
				const observedState = await api("status");
				if (native.adapter !== observedAdapter) break;
				samples.push({ elapsedMs: Date.now() - started, state: observedState });
				await writeFile(join(root, ".local/m0-window-observations.private.json"), JSON.stringify({ target, startedUtc: new Date(started).toISOString(), samples }, null, 2));
			}
		})().catch(() => {});
	}
	return true;
}
function clearUiTests(record) {
	for (const [id, operation] of tests)
		if (operation.epoch === record.epoch) {
			clearTimeout(operation.timer);
			operation.reject(new Error("UI_REPLACED"));
			tests.delete(id);
		}
}
function startUi() {
	const args = [root, "--managed-ui", ...(smoke ? ["--smoke-ui"] : []), ...(gameSmoke ? ["--smoke-game-ui"] : [])];
	const child = spawnOwnedUi(process.execPath, args, {
		cwd: root,
		env: safeEnvironment(),
		windowsHide: false,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	const record = {
		child,
		lease: registerOwnedUi(child),
		epoch: ++epoch,
		loaded: 0,
		registered: false,
		lastHeartbeat: performance.now(),
		lastBeatSequence: 0,
	};
	ui = record;
	child.stdout.on("data", () => {});
	child.stderr.on("data", (data) => {
		if (smoke) process.stderr.write(data);
	});
	record.ready = new Promise((resolve, reject) => {
		record.resolveReady = resolve;
		record.rejectReady = reject;
		record.startupTimer = setTimeout(
			() => reject(new Error("UI_STARTUP_TIMEOUT")),
			15000,
		);
	});
	record.ready.catch(() => {});
	child.on("message", (message) => {
		if (record !== ui || !message || typeof message !== "object") return;
		if (message.type === "ui-ready") {
			if (
				record.registered ||
				message.pid !== child.pid ||
				typeof message.hwnd !== "string" ||
				!/^[1-9][0-9]{0,19}$/.test(message.hwnd)
			) {
				record.rejectReady(new Error("UI_REGISTRATION_REJECTED"));
				return;
			}
			record.registered = true;
			record.hwnd = message.hwnd;
			native.bindUi({ pid: child.pid, hwnd: message.hwnd });
			send(record, { type: "registered" });
		} else if (
			message.type === "ui-heartbeat" &&
			Number.isSafeInteger(message.sequence) &&
			message.sequence > record.lastBeatSequence
		) {
			record.lastBeatSequence = message.sequence;
			record.lastHeartbeat = performance.now();
			record.nativeResponsiveSince = undefined;
			record.nativeDelayReported = false;
			record.nativeProbePending = false;
			record.nativeProbeUnknowns = 0;
		} else if (message.type === "ui-loaded" && record.registered) {
			record.loaded++;
			record.lastHeartbeat = performance.now();
			clearTimeout(record.startupTimer);
			record.resolveReady(record);
			events.emit("ui-loaded", record);
		} else if (
			message.type === "request" &&
			record.registered &&
			typeof message.id === "string" &&
			message.id.length < 50
		) {
			void api(message.action, message.args, record).then(
				(result) =>
					send(record, { type: "response", id: message.id, ok: true, result }),
				(error) =>
					send(record, {
						type: "response",
						id: message.id,
						ok: false,
						code: /^[A-Z0-9_]+$/.test(error.message)
							? error.message
							: "SUPERVISOR_OPERATION_FAILED",
					}),
			);
		} else if (message.type === "test-result" && smoke) {
			const operation = tests.get(message.id);
			if (operation?.epoch === record.epoch) {
				tests.delete(message.id);
				clearTimeout(operation.timer);
				message.ok
					? operation.resolve(message.result)
					: operation.reject(new Error(message.code));
			}
		} else if (message.type === "test-event" && smoke)
			events.emit(message.name, {
				...message,
				receivedAt: performance.now(),
				epoch: record.epoch,
			});
	});
	child.on("error", () => record.rejectReady(new Error("UI_LAUNCH_FAILED")));
	child.on("exit", () => {
		clearTimeout(record.startupTimer);
		clearUiTests(record);
		if (!record.loaded) record.rejectReady(new Error("UI_EXITED_BEFORE_READY"));
		else if (!stopping && !recovering && record === ui)
			void recoverUi("unexpected-exit").catch(recoveryFailed);
	});
	return record.ready;
}
async function waitNativeDetached() {
	const deadline = performance.now() + 5000;
	while (true) {
		const status = await native.request("status");
		if (!status.attached && !status.uiOperationPending) return status;
		if (performance.now() > deadline)
			throw new Error("NATIVE_RECOVERY_DID_NOT_SETTLE");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
async function recoverUi(reason, expected = ui) {
	if (stopping || recovering || expected !== ui) return;
	recovering = true;
	const old = ui;
	game.invalidateUi(old.epoch);
	const heartbeatAgeMs = performance.now() - old.lastHeartbeat;
	recordUiLifecycle({ kind: "recovery", reason, epoch: old.epoch, heartbeatAgeMs, exited: old.child.exitCode !== null || old.child.signalCode !== null, nativeProbe: old.lastNativeProbe });
	clearUiTests(old);
	let exitResult;
	if (old.child.exitCode === null && old.child.signalCode === null) {
		const exited = once(old.child, "exit");
		if (!old.lease.terminate())
			throw new Error("OWNED_UI_TERMINATION_NOT_SUBMITTED");
		exitResult = await withDeadline(
			exited,
			3000,
			"OWNED_UI_EXIT_NOT_CONFIRMED",
		);
	}
	const exitConfirmedAt = performance.now();
	// Never wait for the blocked UI thread/gate before terminating our own UI creation handle.
	const recoveredNative = await waitNativeDetached();
	native.bindUi(undefined);
	const record = {
		reason,
		heartbeatAgeMs,
		nativeProbe: old.lastNativeProbe,
		oldEpoch: old.epoch,
		exitConfirmed: true,
		exitResult,
		exitConfirmedAt,
		nativeRecoveredAt: performance.now(),
		native: recoveredNative,
	};
	if (++restarts > 1) {
		emit({
			type: "notice",
			text: "界面已再次失去响应，自动重启已停止；宿主未重新启动。",
		});
		events.emit("recovery-limit", record);
		return;
	}
	await startUi();
	recovering = false;
	emit({
		type: "native-state",
		text: "界面已重新创建，沿用原连接与 Pi；没有重放任务。请核窗口状态后重新嵌入。",
	});
	events.emit("recovered", { ...record, newEpoch: ui.epoch });
}
function recoveryFailed() {
	emit({
		type: "notice",
		text: "界面恢复未能核销，自动重试已停止；未启动第二个宿主或重放任务。",
	});
	// Keep the recovery gate closed instead of authorizing a new attachment after an unknown result.
	events.emit("recovery-failed");
}
async function nativeStopped() {
	emit({ type: "native-state", text: "窗口宿主连接已结束；未重启游戏。" });
	const record = ui;
	if (stopping || recovering || !record?.registered) return;
	try {
		const state = await inspectOwnedUi(record);
		if (
			state.exists &&
			state.pidMatches &&
			state.visible &&
			!state.childStyle &&
			!state.parentPresent
		)
			return;
	} catch {}
	if (!stopping && !recovering && record === ui)
		await recoverUi("native-host-exit");
}
async function withDeadline(promise, ms, code) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(code)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
function testCommand(name, extra = {}) {
	if (!smoke) throw new Error("SMOKE_ONLY");
	const record = ui,
		id = String(++testSequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			tests.delete(id);
			reject(new Error("UI_TEST_TIMEOUT"));
		}, 110000);
		tests.set(id, { resolve, reject, timer, epoch: record.epoch });
		send(record, { type: "test", id, name, ...extra });
	});
}
async function shutdown(exitCode = 0) {
	if (stopping) return;
	stopping = true;
	clearInterval(bridgeTimer);
	runtime?.postMessage({ type: "abort" });
	try {
		// Drain game first so its retained original action can still use the same connection.
		await settleShutdown([() => game.drain(), () => workbenchReady ? workbenchCall("drain") : Promise.resolve()]);
		await bridge.close();
		await native.request("detach");
		await native.request("close");
	} catch (error) {
		if (exitCode === 0) {
			stopping = false;
			bridge.resumeAfterCloseFailure(); bridgeTimer = setInterval(() => bridge.poll(), 1000);
			if (workbenchReady) await workbenchCall("resume-after-close-failure").catch(() => {});
			await game.resumeAfterCloseFailure().catch(() => {});
			throw error;
		}
		// Only the test-created simulator can be cleaned up here. The DSP client has no child/kill route.
		if (smoke && native.fixture && !native.fixture.stopped)
			native.fixture.child.kill();
	}
	clearInterval(watchdog);
	if (ui?.child.exitCode === null && ui?.child.signalCode === null) {
		const exited = once(ui.child, "exit");
		send(ui, { type: "allow-close" });
		try {
			await withDeadline(exited, 3000, "UI_CLOSE_TIMEOUT");
		} catch {
			ui.lease.terminate();
			await withDeadline(exited, 3000, "UI_EXIT_TIMEOUT");
		}
	}
	await vault.tail;
	game.close();
	if (workbenchReady) { await workbenchCall("close-store"); workbenchReady = false; }
	await lifecycleWrite;
	runtime?.kill();
	allowQuit = true;
	app.exit(exitCode);
}
if (!app.requestSingleInstanceLock()) {
	allowQuit = true;
	if (smoke) {
		console.error("SMOKE_INSTANCE_ALREADY_RUNNING");
		app.exit(1);
	} else app.quit();
} else {
	app.on("second-instance", (_event, args) => {
		if (args.includes("--quit")) {
			void shutdown().catch(() => {});
			return;
		}
		if (args.includes("--attach-adapter")) {
			void attachFromCommandLine(args).catch(() => emit({ type: "notice", text: "本次窗口连接未通过，原状态保留，未自动重试。" }));
			return;
		}
		if (
			recovering &&
			restarts > 1 &&
			(ui.child.exitCode !== null || ui.child.signalCode !== null)
		) {
			void startUi()
				.then(() => {
					recovering = false;
					emit({
						type: "notice",
						text: "已按重新打开工作台的操作创建界面，未重启宿主或重放任务。",
					});
				})
				.catch(recoveryFailed);
		} else send(ui, { type: "focus" });
	});
	app.on("before-quit", (event) => {
		if (!allowQuit) {
			event.preventDefault();
			void shutdown().catch(() => {});
		}
	});
	app
		.whenReady()
		.then(async () => {
			recordUiLifecycle({ kind: "supervisor-start" });
			const env = safeEnvironment();
			env.PI_OFFLINE = "1";
			runtime = utilityProcess.fork(
				fileURLToPath(new URL("./runtime.mjs", import.meta.url)),
				[],
				{
					env,
					cwd: root,
					stdio: "pipe",
					serviceName: "CommandDeck Pi runtime",
				},
			);
			runtime.stdout.on("data", () => {});
			runtime.stderr.on("data", () => {});
			runtime.on("message", (message) => {
				if (message.type === "game-read-request") {
					void (async () => { try { if (typeof message.id !== "string" || !/^game-read:[0-9a-f-]{36}$/.test(message.id)) throw new Error("INVALID_GAME_READ"); const value = await game.observeForModel(message.taskId); runtime.postMessage({ type: "game-read-response", id: message.id, ok: true, value }); } catch { runtime.postMessage({ type: "game-read-response", id: message.id, ok: false }); } })().catch(() => {});
					return;
				}
				if (message.type === "game-planner-event") { try { game.plannerEvent(message.taskId, message.kind, message.value); } catch { runtime.postMessage({ type: "abort-game", taskId: message.taskId }); } return; }
				if (message.type === "credential-request") {
					void (async () => {
						try {
							if (stopping || changingProfiles || !workbenchReady || typeof message.id !== "string" || !/^credential:[0-9a-f-]{36}$/.test(message.id)) throw new Error("PROTECTED_PROFILE_REQUEST_REJECTED");
							const profile = await resolveTaskProfile(vault, (taskId) => message.taskType === "game" ? game.profileTask(taskId) : workbenchCall("task", { taskId }), message);
							if (stopping || changingProfiles || !workbenchReady) throw new Error("PROTECTED_PROFILE_REQUEST_REJECTED");
							runtime.postMessage({ type: "credential-response", id: message.id, ok: true, profile });
						} catch { runtime.postMessage({ type: "credential-response", id: message.id, ok: false }); }
					})().catch(() => {});
					return;
				}
				if (
					message.type === "event" &&
					message.event.type === "tool_execution_end"
				)
					state.currentProbeToolFinished = true;
				if (message.type === "event") emit(message.event);
				const operation = runtimePending.get(message.id);
				if (operation) {
					runtimePending.delete(message.id);
					clearTimeout(operation.timer);
					message.type === "result"
						? operation.resolve(message.result)
						: operation.reject(new Error(message.code));
				}
			});
			runtime.on("exit", () => {
				workbenchReady = false;
				for (const operation of runtimePending.values()) {
					clearTimeout(operation.timer);
					operation.reject(new Error("RUNTIME_STOPPED"));
				}
				runtimePending.clear();
				emit({
					type: "notice",
					text: "开发运行时已停止；未自动重放任务。游戏未决动作保留，需核对原动作。",
				});
			});
			const workspaceRoots = [];
			for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === "--workspace") {
				const path = process.argv[++index];
				if (!path || !isAbsolute(path) || workspaceRoots.length >= 8) throw new Error("INVALID_WORKSPACE_ARGUMENT");
				workspaceRoots.push({ path, label: basename(path), canWrite: false, canExecute: false });
			}
			await workbenchCall("initialize", { directory: join(privateDirectory, smoke ? "m1-smoke-" + (process.env.COMMANDDECK_SMOKE_RUN_ID ?? randomUUID()) : "workbench"), helperSource: join(root, "artifacts/commands"), roots: workspaceRoots });
			workbenchReady = true;
			await game.initialize();
			bridgeTimer = setInterval(() => bridge.poll(), 1000);
			native.on("stopped", () => void nativeStopped().catch(recoveryFailed));
			native.on("connection-lost", () => emit({ type: "native-state", text: "窗口连接已断开，正在核对原端点；未核销前禁止新嵌入。" }));
			const checkUi = createUiWatchdog({ current: () => ui, unavailable: () => stopping || recovering,
				inspect: (record) => inspectOwnedUi(record, { responsiveness: true }), recover: recoverUi,
				notice: (facts) => { recordUiLifecycle({ kind: "probe", epoch: ui?.epoch, ...facts }); emit({ type: "ui-health", text: facts.blocked ? "窗口响应检查未确认，自动替换已停止；任务未重放。" : "正在核对本机窗口响应；任务未重放。", ...facts }); }, thresholdMs: watchdogMs });
			watchdog = setInterval(() => { void checkUi().catch(recoveryFailed); }, 100);
			await startUi();
			await attachFromCommandLine(process.argv);
			if (process.argv.includes("--demo-fixture")) {
				await api("start-fixture");
				await api("attach", "owned-fixture");
				emit({ type: "native-state", text: "原生宿主替身已嵌入；不是 DSP。" });
			}
			if (smoke) {
				const smokeRunner = process.argv.includes("--smoke-observation") ? runObservationSmoke : gameSmoke ? runGameSmoke : process.argv.includes("--smoke-bridge") ? runBridgeSmoke : process.argv.includes("--smoke-workbench") ? runWorkbenchSmoke : process.argv.includes("--smoke-adapter") ? runAdapterDesktopSmoke : runDesktopSmoke;
				await smokeRunner({
					root,
					runId: process.env.COMMANDDECK_SMOKE_RUN_ID ?? randomUUID(),
					native,
					api,
					emit,
					testCommand,
					events,
					getUi: () => ui,
					getRuntimePid: () => runtime.pid,
					getBridgePid: () => bridge.telemetry?.client.child.pid,
					bridgeExitConfirmed: () => bridge.telemetry?.client.exitConfirmed === true,
					getSyntheticCommitCount: async () => { if (!gameSmoke) throw new Error("GAME_SMOKE_ONLY"); return (await bridge.telemetry.client.read("spherewright_get_status")).status.syntheticCommitCount; },
					getProbeSequence: () => probeSequence,
					getState: () => state,
					beginUiHang: () =>
						send(ui, { type: "test", id: "hang", name: "hang-own-ui" }),
					watchdogMs,
				});
				await shutdown();
			}
		})
		.catch(async (error) => {
			if (smoke) console.error("SMOKE_FAILURE", error.message);
			console.error(
				"DESKTOP_SUPERVISOR_FAILED",
				/^[A-Z0-9_]+$/.test(error.message) ? error.message : "OPERATION_FAILED",
			);
			await shutdown(1).catch(() => {
				allowQuit = true;
				app.exit(1);
			});
		});
}
