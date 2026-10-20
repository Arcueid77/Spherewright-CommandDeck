import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const runId = randomUUID();
const file = args.includes("--smoke-adapter")
	? "desktop-smoke-adapter.json"
	: args.includes("--smoke-host-exit")
	? "desktop-smoke-host-exit.json"
	: args.includes("--smoke-recovery-limit")
		? "desktop-smoke-recovery-limit.json"
		: args.includes("--smoke-live")
			? "desktop-smoke-live.json"
			: "desktop-smoke.json";
const executable = join(root, "node_modules/electron/dist/electron.exe");
const child = spawn(executable, [root, "--smoke", ...args], {
	cwd: root,
	stdio: "inherit",
	windowsHide: false,
	env: { ...process.env, COMMANDDECK_SMOKE_RUN_ID: runId },
});
const timer = setTimeout(() => child.kill(), 120000);
const [code, signal] = await once(child, "exit");
clearTimeout(timer);
assert.equal(code, 0, signal ?? "Desktop smoke failed");
const result = JSON.parse(await readFile(join(root, ".local", file), "utf8"));
assert.equal(
	result.runId,
	runId,
	"This process exited without writing its own complete proof",
);
if (args.includes("--smoke-adapter"))
	assert.equal(result.normalDetachRestoresBoth, true);
else if (args.includes("--smoke-host-exit"))
	assert.equal(result.hostExit.hostNotRelaunched, true);
else assert.equal(result.supervision.inFlightProbeCompletedAfterUiExit, true);
console.log(
	JSON.stringify({ desktopSmoke: "passed", proof: file, noGameCalls: true }),
);
