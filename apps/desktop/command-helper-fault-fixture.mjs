import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { validateCommandWorkspace } from "./command-fault-smoke.mjs";

// Installed only by the trusted initialize message for one isolated packaged
// helper-loss case. The public workbench action allowlist cannot call stop.
export async function createCommandHelperFaultFixture({ context, directory }) {
	if (process.platform !== "win32" || context?.scenario !== "helper" || context.resume !== false || !/^[a-f0-9-]{36}$/.test(context.runId ?? "")) throw new Error("COMMAND_HELPER_FIXTURE_REQUIRED");
	const root = await realpath(context.root), expected = join(root, "supervisor-profile/supervisor", "m1-smoke-" + context.runId);
	if (root !== context.root || dirname(root).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-desktop-smoke-") || directory.toLowerCase() !== expected.toLowerCase() || (await realpath(directory)).toLowerCase() !== expected.toLowerCase()) throw new Error("COMMAND_HELPER_FIXTURE_SCOPE_INVALID");
	await validateCommandWorkspace(context);
	let owned;
	return Object.freeze({
		capture({ child, taskId, host }) {
			const image = relative(join(expected, "command-hosts"), host).replaceAll("\\", "/");
			if (owned || !/^[a-f0-9]{64}\/CommandDeck\.CommandHost\.exe$/i.test(image) || !/^[a-f0-9-]{36}$/.test(taskId) || !Number.isInteger(child?.pid) || child.pid <= 0) throw new Error("COMMAND_HELPER_FIXTURE_OWNER_INVALID");
			const record = { child, taskId, pid: child.pid, exited: false };
			record.exit = new Promise(resolve => { child.once("exit", () => { record.exited = true; resolve(); }); child.once("error", resolve); }); owned = record;
		},
		async stop(taskId) {
			if (!owned || owned.taskId !== taskId || owned.exited || owned.child.exitCode !== null || owned.child.signalCode !== null) throw new Error("COMMAND_HELPER_FIXTURE_NOT_RUNNING");
			owned.child.kill(); let timer;
			try { await Promise.race([owned.exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("COMMAND_HELPER_FIXTURE_EXIT_UNCONFIRMED")), 3000); })]); } finally { clearTimeout(timer); }
			if (!owned.exited) throw new Error("COMMAND_HELPER_FIXTURE_EXIT_UNCONFIRMED");
			return { pid: owned.pid, exitObserved: true };
		},
	});
}
