import { ChildProcess, spawn } from "node:child_process";
import { basename } from "node:path";

const createdUi = new WeakSet();
export function spawnOwnedUi(executable, args, options) {
	const file = basename(executable).toLowerCase();
	const fixture =
		file === "commanddeck.nativehost.exe" &&
		args.length === 1 &&
		args[0] === "--fixture";
	const electron =
		file === "electron.exe" &&
		args.includes("--managed-ui") &&
		!args.includes("--owned-host-fixture");
	if (!fixture && !electron) throw new Error("UI_LAUNCH_ROLE_REJECTED");
	const child = spawn(executable, args, options);
	createdUi.add(child);
	return child;
}

// A spawned ChildProcess retains its OS creation handle. An adopted HWND/PID is not a kill capability.
export function registerOwnedUi(child) {
	if (
		!(child instanceof ChildProcess) ||
		!createdUi.has(child) ||
		!Number.isInteger(child.pid)
	)
		throw new Error("UI_CREATION_HANDLE_REQUIRED");
	const createdPid = child.pid;
	return Object.freeze({
		child,
		terminate(candidate = child) {
			if (candidate !== child || child.pid !== createdPid)
				throw new Error("UI_PROCESS_NOT_REGISTERED");
			return child.kill();
		},
	});
}
