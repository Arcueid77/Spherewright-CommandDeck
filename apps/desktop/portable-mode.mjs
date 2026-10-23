import { realpath, mkdir, lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export const portableRuntimeScenarios = Object.freeze(["idle", "confirmation", "accepted", "planning"]);
export const portableMcpScenarios = Object.freeze(["accepted", "lost-ack"]);
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
	if (["snapshot", "status", "targets", "viewport", "focus-ui", "start-fixture", "detach", "abort", "close", "profiles"].includes(action)) return;
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
	const scenario = portableRuntimeScenario(argv), mcpScenario = portableMcpScenario(argv);
	if (!argv.includes("--portable-smoke")) return null;
	const allowed = new Set(["--portable-smoke", "--managed-ui", "--smoke-ui"]);
	if (scenario) allowed.add("--portable-runtime-loss=" + scenario);
	if (mcpScenario) allowed.add("--portable-mcp-loss=" + mcpScenario);
	if ((scenario && scenario !== "idle" || mcpScenario) && argv.includes("--managed-ui")) allowed.add("--smoke-game-ui");
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
