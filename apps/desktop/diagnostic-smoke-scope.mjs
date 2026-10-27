import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

export function sourceDiagnosticMode(argv) {
	const flags = argv.filter(arg => arg.startsWith("--smoke-diagnostics"));
	if (!flags.length) return false;
	const managed = argv.includes("--managed-ui"), expected = managed ? "--smoke-diagnostics-ui" : "--smoke-diagnostics";
	const allowed = new Set(managed ? ["--managed-ui", "--smoke-ui", expected] : ["--smoke", expected]);
	if (flags.length !== 1 || flags[0] !== expected || !argv.includes(managed ? "--smoke-ui" : "--smoke") || argv.some(arg => arg.startsWith("--") && !allowed.has(arg))) throw new Error("EXPLICIT_DIAGNOSTIC_SMOKE_REQUIRED");
	return true;
}

export async function prepareSourceDiagnosticMode(app, argv, env = process.env) {
	if (!sourceDiagnosticMode(argv)) return null;
	if (app.isPackaged || !/^[a-f0-9-]{36}$/.test(env.COMMANDDECK_SMOKE_RUN_ID ?? "") || !isAbsolute(env.COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT ?? "")) throw new Error("EXPLICIT_DIAGNOSTIC_SMOKE_REQUIRED");
	const root = await realpath(env.COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT), info = await lstat(root);
	if (!info.isDirectory() || info.isSymbolicLink() || dirname(root).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-diagnostics-smoke-")) throw new Error("DIAGNOSTIC_FIXTURE_ROOT_INVALID");
	const profile = join(root, argv.includes("--managed-ui") ? "ui-profile" : "supervisor-profile");
	await mkdir(profile, { recursive: true });
	if ((await lstat(profile)).isSymbolicLink() || (await realpath(profile)).toLowerCase() !== profile.toLowerCase()) throw new Error("DIAGNOSTIC_FIXTURE_ROOT_INVALID");
	app.setPath("userData", profile);
	env.COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT = root;
	env.COMMANDDECK_PI_CONFIG_DIR = join(root, "no-user-provider-configuration");
	return { root, runId: env.COMMANDDECK_SMOKE_RUN_ID };
}

export function assertDiagnosticSmokeAction(action, args) {
	if (action === "recording" && args?.action === "snapshot") return;
	if (["snapshot", "status", "targets", "viewport", "focus-ui", "abort", "close", "profiles", "diagnostics-preview", "diagnostics-begin-save", "diagnostics-write", "diagnostics-cancel-save", "diagnostics-discard"].includes(action)) return;
	if (["bridge", "game"].includes(action) && args?.action === "snapshot") return;
	if (action === "profiles-manage" && args?.action === "list") return;
	if (action === "workbench" && ["state", "task", "ui-get", "ui-save"].includes(args?.action)) return;
	throw new Error("DIAGNOSTIC_SMOKE_ACTION_REJECTED");
}
