import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeExecutable } from "./native-client.mjs";
import { registerOwnedUi } from "./owned-ui-process.mjs";

const execute = promisify(execFile);

// Inspect only a UI created by this supervisor, even after its native parent has exited.
export async function inspectOwnedUi(record, { responsiveness = false } = {}) {
	registerOwnedUi(record.child);
	if (
		record.child.exitCode !== null ||
		record.child.signalCode !== null ||
		typeof record.hwnd !== "string" ||
		!/^[1-9][0-9]{0,19}$/.test(record.hwnd)
	)
		throw new Error("OWNED_UI_NOT_LIVE");
	const started = performance.now();
	const { stdout } = await execute(
		nativeExecutable,
		[responsiveness ? "--probe-ui" : "--inspect-ui", record.hwnd, String(record.child.pid)],
		{ windowsHide: true, timeout: responsiveness ? 2000 : 5000, maxBuffer: 4096 },
	);
	return { ...JSON.parse(stdout), totalProbeMs: Math.round(performance.now() - started) };
}
