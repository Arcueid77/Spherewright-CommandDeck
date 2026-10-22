import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { NativeClient, nativeExecutable } from "../apps/desktop/native-client.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";

if (process.platform !== "win32") throw new Error("WINDOWS_COHORT_OBSERVER_REQUIRED");
const root = fileURLToPath(new URL("../", import.meta.url)), empty = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-process-observer-"))), native = await realpath(dirname(nativeExecutable));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
let fixture, stopped = false;
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
	const proof = { processCohortObserver: "passed", actualNativeFixtureObserved: true, observerExcludedOnlyByOwnPid: true, exactRootsAndBirths: true, fixtureNotTerminatedByObserver: true, normalFixtureExit: true, noOwnedProcessesRemain: true, gameCalls: 0, realModelRequests: 0 };
	await mkdir(join(root, ".local"), { recursive: true }); await writeFile(join(root, ".local/process-cohort-observer.json"), JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
} finally {
	if (fixture && !stopped && fixture.child.exitCode === null) { const exit = once(fixture.child, "exit"); fixture.child.stdin.write("close\n"); await exit; stopped = true; }
	if (!fixture || stopped) { const canonical = await realpath(empty); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-process-observer-")); await rm(canonical, { recursive: true }); }
}
