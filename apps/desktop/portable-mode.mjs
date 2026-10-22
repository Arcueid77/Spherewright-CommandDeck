import { realpath, mkdir, lstat } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export function assertPortableAction(action, args) {
	if (["snapshot", "status", "targets", "viewport", "focus-ui", "start-fixture", "detach", "abort", "close", "profiles"].includes(action)) return;
	if (action === "attach" && args === "owned-fixture") return;
	if (action === "probe" && args?.mode === "offline") return;
	if (["bridge", "game"].includes(action) && args?.action === "snapshot") return;
	if (action === "profiles-manage" && args?.action === "list") return;
	if (action === "workbench" && ["state", "ui-get", "ui-save"].includes(args?.action)) return;
	throw new Error("PORTABLE_SMOKE_ACTION_REJECTED");
}

export async function preparePortableMode(app, argv, env = process.env) {
	if (!argv.includes("--portable-smoke")) return null;
	const allowed = new Set(["--portable-smoke", "--managed-ui", "--smoke-ui"]);
	if (!app.isPackaged || argv.some(arg => arg.startsWith("--") && !allowed.has(arg)) || !/^[a-f0-9-]{36}$/.test(env.COMMANDDECK_PORTABLE_RUN_ID ?? "") || !isAbsolute(env.COMMANDDECK_PORTABLE_ROOT ?? "")) throw new Error("PACKAGED_PORTABLE_SMOKE_REQUIRED");
	const root = await realpath(env.COMMANDDECK_PORTABLE_ROOT), info = await lstat(root);
	if (!info.isDirectory() || dirname(root).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-desktop-smoke-")) throw new Error("PORTABLE_SMOKE_ROOT_INVALID");
	const profile = join(root, argv.includes("--managed-ui") ? "ui-profile" : "supervisor-profile");
	await mkdir(profile, { recursive: true });
	if ((await lstat(profile)).isSymbolicLink() || (await realpath(profile)).toLowerCase() !== profile.toLowerCase()) throw new Error("PORTABLE_SMOKE_PROFILE_REDIRECTED");
	app.setPath("userData", profile);
	// No user models/provider reference is read by this opt-in, isolated check.
	env.COMMANDDECK_PI_CONFIG_DIR = join(root, "no-user-provider-configuration");
	return { root, runId: env.COMMANDDECK_PORTABLE_RUN_ID };
}
