import { realpath, mkdir, lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { assertContextFixtureTask } from "./development-context-case.mjs";
import { assertProviderContextTask, providerContextPrefix } from "./development-provider-context-case.mjs";

export const portableRuntimeScenarios = Object.freeze(["idle", "confirmation", "accepted", "planning"]);
export const portableMcpScenarios = Object.freeze(["accepted", "lost-ack"]);
export const portableStorageScenarios = Object.freeze(["before-send", "receipt", "terminal"]);
export const portableCommandScenarios = Object.freeze(["reload", "runtime", "helper", "exit"]);
export const developmentUsagePrompt = "Read fixture.txt and report its synthetic content. Do not edit files or run commands.";
export function portableDevelopmentUsageCase(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-development-usage"));
	if (!values.length) return null;
	const phase = values[0].slice("--portable-development-usage=".length);
	const failure = /^context-(cancel|http-error)-(record|reopen)$/.exec(phase);
	if (!argv.includes("--portable-smoke") || values.length !== 1 || values[0] !== "--portable-development-usage=" + phase || !failure && !["record", "reopen", "context-record", "context-reopen", "context-interrupt-record", "context-interrupt-recover", "context-interrupt-reopen", "context-providers-record", "context-providers-reopen"].includes(phase) || argv.some(arg => arg.startsWith("--portable-") && arg !== "--portable-smoke" && arg !== values[0])) throw new Error("PACKAGED_DEVELOPMENT_USAGE_CASE_REQUIRED");
	if (failure) return { phase: failure[2], context: true, multipleProviders: true, summaryFailure: failure[1] };
	if (phase.startsWith("context-interrupt-")) return { phase: phase.slice(18), context: true, interruption: true };
	if (phase.startsWith("context-providers-")) return { phase: phase.slice(18), context: true, multipleProviders: true };
	return phase.startsWith("context-") ? { phase: phase.slice(8), context: true } : { phase };
}

export function assertPortableDevelopmentUsageAction(action, args, { phase, rootId, profileId, started = false, internal = false, context = false, contextTasks = [], contextPending = false, interruption = false, multipleProviders = false, contextProfiles = [], summaryFailure = null } = {}) {
	if (phase === "recover" && context && interruption) phase = "reopen";
	if (!["record", "reopen"].includes(phase)) throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
	if (["probe", "attach", "start-fixture"].includes(action)) throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
	if (action === "journal" && !["snapshot", "read"].includes(args?.action) || action === "video" && args?.action === "bookmark") throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
	try { assertPortableAction(action, args); return; } catch {}
	if (action === "workbench" && args?.action === "cancel" && phase === "record" && context && multipleProviders && summaryFailure === "cancel" && !contextPending && [4, 5].includes(contextTasks.length) && typeof args.args?.taskId === "string" && args.args.taskId === contextTasks.at(-1) && Object.keys(args.args).length === 1) return;
	const ownedProfile = typeof args?.args?.id === "string" && (multipleProviders ? contextProfiles.includes(args.args.id) : args.args.id === profileId);
	if (internal && action === "profiles-manage" && args?.action === "describe" && ownedProfile) return;
	if (phase === "record" && internal && action === "profiles-manage" && args?.action === "save" && ownedProfile) return;
	if (action === "workbench" && typeof rootId === "string" && args?.args?.rootId === rootId) {
		if (["checks", "list", "read", "diff"].includes(args.action)) return;
		if (context && args.action === "context-info" && contextTasks.includes(args.args.taskId)) return;
		if (context && phase === "record" && args.action === "agent") {
			if (multipleProviders) assertProviderContextTask(args.args, { rootId, profiles: contextProfiles, tasks: contextTasks, pending: contextPending });
			else assertContextFixtureTask(args.args, { rootId, profileId, tasks: contextTasks, pending: contextPending });
			return;
		}
		if (context && args.action === "agent") throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
		if (phase === "record" && !started && args.action === "agent" && typeof profileId === "string" && args.args.providerId === profileId && args.args.modelId === "fixture" && args.args.prompt === developmentUsagePrompt && Object.keys(args.args).every(key => ["rootId", "providerId", "modelId", "prompt"].includes(key))) return;
	}
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}
export function portableCommandCase(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-command"));
	if (!values.length) return null;
	const faults = values.filter(arg => arg.startsWith("--portable-command-loss=")), resume = values.includes("--portable-command-resume");
	const scenario = faults[0]?.slice("--portable-command-loss=".length);
	if (!argv.includes("--portable-smoke") || faults.length !== 1 || values.length !== (resume ? 2 : 1) || !portableCommandScenarios.includes(scenario) || argv.some(arg => /^--portable-(?:runtime-loss|mcp-loss|diagnostics|storage)/.test(arg))) throw new Error("PACKAGED_PORTABLE_COMMAND_CASE_REQUIRED");
	return { scenario, resume };
}

export function assertPortableCommandAction(action, args, { rootId } = {}) {
	if (action === "model-usage") return;
	if (action === "recording" && args?.action === "snapshot") return;
	if (["resume-system", "snapshot", "status", "viewport", "focus-ui", "close", "profiles", "targets"].includes(action)) return;
	if (["game", "bridge"].includes(action) && args?.action === "snapshot") return;
	if (action === "profiles-manage" && args?.action === "list") return;
	if (action === "workbench") {
		if (["state", "task", "ui-get", "ui-save"].includes(args?.action)) return;
		if (typeof rootId === "string" && args?.args?.rootId === rootId) {
			if (["checks", "list", "read", "diff", "refresh"].includes(args.action)) return;
			if (args.action === "check" && args.args.checkId === "npm:test") return;
		}
	}
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}
export function portableStorageCase(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-storage"));
	if (!values.length) return null;
	const faults = values.filter(arg => arg.startsWith("--portable-storage-fault=")), resume = values.includes("--portable-storage-resume");
	const scenario = faults[0]?.slice("--portable-storage-fault=".length);
	if (!argv.includes("--portable-smoke") || faults.length !== 1 || values.length !== (resume ? 2 : 1) || !portableStorageScenarios.includes(scenario) || argv.some(arg => /^--portable-(?:runtime-loss|mcp-loss|diagnostics)/.test(arg))) throw new Error("PACKAGED_PORTABLE_STORAGE_CASE_REQUIRED");
	return { scenario, resume };
}

export function assertPortableStorageAction(action, args, { internal = false } = {}) {
	if (["probe", "attach", "start-fixture"].includes(action)) throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
	if (["diagnostics-preview", "diagnostics-begin-save", "diagnostics-write", "diagnostics-cancel-save", "diagnostics-discard"].includes(action)) return;
	return assertPortableRuntimeAction(action, args, { scenario: "confirmation", internal });
}
export function portableDiagnosticMode(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-diagnostics"));
	if (!values.length) return false;
	if (values.length !== 1 || values[0] !== "--portable-diagnostics" || !argv.includes("--portable-smoke") || argv.some(arg => arg.startsWith("--portable-runtime-loss") || arg.startsWith("--portable-mcp-loss"))) throw new Error("PACKAGED_PORTABLE_DIAGNOSTIC_MODE_REQUIRED");
	return true;
}
export function portableMcpScenario(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-mcp-loss"));
	if (!values.length) return null;
	if (values.length !== 1 || !argv.includes("--portable-smoke") || argv.some(arg => arg.startsWith("--portable-runtime-loss"))) throw new Error("PACKAGED_PORTABLE_MCP_SCENARIO_REQUIRED");
	const value = values[0].slice("--portable-mcp-loss=".length);
	if (values[0] !== "--portable-mcp-loss=" + value || !portableMcpScenarios.includes(value)) throw new Error("PACKAGED_PORTABLE_MCP_SCENARIO_REQUIRED");
	return value;
}
export function portableRuntimeScenario(argv) {
	const values = argv.filter(arg => arg.startsWith("--portable-runtime-loss"));
	if (!values.length) return null;
	if (values.length !== 1 || !argv.includes("--portable-smoke") || argv.some(arg => arg.startsWith("--portable-mcp-loss"))) throw new Error("PACKAGED_PORTABLE_RUNTIME_SCENARIO_REQUIRED");
	const value = values[0].slice("--portable-runtime-loss=".length);
	if (values[0] !== "--portable-runtime-loss=" + value || !portableRuntimeScenarios.includes(value)) throw new Error("PACKAGED_PORTABLE_RUNTIME_SCENARIO_REQUIRED");
	return value;
}

export function assertPortableRuntimeAction(action, args, { scenario, internal = false } = {}) {
	if (!portableRuntimeScenarios.includes(scenario)) throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
	try { assertPortableAction(action, args); return; } catch {}
	if (scenario !== "idle") {
		if (action === "game" && ["catalog", "start", "stop", "reprepare", "reconcile"].includes(args?.action)) return;
		if (["game-confirmation", "game-confirmed"].includes(action)) return; // The usual UI/nonce authority check still follows.
		if (action === "bridge" && ["refresh", "disconnect"].includes(args?.action)) return;
		if (internal && (action === "bridge-select" || action === "profiles-manage" && ["save", "remove"].includes(args?.action))) return;
	}
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}

export function assertPortableAction(action, args) {
	if (action === "gateway" && args?.action === "snapshot") return;
	if (action === "model-usage") return;
	if (action === "recording" && args?.action === "snapshot") return;
	if (action === "video" && ["snapshot", "context", "open", "bookmark", "read", "close"].includes(args?.action)) return;
	if (action === "journal" && ["snapshot", "read", "start", "stop", "bookmark"].includes(args?.action)) return;
	if (["resume-system", "snapshot", "status", "targets", "viewport", "focus-ui", "start-fixture", "detach", "abort", "close", "profiles"].includes(action)) return;
	if (action === "attach" && args === "owned-fixture") return;
	if (action === "probe" && args?.mode === "offline") return;
	if (["bridge", "game"].includes(action) && args?.action === "snapshot") return;
	if (action === "profiles-manage" && args?.action === "list") return;
	if (action === "workbench" && ["state", "task", "ui-get", "ui-save"].includes(args?.action)) return;
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}

async function physicalProfile(directory) {
	const pending = [directory]; let entries = 0;
	while (pending.length) {
		const parent = pending.pop();
		for (const name of await readdir(parent)) {
			if (++entries > 8192) throw new Error("PORTABLE_SMOKE_PROFILE_TOO_LARGE");
			const path = join(parent, name), info = await lstat(path);
			if (info.isSymbolicLink() || info.isFile() && info.nlink !== 1 || info.isDirectory() && (await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error("PORTABLE_SMOKE_PROFILE_REDIRECTED");
			if (info.isDirectory()) pending.push(path);
		}
	}
}

export async function preparePortableMode(app, argv, env = process.env) {
	const scenario = portableRuntimeScenario(argv), mcpScenario = portableMcpScenario(argv), diagnostic = portableDiagnosticMode(argv), storage = portableStorageCase(argv), command = portableCommandCase(argv), developmentUsage = portableDevelopmentUsageCase(argv);
	if (!argv.includes("--portable-smoke")) return null;
	const allowed = new Set(["--portable-smoke", "--managed-ui", "--smoke-ui"]);
	if (scenario) allowed.add("--portable-runtime-loss=" + scenario);
	if (mcpScenario) allowed.add("--portable-mcp-loss=" + mcpScenario);
	if (diagnostic) allowed.add("--portable-diagnostics");
	if (storage) allowed.add("--portable-storage-fault=" + storage.scenario);
	if (storage?.resume) allowed.add("--portable-storage-resume");
	if (command) allowed.add("--portable-command-loss=" + command.scenario);
	if (command?.resume) allowed.add("--portable-command-resume");
	if (developmentUsage) allowed.add("--portable-development-usage=" + (developmentUsage.multipleProviders ? providerContextPrefix(developmentUsage.summaryFailure) : developmentUsage.interruption ? "context-interrupt-" : developmentUsage.context ? "context-" : "") + developmentUsage.phase);
	if (diagnostic && argv.includes("--managed-ui")) allowed.add("--smoke-diagnostics-ui");
	if ((scenario && scenario !== "idle" || mcpScenario || storage) && argv.includes("--managed-ui")) allowed.add("--smoke-game-ui");
	if (!app.isPackaged || argv.some(arg => arg.startsWith("--") && !allowed.has(arg)) || !/^[a-f0-9-]{36}$/.test(env.COMMANDDECK_PORTABLE_RUN_ID ?? "") || !isAbsolute(env.COMMANDDECK_PORTABLE_ROOT ?? "")) throw new Error("PACKAGED_PORTABLE_SMOKE_REQUIRED");
	const root = await realpath(env.COMMANDDECK_PORTABLE_ROOT), info = await lstat(root);
	if (!info.isDirectory() || dirname(root).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-desktop-smoke-")) throw new Error("PORTABLE_SMOKE_ROOT_INVALID");
	const profile = join(root, argv.includes("--managed-ui") ? "ui-profile" : "supervisor-profile");
	await mkdir(profile, { recursive: true });
	if ((await lstat(profile)).isSymbolicLink() || (await realpath(profile)).toLowerCase() !== profile.toLowerCase()) throw new Error("PORTABLE_SMOKE_PROFILE_REDIRECTED");
	await physicalProfile(profile);
	app.setPath("userData", profile);
	// No user models/provider reference is read by this opt-in, isolated check.
	env.COMMANDDECK_PI_CONFIG_DIR = join(root, "no-user-provider-configuration");
	env.COMMANDDECK_PORTABLE_ROOT = root;
	env.COMMANDDECK_SMOKE_RUN_ID = env.COMMANDDECK_PORTABLE_RUN_ID;
	return { root, runId: env.COMMANDDECK_PORTABLE_RUN_ID };
}
