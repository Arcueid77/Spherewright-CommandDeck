import { app, utilityProcess, safeStorage, Tray, Menu, nativeImage, powerMonitor, clipboard } from "electron";
import { EventEmitter, once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join } from "node:path";
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
import { readPortableProfileCase, runProfileVaultFixture } from "./portable-profile.mjs";
import { resolveTaskProfile } from "./profile-access.mjs";
import { BridgeMonitor } from "./bridge-monitor.mjs";
import { AgentGateway } from "./agent-gateway.mjs";
import { runGatewaySmoke } from "./agent-gateway-smoke.mjs";
import { bridgeFixtureOptions, runBridgeSmoke } from "./bridge-smoke.mjs";
import { settleShutdown } from "./shutdown-drain.mjs";
import { GameTasks } from "./game-tasks.mjs";
import { gameFixtureOptions, runGameSmoke } from "./game-smoke.mjs";
import { observationArguments, assertObservationAction } from "./observation-policy.mjs";
import { runObservationSmoke } from "./observation-smoke.mjs";
import { OwnedFixtureHost } from "./owned-fixture.mjs";
import { assertPortableAction, assertPortableRuntimeAction, assertPortableStorageAction, assertPortableCommandAction, assertPortableDevelopmentUsageAction, assertPortableGatewayAction, portableGatewayCase, portableDevelopmentUsageCase, portableRuntimeScenario, portableMcpScenario, portableDiagnosticMode, portableStorageCase, portableCommandCase } from "./portable-mode.mjs";
import { syntheticProviderScope } from "./synthetic-scope.mjs";
import { trackOwnedRuntimeExit } from "./owned-runtime.mjs";
import { startupFailureCode } from "./startup-failure.mjs";
import { runRuntimeLossSmoke } from "./runtime-loss-smoke.mjs";
import { DiagnosticExports, readDiagnosticBuild } from "./diagnostic-export.mjs";
import { diagnosticCode } from "./diagnostic-snapshot.mjs";
import { assertDiagnosticSmokeAction } from "./diagnostic-smoke-scope.mjs";
import { runDiagnosticSmoke } from "./diagnostic-smoke.mjs";
import { ledgerPresenceConfiguration, prepareLedgerPresence } from "./ledger-presence.mjs";
import { createDesktopTray } from "./desktop-tray.mjs";
import { runTraySmoke } from "./tray-smoke.mjs";
import { runPowerSmoke } from "./power-smoke.mjs";
import { PowerLifecycle, bindPowerMonitor } from "./power-lifecycle.mjs";
import { EventJournal } from "./event-journal.mjs";
import { journalLimits } from "./journal-format.mjs";
import { runJournalSmoke } from "./journal-smoke.mjs";
import { VideoArchive, videoArchiveLimits } from "./video-archive.mjs";
import { VideoPlaybackSessions } from "./video-playback.mjs";
import { videoContext, videoRelation } from "./video-context.mjs";
import { VideoRecording } from "./video-recording.mjs";
import { readModelUsageSummary } from "./usage-summary.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const portableSmoke = process.argv.includes("--portable-smoke");
const portableScenario = portableSmoke ? portableRuntimeScenario(process.argv) : null;
const portableMcpLoss = portableSmoke ? portableMcpScenario(process.argv) : null;
const portableDiagnostics = portableSmoke && portableDiagnosticMode(process.argv);
const storageCase = portableSmoke ? portableStorageCase(process.argv) : null;
const commandCase = portableSmoke ? portableCommandCase(process.argv) : null;
const developmentUsageCase = portableSmoke ? portableDevelopmentUsageCase(process.argv) : null;
const gatewayCase = portableSmoke ? portableGatewayCase(process.argv) : null;
let developmentUsageRootId, developmentUsageProfileId, developmentUsageStarted = false;
let developmentContextTasks = [], developmentContextProfiles = [], developmentContextPending = false;
let commandFixtureRootId;
const smoke = process.argv.includes("--smoke") || portableSmoke;
const gatewaySmoke = Boolean(gatewayCase) || smoke && !portableSmoke && process.argv.includes("--smoke-gateway");
const diagnosticSmoke = portableDiagnostics || smoke && process.argv.includes("--smoke-diagnostics");
const runtimeScenario = portableScenario ?? (smoke && process.argv.includes("--smoke-runtime-loss") ? process.argv.includes("--smoke-runtime-planning") ? "planning" : process.argv.includes("--smoke-runtime-accepted") ? "accepted" : "confirmation" : null);
const sourceMcpFlags = process.argv.filter(arg => arg.startsWith("--smoke-mcp-loss"));
if (sourceMcpFlags.length && (!smoke || !process.argv.includes("--smoke-game") || sourceMcpFlags.length !== 1 || !["--smoke-mcp-loss=accepted", "--smoke-mcp-loss=lost-ack"].includes(sourceMcpFlags[0]) || runtimeScenario)) throw new Error("EXPLICIT_MCP_LOSS_SMOKE_REQUIRED");
const mcpLossScenario = portableMcpLoss ?? sourceMcpFlags[0]?.slice("--smoke-mcp-loss=".length) ?? null;
const portableContext = portableSmoke ? { root: process.env.COMMANDDECK_PORTABLE_ROOT, runId: process.env.COMMANDDECK_PORTABLE_RUN_ID } : null;
const gameFixtureContext = mcpLossScenario ? portableContext ?? { root: process.env.COMMANDDECK_MCP_FIXTURE_ROOT, runId: process.env.COMMANDDECK_SMOKE_RUN_ID } : portableContext;
const fixtureAuthority = {};
const observationPolicy = observationArguments(process.argv);
const watchdogMs = 1000;
if (!app.hasSingleInstanceLock()) throw new Error("SUPERVISOR_PROFILE_OWNER_REQUIRED");
const privateDirectory = app.getPath("userData");
const fullProfileFixture = portableSmoke ? await readPortableProfileCase(portableContext) : null;
const ledgerConfiguration = ledgerPresenceConfiguration(smoke ? (process.env.COMMANDDECK_SMOKE_RUN_ID ?? "") : null);
const ledgerPresence = await prepareLedgerPresence(privateDirectory, smoke ? (process.env.COMMANDDECK_SMOKE_RUN_ID ?? "") : null);
const workbenchDirectory = dirname(join(privateDirectory, ledgerConfiguration.stores.find(store => store.role === "workbench").file));
const vault = new CredentialVault(join(privateDirectory, ...(smoke ? ["vault-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID] : []), "profiles.vault.json"), {
	available: () => process.platform === "win32" && safeStorage.isEncryptionAvailable(),
	encrypt: (text) => safeStorage.encryptStringAsync(text), decrypt: async (bytes) => (await safeStorage.decryptStringAsync(bytes)).result,
});
let changingProfiles = false;
function externalProfiles() { try { return publicProfiles().filter((profile) => !protectedProvider(profile.providerId)).map((profile) => ({ ...profile, source: "external" })); } catch { return []; } }
const native = portableSmoke || diagnosticSmoke ? new OwnedFixtureHost() : new WindowHost();
const events = new EventEmitter();
const researchAuthority = {}, gameApprovalAuthority = {};
const gameSmoke = smoke && (process.argv.includes("--smoke-game") || Boolean(portableScenario && portableScenario !== "idle") || Boolean(portableMcpLoss) || Boolean(storageCase));
const fixtureProvider = gameSmoke || developmentUsageCase ? syntheticProviderScope({ multipleApis: developmentUsageCase?.multipleProviders === true }) : null;
const fixtureDirectory = gameFixtureContext && gameSmoke ? join(gameFixtureContext.root, "runtime-fixtures/m3-smoke", gameFixtureContext.runId) : undefined;
const gatewayFixtureDirectory = gatewayCase ? join(portableContext.root, "runtime-fixtures/gateway", portableContext.runId) : undefined;
const bridge = new BridgeMonitor({ ...(gameSmoke ? gameFixtureOptions(root, process.env.COMMANDDECK_SMOKE_RUN_ID, { mode: storageCase ? "storage-normal" : mcpLossScenario ? mcpLossScenario === "accepted" ? "mcp-drop-after-accept" : "mcp-lost-ack" : runtimeScenario === "accepted" ? "pending" : "normal", ...(fixtureDirectory ? { directory: fixtureDirectory } : {}) }) : smoke && (gatewaySmoke || process.argv.includes("--smoke-bridge") || process.argv.includes("--smoke-observation") || process.argv.includes("--smoke-power")) ? bridgeFixtureOptions(root, process.env.COMMANDDECK_SMOKE_RUN_ID, gatewayFixtureDirectory ? { directory: gatewayFixtureDirectory } : {}) : {}), researchAuthority, observation: observationPolicy, emit: () => emit({ type: "bridge-changed" }) });
const game = new GameTasks({ directory: dirname(join(privateDirectory, ledgerConfiguration.stores.find(store => store.role === "game").file)), bridge, researchAuthority, approvalAuthority: gameApprovalAuthority, syntheticOnly: gameSmoke || portableSmoke || diagnosticSmoke,
	pollMilliseconds: gameSmoke && runtimeScenario === "accepted" ? 0 : 15000,
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
let runtimeExit, blockedWindow, desktopTray, journal, journalBuild, journalError, disposePowerMonitor, powerInspectionFault = false, initializingRuntime = true;
let videoArchive, videoArchiveError;
const agentGateway = new AgentGateway({ snapshot: () => bridge.snapshot() });
let gatewayCopiedForSmoke = null;
let recovering = false,
	stopping = false,
	allowQuit = false;
const state = {
	busy: false,
	currentProbeToolFinished: false,
	probeText: "",
	lastProbeResult: null,
	layoutMode: smoke && !fullProfileFixture && !diagnosticSmoke && !commandCase && !developmentUsageCase && !gatewaySmoke && !process.argv.includes("--smoke-workbench") && !process.argv.includes("--smoke-journal") && !process.argv.includes("--smoke-bridge") && !process.argv.includes("--smoke-observation") && !gameSmoke ? "m0" : "development",
	events: [],
};
const diagnosticFailure = error => ({ unavailableCode: diagnosticCode(error?.message) ?? "COMPONENT_SNAPSHOT_UNAVAILABLE" });
const videoPlayback = new VideoPlaybackSessions({ getArchive: () => videoArchive, isCurrent: (owner, generation) => owner === ui && owner.registered && owner.documentGeneration === generation && !stopping && !recovering });
function invalidateVideo(owner) { void videoPlayback.invalidate(owner).catch(() => console.error("VIDEO_READER_CLOSE_UNCONFIRMED")); }
function readVideoJournal(id) {
	if (!journal || journal.error || journal.closed) throw new Error("JOURNAL_STORAGE_UNAVAILABLE");
	try { return journal.read(id); } catch (error) { if (!["JOURNAL_RECORDING_INVALID", "JOURNAL_RECORDING_NOT_FOUND"].includes(error?.message)) journal.fail(); throw error; }
}
const diagnostics = new DiagnosticExports({
	isCurrent: (owner, generation) => owner === ui && owner.registered && owner.documentGeneration === generation && !stopping && !recovering,
	protectedRoots: [privateDirectory, dirname(privateDirectory), ...(portableContext ? [join(portableContext.root, "ui-profile")] : []), ...(app.isPackaged ? [dirname(process.execPath)] : [])],
	capture: async options => {
		const [build, workbench] = await Promise.all([
			readDiagnosticBuild(root, { packaged: app.isPackaged, applicationVersion: app.getVersion(), electronVersion: process.versions.electron, nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch }),
			options.includeTasks ? workbenchCall("diagnostics", {}, 1500).catch(diagnosticFailure) : null,
		]);
		let gameSnapshot, bridgeSnapshot;
		try { if (options.includeTasks) gameSnapshot = game.snapshot(); } catch (error) { gameSnapshot = diagnosticFailure(error); }
		try { bridgeSnapshot = bridge.snapshot(); } catch (error) { bridgeSnapshot = diagnosticFailure(error); }
		return { build, workbench, game: gameSnapshot, bridge: bridgeSnapshot, runtime: { available: workbenchReady, exitObserved: runtimeExit?.exited ?? null, probeBusy: state.busy, uiConnected: Boolean(ui?.registered && ui.child.connected), uiRecovering: recovering, uiReplacements: restarts } };
	},
});
const systemPower = new PowerLifecycle({
	quiesce: () => {
		const gatewayDrain = agentGateway.stop();
		void recording.interrupt("VIDEO_SYSTEM_PAUSED", "power_interrupted");
		bridge.setSystemPaused(true);
		if (runtime && !runtimeExit?.exited) runtime.postMessage({ type: "abort" });
		const gameDrain = game.drain(), workbenchDrain = workbenchReady ? workbenchCall("drain") : Promise.resolve();
		return settleShutdown([() => gameDrain, () => workbenchDrain, () => gatewayDrain]).then(async () => {
			// Only UI/history access reopens here. Supervisor admission remains paused.
			if (!stopping && workbenchReady && !runtimeExit?.exited) await workbenchCall("resume-after-close-failure");
		});
	},
	check: async current => {
		if (stopping || !workbenchReady || runtimeExit?.exited) throw new Error("POWER_RUNTIME_UNAVAILABLE");
		if (powerInspectionFault) { powerInspectionFault = false; throw new Error("POWER_FIXTURE_WINDOW_UNCONFIRMED"); }
		for (let read = 0; read < 8; read++) {
			if (!current() || stopping) return;
			const window = await native.request("status");
			if (!window || typeof window.attached !== "boolean" || typeof window.nativeParentMatches !== "boolean" || window.gameCalls !== 0) throw new Error("POWER_WINDOW_STATUS_UNSUPPORTED");
			if (window.fault || window.quarantined || window.restoreFailed || window.layoutError) throw new Error("POWER_WINDOW_UNCONFIRMED");
			if (!window.uiOperationPending && !window.layoutPending) {
				if (window.attached === true && (window.nativeParentMatches !== true || window.gameParentMatches !== true) || window.active === true && window.attached !== true) throw new Error("POWER_WINDOW_BINDING_UNCONFIRMED");
				return;
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		throw new Error("POWER_WINDOW_OPERATION_PENDING");
	},
	restore: async current => {
		if (!current()) return;
		if (stopping) throw new Error("POWER_RESTORE_DEFERRED");
		await game.resumeAfterCloseFailure();
		if (!current()) return;
		if (stopping) throw new Error("POWER_RESTORE_DEFERRED");
		bridge.setSystemPaused(false);
	},
	notify: power => { recordUiLifecycle({ kind: "system-power", ...power }); emit({ type: "system-power", power }); },
});
const safeEnvironment = () =>
	Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key),
		),
	);
const recording = new VideoRecording({ getArchive: () => videoArchive, getBuild: () => journalBuild, getJournalId: () => journal?.active?.id ?? null,
	getJournalClock: (id, count) => journal?.sampleClock(id, count) ?? null,
	getSource: () => { if (typeof native.captureSource !== "function") throw new Error("WINDOW_CAPTURE_UNSUPPORTED"); return native.captureSource(); },
	isCurrent: (owner, generation) => owner === ui && owner?.registered && owner.documentGeneration === generation && !stopping && !recovering && systemPower.ready,
	isLocked: () => !["active", "idle"].includes(powerMonitor.getSystemIdleState(30)), notify: value => send(ui, { type: "event", event: { type: "recording-changed", recording: value } }) });
function emitPowerForSmoke(event) {
	if (!(portableSmoke || gatewaySmoke || smoke && process.argv.includes("--smoke-power")) || !["suspend", "resume"].includes(event)) throw new Error("POWER_FIXTURE_REQUIRED");
	powerMonitor.emit(event);
}
function failNextPowerCheckForSmoke() {
	if (!(portableSmoke || smoke && process.argv.includes("--smoke-power"))) throw new Error("POWER_FIXTURE_REQUIRED");
	powerInspectionFault = true;
}
function send(record, message) {
	if (!record?.child.connected) return;
	try {
		record.child.send(message, () => {});
	} catch {}
}
function emit(event) {
	if (journal?.active) {
		try { journal.capture(event, event.type === "game-changed" ? { game: game.snapshot() } : event.type === "bridge-changed" ? { bridge: bridge.snapshot() } : {}); }
		catch { journal.fail(); }
	}
	if (event.type === "text")
		state.probeText = (state.probeText + event.text).slice(-32768);
	else state.events = [...state.events.slice(-39), event];
	send(ui, { type: "event", event });
}
function workbenchCall(action, args = {}, timeoutMs = 25000) {
	if (!runtime || runtimeExit?.exited) return Promise.reject(new Error("RUNTIME_UNAVAILABLE"));
	const id = "workbench:" + String(++testSequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { runtimePending.delete(id); reject(new Error("WORKBENCH_RESPONSE_TIMEOUT")); }, timeoutMs);
		runtimePending.set(id, { resolve, reject, timer });
		runtime.postMessage({ type: "workbench", id, action, args });
	});
}
async function stopRuntimeForSmoke() {
	if (!smoke || !runtimeScenario && !diagnosticSmoke && !commandCase || runtimeExit.exited) throw new Error("RUNTIME_LOSS_SMOKE_ONLY");
	const pid = runtime.pid; await runtimeExit.stop(); return { pid, exitObserved: runtimeExit.exited };
}
async function registerCommandWorkspace() {
	if (!commandCase) throw new Error("COMMAND_FIXTURE_ONLY");
	const { validateCommandWorkspace } = await import("./command-fault-smoke.mjs");
	const path = await validateCommandWorkspace(portableContext), current = await workbenchCall("state");
	let registered;
	if (commandCase.resume) {
		if (current.roots.length !== 1 || current.roots[0].path !== path || current.tasks.length !== 1) throw new Error("COMMAND_FIXTURE_HISTORY_MISMATCH");
		registered = current;
	} else {
		if (current.roots.length || current.tasks.length) throw new Error("COMMAND_FIXTURE_REQUIRES_EMPTY_WORKSPACE");
		registered = await workbenchCall("add", { path, label: "Owned command fault fixture", canWrite: false, canExecute: true });
	}
	commandFixtureRootId = registered.roots[0].id; return registered;
}
async function registerDevelopmentUsageWorkspace() {
	if (!developmentUsageCase) throw new Error("DEVELOPMENT_USAGE_FIXTURE_ONLY");
	const { validateDevelopmentUsageWorkspace } = await import("./development-usage-smoke.mjs");
	const path = await validateDevelopmentUsageWorkspace(portableContext), current = await workbenchCall("state");
	let registered;
	if (developmentUsageCase.phase === "record") {
		if (current.roots.length || current.tasks.length) throw new Error("DEVELOPMENT_USAGE_REQUIRES_EMPTY_WORKSPACE");
		registered = await workbenchCall("add", { path, label: "Synthetic development usage", canWrite: false, canExecute: false });
	} else {
		if (current.roots.length !== 1 || current.tasks.length !== (developmentUsageCase.multipleProviders ? 5 : developmentUsageCase.context ? 3 : 1) || current.roots[0].path !== path || current.roots[0].canWrite || current.roots[0].canExecute) throw new Error("DEVELOPMENT_USAGE_HISTORY_MISMATCH");
		registered = current;
		developmentUsageProfileId = current.tasks[0].provider;
		if (developmentUsageCase.context) developmentContextTasks = current.tasks.map(task => task.id);
		if (developmentUsageCase.multipleProviders) {
			const seed = current.tasks.find(task => task.parentId === null), continued = current.tasks.find(task => task.parentId === seed?.id && task.scope.context?.mode === "continue");
			if (!seed || !continued || seed.provider === continued.provider) throw new Error("DEVELOPMENT_USAGE_HISTORY_MISMATCH");
			developmentContextProfiles = [seed.provider, continued.provider];
		}
	}
	developmentUsageRootId = registered.roots[0].id; return registered;
}
function registerFixtureProvider(...args) {
	if (developmentUsageCase && developmentUsageCase.phase !== "record") throw new Error("DEVELOPMENT_USAGE_REOPEN_IS_READ_ONLY");
	fixtureProvider.register(...args);
	if (developmentUsageCase) developmentUsageProfileId = args[1];
	if (developmentUsageCase?.multipleProviders) developmentContextProfiles.push(args[1]);
}
function runGamePlanner(command) {
	if (!workbenchReady || runtimeExit?.exited) return Promise.reject(new Error("GAME_RUNTIME_UNAVAILABLE"));
	const id = "game-planner:" + randomUUID(), { signal, observe, event, ...data } = command;
	return new Promise((resolve, reject) => {
		const abort = () => { if (!runtimeExit?.exited) runtime?.postMessage({ type: "abort-game", taskId: data.task.id }); };
		const finish = (value, error) => { signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value); };
		const timer = setTimeout(() => { runtimePending.delete(id); abort(); finish(null, new Error("GAME_RUNTIME_RESPONSE_TIMEOUT")); }, 310000);
		runtimePending.set(id, { timer, resolve: (value) => finish(value), reject: (error) => finish(null, error) });
		signal.addEventListener("abort", abort, { once: true });
		runtime.postMessage({ type: "game-planner", id, command: { ...data, directory: join(privateDirectory, smoke ? "game-agent-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID : "game-agent") } });
		if (signal.aborted) abort();
	});
}
async function probe(config) {
	if (!workbenchReady || runtimeExit?.exited) throw new Error("RUNTIME_UNAVAILABLE");
	const gameState = game.snapshot();
	if (game.operation || gameState.developmentFrozen || gameState.unresolved.length) throw new Error("GAME_EXECUTION_OWNS_RUNTIME");
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
	systemPower.assertAction(action, args);
	if (diagnosticSmoke) assertDiagnosticSmokeAction(action, args);
	if (portableSmoke && !diagnosticSmoke) {
		if (gatewayCase) assertPortableGatewayAction(action, args, { phase: gatewayCase.phase, internal: source === fixtureAuthority });
		else if (developmentUsageCase) assertPortableDevelopmentUsageAction(action, args, { phase: developmentUsageCase.phase, rootId: developmentUsageRootId, profileId: developmentUsageProfileId, started: developmentUsageStarted, internal: source === fixtureAuthority, context: developmentUsageCase.context === true, contextTasks: developmentContextTasks, contextPending: developmentContextPending, interruption: developmentUsageCase.interruption === true, multipleProviders: developmentUsageCase.multipleProviders === true, contextProfiles: developmentContextProfiles, summaryFailure: developmentUsageCase.summaryFailure });
		else if (commandCase) assertPortableCommandAction(action, args, { rootId: commandFixtureRootId });
		else if (storageCase) assertPortableStorageAction(action, args, { internal: source === fixtureAuthority });
		else if (portableScenario || portableMcpLoss) assertPortableRuntimeAction(action, args, { scenario: portableScenario ?? "confirmation", internal: source === fixtureAuthority });
		else assertPortableAction(action, args);
	}
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
	const recoveryRead = action === "model-usage" || action === "gateway" && ["snapshot", "stop"].includes(args?.action) || action === "workbench" && ["state", "task", "ui-get", "list", "read", "diff", "change-diff", "read-reference", "search", "checks"].includes(args?.action) || ["bridge", "game", "video"].includes(action) && args?.action === "snapshot" || action === "recording" && ["snapshot", "cancel", "closed"].includes(args?.action);
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
	if (action === "snapshot") return { ...state, runtimeAvailable: workbenchReady, power: systemPower.snapshot(), events: [...state.events] };
	if (action === "gateway") {
		if (!args || !["snapshot", "start", "stop", "copy"].includes(args.action) || Object.keys(args).some(key => !["action", "generation"].includes(key))) throw new Error("INVALID_GATEWAY_ACTION");
		if (args.action === "snapshot") return agentGateway.snapshot();
		if (source !== ui || !source?.registered || args.generation !== source.documentGeneration) throw new Error("TRUSTED_UI_REQUIRED");
		if (args.action === "start") return agentGateway.start();
		if (args.action === "stop") return agentGateway.stop();
		const connection = agentGateway.connection(), config = { mcpServers: { "spherewright-commanddeck": { command: process.execPath, args: [join(root, "apps/desktop/agent-gateway-stdio.mjs")], env: { ELECTRON_RUN_AS_NODE: "1", COMMANDDECK_GATEWAY_PIPE: connection.pipe, COMMANDDECK_GATEWAY_KEY: connection.key } } } };
		if (smoke) gatewayCopiedForSmoke = config; else clipboard.writeText(JSON.stringify(config, null, 2));
		return { copied: true };
	}
	if (action === "model-usage") return readModelUsageSummary({
		development: () => { if (!workbenchReady || runtimeExit?.exited) throw new Error("USAGE_SOURCE_UNAVAILABLE"); return workbenchCall("usage-data", {}, 12000); },
		game: () => { if (!game.ledger.storageAvailable) throw new Error("USAGE_SOURCE_UNAVAILABLE"); return game.ledger.usageSample(); },
	});
	if (action === "recording") {
		if (!args || !["snapshot", "prepare", "authorize", "ready", "set-masks", "start", "append", "finish", "cancel", "closed"].includes(args.action)) throw new Error("INVALID_RECORDING_ACTION");
		if (args.action === "snapshot") return recording.snapshot();
		if (source !== ui || !source?.registered) throw new Error("TRUSTED_UI_REQUIRED");
		const value = args.args ?? {}, generation = args.generation;
		if (args.action === "prepare") return recording.prepare(source, generation, value);
		if (args.action === "authorize") return recording.authorize(source, generation, value.permit);
		if (args.action === "ready") return recording.ready(source, generation, value.permit, value.track);
		if (args.action === "set-masks") return recording.setMasks(source, generation, value.permit, value.masks);
		if (args.action === "start") return recording.start(source, generation, value.permit);
		if (args.action === "finish") return recording.finish(source, generation, value.permit);
		if (args.action === "cancel") return recording.cancel(source, generation, value.permit);
		if (args.action === "closed") return recording.closed(source, generation, value.permit);
		if (typeof value.data !== "string" || value.data.length > 2796204) throw new Error("VIDEO_CHUNK_INVALID");
		return recording.append(source, generation, value.permit, value.sequence, Buffer.from(value.data, "base64"));
	}
	if (action === "video") {
		if (!args || !["snapshot", "context", "open", "bookmark", "read", "close"].includes(args.action)) throw new Error("INVALID_VIDEO_ACTION");
		if (args.action === "snapshot") return videoArchive?.snapshot() ?? { available: false, error: videoArchiveError ?? "VIDEO_ARCHIVE_NOT_READY", activeId: null, limits: videoArchiveLimits, recordings: [] };
		if (source !== ui || !source?.registered) throw new Error("TRUSTED_UI_REQUIRED");
		if (args.action === "context") { videoPlayback.scope(source, args.generation); if (!videoArchive) throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); return videoContext(videoArchive, args.args?.id, readVideoJournal, args.args?.offset); }
		if (args.action === "bookmark") return videoPlayback.annotate(source, args.generation, args.args?.grant, (media, guard) => {
			const relation = videoRelation(media.recording, args.args?.eventSequence, readVideoJournal);
			return videoArchive.addBookmark(media.recording.id, media.mediaSha256, args.args?.timeMs, args.args?.tag, relation, guard);
		});
		if (args.action === "open") return videoPlayback.open(source, args.generation, args.args?.id);
		if (args.action === "close") return videoPlayback.close(source, args.generation, args.args?.grant);
		const bytes = await videoPlayback.read(source, args.generation, args.args?.grant, args.args?.offset, args.args?.length);
		return { bytes: bytes.length, data: Buffer.from(bytes).toString("base64") };
	}
	if (action === "journal") {
		if (!args || !["snapshot", "read", "start", "stop", "bookmark"].includes(args.action)) throw new Error("INVALID_JOURNAL_ACTION");
		if (!journal) { if (args.action === "snapshot") return { available: false, error: journalError ?? "JOURNAL_NOT_READY", activeId: null, scope: "host-events-v1", limits: journalLimits, recordings: [] }; throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); }
		if (args.action === "snapshot") return journal.snapshot();
		if (args.action === "read") { try { return journal.read(args.args?.id); } catch (error) { if (!["JOURNAL_RECORDING_INVALID", "JOURNAL_RECORDING_NOT_FOUND"].includes(error.message)) journal.fail(); throw error; } }
		if (args.action === "start") return journal.start(journalBuild);
		if (args.action === "stop") { if (!args.args?.id || journal.active?.id !== args.args.id) throw new Error("JOURNAL_RECORDING_CHANGED"); return journal.stop(); }
		return journal.bookmark(args.args?.id, args.args?.sequence, args.args?.tag);
	}
	if (action === "resume-system") {
		if (source !== ui || !source?.registered) throw new Error("TRUSTED_UI_REQUIRED");
		return systemPower.retry();
	}
	if (["diagnostics-preview", "diagnostics-begin-save", "diagnostics-write", "diagnostics-cancel-save", "diagnostics-discard"].includes(action)) {
		if (source !== ui || !source?.registered) throw new Error("TRUSTED_DIAGNOSTIC_HOST_REQUIRED");
		if (action === "diagnostics-preview") return diagnostics.preview(source, args?.generation, args?.options);
		if (action === "diagnostics-begin-save") return diagnostics.beginSave(source, args?.generation, args?.id);
		if (action === "diagnostics-write") return diagnostics.save(source, args?.generation, args?.grant, args?.path);
		if (action === "diagnostics-cancel-save") return diagnostics.cancelSave(source, args?.generation, args?.grant);
		return diagnostics.discard(source, args?.generation, args?.id);
	}
	if (action === "game") {
		if (!args || !["snapshot", "start", "stop", "reconcile", "reprepare", "catalog"].includes(args.action)) throw new Error("INVALID_GAME_ACTION");
		if (args.action === "snapshot") return { ...game.snapshot(), readOnlyObservation: Boolean(observationPolicy), systemPaused: !systemPower.ready };
		if (ui?.nativeProbePending || (!workbenchReady && !["stop", "reconcile"].includes(args.action))) throw new Error("GAME_RUNTIME_UNAVAILABLE");
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
		if (!workbenchReady || !args || !["state", "add", "refresh", "grants", "list", "read", "diff", "change-diff", "attach-reference", "read-reference", "search", "save", "revert", "checks", "check", "task", "context-info", "cancel", "ui-get", "ui-save", "agent"].includes(args.action)) throw new Error("INVALID_WORKBENCH_ACTION");
		if (ui?.nativeProbePending && ["add", "grants", "save", "revert", "check", "agent", "attach-reference"].includes(args.action)) throw new Error("UI_NATIVE_OPERATION_PENDING");
		if (changingProfiles && ["agent", "check", "save", "revert"].includes(args.action)) throw new Error("MODEL_CONFIGURATION_BUSY");
		if (developmentUsageCase && args.action === "agent") developmentUsageStarted = true;
		if (developmentUsageCase?.context && args.action === "agent") developmentContextPending = true;
		const result = await workbenchCall(args.action, args.args ?? {});
		if (developmentUsageCase?.context && args.action === "agent") { developmentContextTasks.push(result.id); developmentContextPending = false; }
		return args.action === "state" && (!systemPower.ready || observationPolicy) ? { ...result, ...(observationPolicy ? { observationOnly: true } : {}), executionBlocked: true } : result;
	}
	if (action === "profiles") {
		let profiles = []; try { profiles = (await vault.list()).profiles; } catch {}
		return [...externalProfiles(), ...profiles];
	}
	if (action === "profiles-manage") {
		if (!args || !["list", "describe", "save", "remove"].includes(args.action)) throw new Error("INVALID_PROFILE_ACTION");
		if ((gameSmoke || developmentUsageCase) && args.action === "save") fixtureProvider.assertDraft(args.args);
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
	if (action === "detach") { await recording.interrupt("VIDEO_WINDOW_CHANGED", "window_changed"); return native.request("detach"); }
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
	const args = [root, "--managed-ui", ...(smoke ? ["--smoke-ui"] : []), ...(diagnosticSmoke ? ["--smoke-diagnostics-ui"] : []), ...(portableSmoke ? ["--portable-smoke"] : []), ...(gatewayCase ? ["--portable-gateway=" + gatewayCase.phase] : []), ...(portableDiagnostics ? ["--portable-diagnostics"] : []), ...(portableScenario ? ["--portable-runtime-loss=" + portableScenario] : []), ...(portableMcpLoss ? ["--portable-mcp-loss=" + portableMcpLoss] : []), ...(storageCase ? ["--portable-storage-fault=" + storageCase.scenario, ...(storageCase.resume ? ["--portable-storage-resume"] : [])] : []), ...(commandCase ? ["--portable-command-loss=" + commandCase.scenario, ...(commandCase.resume ? ["--portable-command-resume"] : [])] : []), ...(gameSmoke ? ["--smoke-game-ui"] : [])];
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
		documentGeneration: 0,
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
		} else if (message.type === "ui-document" && record.registered && Number.isSafeInteger(message.generation) && message.generation > record.documentGeneration) {
			diagnostics.invalidate(record);
			invalidateVideo(record);
			void recording.invalidate(record);
			record.documentGeneration = message.generation;
		} else if (message.type === "ui-loaded" && record.registered) {
			recording.documentReady(record, record.documentGeneration);
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
		invalidateVideo(record);
		void recording.invalidate(record, "ui_lost", true);
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
	diagnostics.invalidate(old);
	invalidateVideo(old);
	void recording.invalidate(old);
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
async function openWorkbench() {
	if (stopping) return;
	if (recovering && restarts > 1 && ui && (ui.child.exitCode !== null || ui.child.signalCode !== null)) {
		await startUi(); recovering = false;
		emit({ type: "notice", text: "已按重新打开工作台的操作创建界面，未重启宿主或重放任务。" });
	} else send(ui, { type: "focus" });
}
async function shutdown(exitCode = 0, { preserveApplication = false } = {}) {
	if (stopping) return;
	stopping = true;
	const gatewayDrain = agentGateway.stop();
	void recording.interrupt("VIDEO_APPLICATION_EXIT", "application_exit");
	clearInterval(bridgeTimer);
	if (!runtimeExit?.exited) runtime?.postMessage({ type: "abort" });
	try {
		// Drain game first so its retained original action can still use the same connection.
		await settleShutdown([() => game.drain(), () => workbenchReady ? workbenchCall("drain") : Promise.resolve(), () => diagnostics.drain(), () => gatewayDrain]);
		await bridge.close();
		await native.request("detach");
		await native.request("close");
	} catch (error) {
		if (preserveApplication) throw error;
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
	try { if (journal?.active) journal.stop("application_exit"); } catch { console.error("JOURNAL_EXIT_RECORD_UNCONFIRMED"); }
	game.close();
	if (workbenchReady) { await workbenchCall("close-store"); workbenchReady = false; }
	await lifecycleWrite;
	try { journal?.close(); } catch { console.error("JOURNAL_CLOSE_UNCONFIRMED"); }
	await withDeadline(recording.dispose(), 3000, "VIDEO_RECORDING_CLOSE_UNCONFIRMED").catch(() => console.error("VIDEO_RECORDING_CLOSE_UNCONFIRMED"));
	await withDeadline(videoPlayback.drain(), 3000, "VIDEO_PLAYBACK_CLOSE_UNCONFIRMED").catch(() => console.error("VIDEO_PLAYBACK_CLOSE_UNCONFIRMED"));
	if (videoArchive) await withDeadline(videoArchive.close(), 3000, "VIDEO_ARCHIVE_CLOSE_UNCONFIRMED").catch(() => console.error("VIDEO_ARCHIVE_CLOSE_UNCONFIRMED"));
	disposePowerMonitor?.();
	desktopTray?.destroy();
	if (preserveApplication && runtime) await runtimeExit.stop();
	else if (!runtimeExit?.exited) runtime?.kill();
	allowQuit = true;
	if (!preserveApplication) app.exit(exitCode);
}
if (!app.hasSingleInstanceLock()) {
	allowQuit = true;
	if (smoke) {
		console.error("SMOKE_INSTANCE_ALREADY_RUNNING");
		app.exit(1);
	} else app.quit();
} else {
	app.on("second-instance", (_event, args) => {
		if (stopping) {
			if (args.includes("--quit") && allowQuit) app.quit();
			else if (blockedWindow && !blockedWindow.isDestroyed()) { blockedWindow.show(); blockedWindow.focus(); }
			return;
		}
		if (args.includes("--quit")) {
			void shutdown().catch(() => {});
			return;
		}
		if (args.includes("--attach-adapter")) {
			if (!workbenchReady || !ui?.registered) return;
			void attachFromCommandLine(args).catch(() => emit({ type: "notice", text: "本次窗口连接未通过，原状态保留，未自动重试。" }));
			return;
		}
		void openWorkbench().catch(recoveryFailed);
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
			disposePowerMonitor = bindPowerMonitor(powerMonitor, systemPower, () => !stopping);
			const disposeLifecyclePower = disposePowerMonitor, recordingLock = () => { void recording.interrupt("VIDEO_DESKTOP_UNAVAILABLE", "power_interrupted"); };
			powerMonitor.on("lock-screen", recordingLock);
			disposePowerMonitor = () => { disposeLifecyclePower(); powerMonitor.removeListener("lock-screen", recordingLock); };
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
			runtimeExit = trackOwnedRuntimeExit(runtime);
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
							if (gameSmoke || developmentUsageCase) fixtureProvider.assertReference(message.providerId, message.modelId);
							const profile = await resolveTaskProfile(vault, (taskId) => message.taskType === "game" ? game.profileTask(taskId) : workbenchCall("task", { taskId }), message);
							if (gameSmoke || developmentUsageCase) fixtureProvider.assertResolved(profile);
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
				if (!stopping) game.runtimeUnavailable();
				for (const operation of runtimePending.values()) {
					clearTimeout(operation.timer);
					operation.reject(new Error("RUNTIME_STOPPED"));
				}
				runtimePending.clear();
				if (!stopping) emit({
					type: "runtime-stopped",
					text: "开发运行时已停止；未自动重放任务。游戏未决动作保留，需核对原动作。",
				});
			});
			const workspaceRoots = [];
			for (let index = 0; index < process.argv.length; index++) if (process.argv[index] === "--workspace") {
				const path = process.argv[++index];
				if (!path || !isAbsolute(path) || workspaceRoots.length >= 8) throw new Error("INVALID_WORKSPACE_ARGUMENT");
				workspaceRoots.push({ path, label: basename(path), canWrite: false, canExecute: false });
			}
			await workbenchCall("initialize", { directory: workbenchDirectory, helperSource: join(root, "artifacts/commands"), roots: workspaceRoots, ...(commandCase?.scenario === "helper" && !commandCase.resume ? { commandFixture: { ...portableContext, ...commandCase } } : {}) });
			workbenchReady = true;
			await game.initialize();
			await ledgerPresence.seal();
			journalBuild = await readDiagnosticBuild(root, { packaged: app.isPackaged });
			try { journal = new EventJournal(join(privateDirectory, smoke ? "journal-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID : "journal"), { notify: () => send(ui, { type: "event", event: { type: "journal-changed" } }) }); }
			catch (error) { journalError = /^JOURNAL_[A-Z_]+$/.test(error?.message ?? "") ? error.message : "JOURNAL_STORAGE_UNAVAILABLE"; }
			try { videoArchive = new VideoArchive(join(privateDirectory, smoke ? "video-smoke-" + process.env.COMMANDDECK_SMOKE_RUN_ID : "video"), { notify: () => send(ui, { type: "event", event: { type: "video-changed" } }) }); }
			catch (error) { videoArchiveError = /^VIDEO_[A-Z_]+$/.test(error?.message ?? "") ? error.message : "VIDEO_ARCHIVE_UNAVAILABLE"; }
			initializingRuntime = false;
			bridgeTimer = setInterval(() => bridge.poll(), 1000);
			native.on("stopped", () => void nativeStopped().catch(recoveryFailed));
			native.on("connection-lost", () => emit({ type: "native-state", text: "窗口连接已断开，正在核对原端点；未核销前禁止新嵌入。" }));
			const checkUi = createUiWatchdog({ current: () => ui, unavailable: () => stopping || recovering || systemPower.watchdogUnavailable(), generation: () => systemPower.generation,
				inspect: (record) => inspectOwnedUi(record, { responsiveness: true }), recover: recoverUi,
				notice: (facts) => { recordUiLifecycle({ kind: "probe", epoch: ui?.epoch, ...facts }); emit({ type: "ui-health", text: facts.blocked ? "窗口响应检查未确认，自动替换已停止；任务未重放。" : "正在核对本机窗口响应；任务未重放。", ...facts }); }, thresholdMs: watchdogMs });
			watchdog = setInterval(() => { void checkUi().catch(recoveryFailed); }, 100);
			await startUi();
			try {
				desktopTray = createDesktopTray({ Tray, Menu, nativeImage, open: openWorkbench, exit: () => shutdown(), notice: code => {
					send(ui, { type: "focus" });
					emit({ type: "notice", text: code === "TRAY_EXIT_BLOCKED" ? "退出未完成：任务收尾或窗口还原尚未确认，工作台保持打开。" : "工作台尚未打开，请检查当前窗口连接状态。" });
				} });
			} catch { emit({ type: "notice", text: "系统托盘不可用；仍可从主窗口正常退出。" }); }
			await attachFromCommandLine(process.argv);
			if (portableSmoke) {
				const { runPortableSmoke } = await import("./portable-smoke.mjs");
				await runPortableSmoke({
					getTray: () => desktopTray, getPower: () => systemPower, emitPowerForSmoke, failNextPowerCheckForSmoke, root, privateDirectory, context: portableContext,
					api: portableScenario || portableMcpLoss || storageCase || developmentUsageCase || gatewayCase ? (action, args) => api(action, args, fixtureAuthority) : api,
					testCommand, getRuntimePid: () => runtime.pid, getProbeSequence: () => probeSequence, getUi: () => ui,
					runtimeScenario: portableScenario, mcpLossScenario: portableMcpLoss, diagnostics: portableDiagnostics, storageCase, commandCase, developmentUsageCase, gatewayCase, gatewayFixtureDirectory,
					getGatewayConfigurationForSmoke: () => { if (!gatewayCase) throw new Error("GATEWAY_FIXTURE_REQUIRED"); return gatewayCopiedForSmoke; },
					registerCommandWorkspace, registerDevelopmentUsageWorkspace,
					profileVaultFixture: phase => { if (portableScenario || portableMcpLoss || storageCase || commandCase || portableDiagnostics || developmentUsageCase) throw new Error("FULL_PROFILE_FIXTURE_MODE_CONFLICT"); return runProfileVaultFixture(vault, portableContext, phase); },
					stopCommandHelperForSmoke: taskId => { if (commandCase?.scenario !== "helper" || commandCase.resume) throw new Error("COMMAND_HELPER_FIXTURE_REQUIRED"); return workbenchCall("stop-command-helper-fixture", { taskId }); },
					tryCommandGameAdmission: () => { if (!commandCase) throw new Error("COMMAND_FIXTURE_ONLY"); return workbenchCall("game-begin"); },
					getGameTasks: () => { if (!storageCase) throw new Error("STORAGE_FIXTURE_ONLY"); return game; },
					runId: portableContext.runId, stopRuntimeForSmoke, registerSyntheticProvider: registerFixtureProvider,
					getBridgeClient: () => bridge.telemetry?.client, getBridgePid: () => bridge.telemetry?.client.child.pid, bridgeExitConfirmed: () => bridge.telemetry?.client.exitConfirmed === true,
					getSyntheticCommitCount: async () => { if (!gameSmoke) throw new Error("GAME_SMOKE_ONLY"); return (await bridge.telemetry.client.read("spherewright_get_status")).status.syntheticCommitCount; },
				}, videoArchive, journal);
				await shutdown(); return;
			}
			if (process.argv.includes("--demo-fixture")) {
				await api("start-fixture");
				await api("attach", "owned-fixture");
				emit({ type: "native-state", text: "原生宿主替身已嵌入；不是 DSP。" });
			}
			if (smoke) {
				const smokeRunner = gatewaySmoke ? runGatewaySmoke : process.argv.includes("--smoke-journal") ? runJournalSmoke : process.argv.includes("--smoke-power") ? runPowerSmoke : process.argv.includes("--smoke-tray") ? runTraySmoke : diagnosticSmoke ? runDiagnosticSmoke : process.argv.includes("--smoke-runtime-loss") && !gameSmoke ? runRuntimeLossSmoke : process.argv.includes("--smoke-observation") ? runObservationSmoke : gameSmoke ? runGameSmoke : process.argv.includes("--smoke-bridge") ? runBridgeSmoke : process.argv.includes("--smoke-workbench") ? runWorkbenchSmoke : process.argv.includes("--smoke-adapter") ? runAdapterDesktopSmoke : runDesktopSmoke;
				await smokeRunner({
					root,
					runId: process.env.COMMANDDECK_SMOKE_RUN_ID ?? randomUUID(),
					native,
					api,
					emit,
					testCommand,
					events,
					getUi: () => ui,
					getTray: () => desktopTray,
					getPower: () => systemPower, emitPowerForSmoke, failNextPowerCheckForSmoke,
					getRuntimePid: () => runtime.pid,
					mcpLossScenario, context: diagnosticSmoke ? { root: process.env.COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT, runId: process.env.COMMANDDECK_SMOKE_RUN_ID } : mcpLossScenario ? gameFixtureContext : undefined,
					getBridgeClient: () => bridge.telemetry?.client,
					stopRuntimeForSmoke, runtimeScenario,
					registerSyntheticProvider: (...args) => fixtureProvider.register(...args),
					getBridgePid: () => bridge.telemetry?.client.child.pid,
					bridgeExitConfirmed: () => bridge.telemetry?.client.exitConfirmed === true,
					getSyntheticCommitCount: async () => { if (!gameSmoke) throw new Error("GAME_SMOKE_ONLY"); return (await bridge.telemetry.client.read("spherewright_get_status")).status.syntheticCommitCount; },
					getProbeSequence: () => probeSequence,
					getGatewayConfigurationForSmoke: () => { if (!gatewaySmoke) throw new Error("GATEWAY_FIXTURE_REQUIRED"); return gatewayCopiedForSmoke; },
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
			if (initializingRuntime && !stopping) {
				try {
					await shutdown(1, { preserveApplication: true });
					const { showStartupBlocked } = await import("./startup-blocked.mjs");
					blockedWindow = await showStartupBlocked(app, startupFailureCode(error), { runtimeStoppedBeforeNotice: !runtime || runtimeExit.exited });
				} catch { allowQuit = true; app.exit(1); }
				return;
			}
			await shutdown(1).catch(() => {
				allowQuit = true;
				app.exit(1);
			});
		});
}
