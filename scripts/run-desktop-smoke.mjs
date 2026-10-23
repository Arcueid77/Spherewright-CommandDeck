import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp, cp, rename, realpath, rm, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, basename, relative, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const renamedElectron = args.includes("--renamed-electron");
if (renamedElectron) args.splice(args.indexOf("--renamed-electron"), 1);
const runId = randomUUID();
const runtimeLoss = args.includes("--smoke-runtime-loss");
const file = runtimeLoss ? args.includes("--smoke-game") ? args.includes("--smoke-runtime-accepted") ? "desktop-smoke-game-runtime-accepted.json" : args.includes("--smoke-runtime-planning") ? "desktop-smoke-game-runtime-planning.json" : "desktop-smoke-game-runtime-loss.json" : "desktop-smoke-runtime-loss.json" : args.includes("--smoke-observation") ? "desktop-smoke-observation.json" : args.includes("--smoke-game") ? "desktop-smoke-game.json" : args.includes("--smoke-bridge") ? "desktop-smoke-bridge.json" : args.includes("--smoke-workbench")
	? "desktop-smoke-workbench.json"
	: args.includes("--smoke-adapter")
	? "desktop-smoke-adapter.json"
	: args.includes("--smoke-host-exit")
	? "desktop-smoke-host-exit.json"
	: args.includes("--smoke-recovery-limit")
		? "desktop-smoke-recovery-limit.json"
		: args.includes("--smoke-live")
			? "desktop-smoke-live.json"
			: "desktop-smoke.json";
let executable = join(root, "node_modules/electron/dist/electron.exe"), temporary, child;
try {
if (renamedElectron) {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-renamed-ui-")));
	const distribution = join(temporary, "electron");
	await cp(join(root, "node_modules/electron/dist"), distribution, { recursive: true, force: false, errorOnExist: true });
	const original = await realpath(join(distribution, "electron.exe"));
	executable = join(distribution, "Spherewright-CommandDeck.exe");
	const destination = relative(await realpath(temporary), executable);
	assert.ok(destination && !isAbsolute(destination) && destination !== ".." && !destination.startsWith(".." + sep));
	assert.equal(dirname(original).toLowerCase(), (await realpath(distribution)).toLowerCase());
	await rename(original, executable);
}
child = spawn(executable, [root, "--smoke", ...args], {
	cwd: root,
	stdio: "inherit",
	windowsHide: false,
	env: { ...process.env, COMMANDDECK_SMOKE_RUN_ID: runId },
});
const timer = setTimeout(() => child.kill(), 120000);
let code, signal;
try { [code, signal] = await once(child, "exit"); }
finally { clearTimeout(timer); }
assert.equal(code, 0, signal ?? "Desktop smoke failed");
const result = JSON.parse(await readFile(join(root, ".local", runtimeLoss ? file.replace(".json", ".application.private.json") : file), "utf8"));
assert.equal(
	result.runId,
	runId,
	"This process exited without writing its own complete proof",
);
if (runtimeLoss) { assert.equal(result.runtimeExitObserved, true); if (args.includes("--smoke-game")) { assert.equal(result.syntheticGameCommits, args.includes("--smoke-runtime-accepted") ? 1 : 0); assert.equal(result.ownServerExitConfirmed, true); } else assert.equal(result.noProbeAllocated, true); }
else if (args.includes("--smoke-observation")) { assert.equal(result.readOnlyEnforced,true); assert.equal(result.toolRequests,12); assert.equal(result.ownServerExitConfirmed,true); }
else if (args.includes("--smoke-game")) { assert.equal(result.syntheticGameCommits, 1); assert.equal(result.ownServerExitConfirmed, true); }
else if (args.includes("--smoke-bridge")) assert.equal(result.ownServerExitConfirmed, true);
else if (args.includes("--smoke-workbench")) assert.equal(result.checkStarts, 1);
else if (args.includes("--smoke-adapter"))
	assert.equal(result.normalDetachRestoresBoth, true);
else if (args.includes("--smoke-host-exit"))
	assert.equal(result.hostExit.hostNotRelaunched, true);
else assert.equal(result.supervision.inFlightProbeCompletedAfterUiExit, true);
if (runtimeLoss) {
	const proofRoot = join(root, ".local/runtime-loss", runId); await mkdir(proofRoot, { recursive: true });
	await writeFile(join(proofRoot, "application-proof.private.json"), JSON.stringify(result), { flag: "wx" });
	const observation = await observePackagedProcesses({ executable: join(root, "artifacts/native/CommandDeck.NativeHost.exe"), roots: [dirname(executable)], env: process.env, timeoutMs: 20000 });
	await writeFile(join(proofRoot, "process-observation.private.json"), JSON.stringify(observation), { flag: "wx" }); assert.equal(observation.count, 0);
	await writeFile(join(root, ".local", file), JSON.stringify({ ...result, noOwnedElectronProcessesRemain: true, processObserver: "native-v1", usesSourceCheckout: true, fullPackagedFaultMatrixVerified: false }));
}
if (renamedElectron) await writeFile(join(root, ".local/desktop-smoke-renamed-ui.json"), JSON.stringify({ ...result, renamedElectron: true, usesSourceCheckout: true, fullElectronBundleVerified: false }, null, 2));
console.log(
	JSON.stringify({ desktopSmoke: "passed", proof: file, noGameCalls: true, ...(renamedElectron ? { renamedElectron: true, fullElectronBundleVerified: false } : {}) }),
);
} finally {
	if (temporary) {
		if (child?.pid && child.exitCode === null && child.signalCode === null) throw new Error("RENAMED_UI_PROCESS_EXIT_UNCONFIRMED");
		const canonical = await realpath(temporary);
		assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
		assert.ok(basename(canonical).startsWith("commanddeck-renamed-ui-"));
		await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}
