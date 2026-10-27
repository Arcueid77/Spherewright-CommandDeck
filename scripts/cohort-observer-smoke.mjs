import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile, copyFile, constants, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { NativeClient, nativeExecutable } from "../apps/desktop/native-client.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";

if (process.platform !== "win32") throw new Error("WINDOWS_COHORT_OBSERVER_REQUIRED");
const root = fileURLToPath(new URL("../", import.meta.url)), empty = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-process-observer-"))), native = await realpath(dirname(nativeExecutable));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
let fixture, stopped = false, nodeChild, nodeExit, nodeStopped = false;
try {
	const zero = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty], env }); assert.equal(zero.count, 0);
	await assert.rejects(observePackagedProcesses({ executable: nativeExecutable, roots: [join(empty, "missing")], env }), /OBSERVATION_UNAVAILABLE/);
	fixture = new NativeClient(["--fixture"], nativeExecutable); await fixture.ready;
	const live = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty, native], env });
	assert.equal(live.count, 1);
	const member = live.members.find(item => item.pid === fixture.child.pid); assert.ok(member); assert.equal(member.rootIndex, 1); assert.equal(member.relativeImage, "CommandDeck.NativeHost.exe");
	assert.equal(fixture.child.exitCode, null); assert.ok(!live.members.some(item => item.pid === live.observerPid));
	const exit = once(fixture.child, "exit"); fixture.child.stdin.write("close\n"); const [code] = await exit; assert.equal(code, 0); stopped = true;
	const after = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty, native], env }); assert.equal(after.count, 0);
	const nodeImage = join(empty, "node.exe"); await copyFile(process.execPath, nodeImage, constants.COPYFILE_EXCL);
	const nodeEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/API.?KEY|TOKEN|SECRET|PASSWORD|^PI_|^NODE_OPTIONS$|^ELECTRON_/i.test(key)));
	nodeChild = spawn(nodeImage, ["-e", "process.stdin.resume(); process.stdin.once('end', () => process.exit(0)); setTimeout(() => process.exit(2), 15000); process.stdout.write('NODE_OBSERVER_READY\\n');"], { env: nodeEnv, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
	nodeExit = once(nodeChild, "exit");
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("NODE_OBSERVER_READY_TIMEOUT")), 10000); let output = "";
		nodeChild.once("error", error => { clearTimeout(timer); reject(error); });
		nodeChild.stdout.on("data", chunk => { output += chunk.toString(); if (output === "NODE_OBSERVER_READY\n") { clearTimeout(timer); resolve(); } else if (output.length > 128) { clearTimeout(timer); reject(new Error("NODE_OBSERVER_OUTPUT_INVALID")); } });
		nodeExit.then(() => { clearTimeout(timer); reject(new Error("NODE_OBSERVER_EXITED_BEFORE_READY")); }, reject);
	});
	const defaultNode = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty], env }); assert.equal(defaultNode.count, 0); assert.equal(defaultNode.nodeImagesIncluded, false);
	const liveNode = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty], env, includeNode: true }); assert.equal(liveNode.count, 1);
	assert.equal(liveNode.members[0].pid, nodeChild.pid); assert.equal(liveNode.members[0].rootIndex, 0); assert.equal(liveNode.members[0].relativeImage, "node.exe"); assert.equal(nodeChild.exitCode, null);
	nodeChild.stdin.end(); const [nodeCode] = await nodeExit; assert.equal(nodeCode, 0); nodeStopped = true;
	const afterNode = await observePackagedProcesses({ executable: nativeExecutable, roots: [empty], env, includeNode: true }); assert.equal(afterNode.count, 0);
	const nodeSha256 = createHash("sha256").update(await readFile(nodeImage)).digest("hex");
	const proof = { processCohortObserver: "passed", actualNativeFixtureObserved: true, observerExcludedOnlyByOwnPid: true, exactRootsAndBirths: true, fixtureNotTerminatedByObserver: true, normalFixtureExit: true, scopedNodeObservedOnlyWhenRequested: true, copiedNodeSha256: nodeSha256, normalNodeExit: true, noOwnedProcessesRemain: true, gameCalls: 0, realModelRequests: 0 };
	await mkdir(join(root, ".local"), { recursive: true }); await writeFile(join(root, ".local/process-cohort-observer.json"), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally {
	if (fixture && !stopped && fixture.child.exitCode === null) { const exit = once(fixture.child, "exit"); fixture.child.stdin.write("close\n"); await exit; stopped = true; }
	if (nodeChild && !nodeStopped) { if (nodeChild.exitCode === null && nodeChild.signalCode === null) nodeChild.stdin.end(); await nodeExit; nodeStopped = true; }
	if ((!fixture || stopped) && (!nodeChild || nodeStopped)) { const canonical = await realpath(empty); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-process-observer-")); await rm(canonical, { recursive: true }); }
}
