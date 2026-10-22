import assert from "node:assert/strict";
import { app } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareCommandHost, runManagedCommand } from "./command-host.mjs";

export async function runPortableSmoke(driver) {
	const { root, context, api, testCommand, getRuntimePid, getProbeSequence, getUi, privateDirectory } = driver;
	async function settledUi() { const until = performance.now() + 5000; while (getUi()?.nativeProbePending) { assert.ok(performance.now() < until, "UI_NATIVE_PROBE_DID_NOT_SETTLE"); await new Promise(resolve => setTimeout(resolve, 25)); } }
	assert.equal(app.isPackaged, true);
	const manifest = JSON.parse(await readFile(join(root, "../../commanddeck-bundle.json"), "utf8"));
	const runtimePid = getRuntimePid(), shown = await testCommand("show-ui"); assert.equal(shown.visible, true);
	let renderer; const rendererDeadline = performance.now() + 10000;
	while (true) {
		renderer = await testCommand("portable-renderer-state");
		if (renderer.brand?.includes("COMMANDDECK") && renderer.groups > 0 && renderer.body > 100) break;
		if (performance.now() >= rendererDeadline) throw new Error("PORTABLE_RENDERER_NOT_READY " + JSON.stringify(renderer));
		await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.equal(renderer.noNode, true); assert.equal(renderer.hasBridge, true); assert.deepEqual(renderer.errors, []);
	const state = await api("workbench", { action: "state" }); assert.equal(state.roots.length, 0); assert.equal(state.tasks.length, 0);
	await assert.rejects(api("bridge-select", "C:\\not-a-server.exe"), /PORTABLE_SMOKE_ACTION_REJECTED/);
	await assert.rejects(api("game", { action: "start" }), /PORTABLE_SMOKE_ACTION_REJECTED/);
	await assert.rejects(api("probe", { mode: "live" }), /PORTABLE_SMOKE_ACTION_REJECTED/);
	await settledUi(); const result = await api("probe", { mode: "offline" });
	assert.equal(result.requestCount, 2); assert.equal(result.executed, 1); assert.equal(result.gameCalls, 0); assert.equal(result.sourceCommit, manifest.piCommit);
	await testCommand("reload"); assert.equal(getRuntimePid(), runtimePid);
	const after = await api("snapshot"); assert.equal(after.lastProbeResult.requestCount, 2); assert.equal(after.lastProbeResult.executed, 1);
	assert.equal(getProbeSequence(), 1);
	await settledUi(); await api("start-fixture"); await settledUi(); await api("attach", "owned-fixture");
	const attached = await api("status"); assert.equal(attached.nativeParentMatches, true); assert.equal(attached.gameParentMatches, true); assert.equal(attached.gameAlive, true);
	await api("detach"); const detached = await api("status"); assert.equal(detached.attached, false); assert.equal(detached.gameAlive, true);
	const host = await prepareCommandHost(join(root, "artifacts/commands"), join(privateDirectory, "portable-command-cache"));
	assert.equal(host.selfContained, true);
	const command = await runManagedCommand({ host: host.executable, executable: join(process.env.SystemRoot, "System32/where.exe"), args: ["/Q", "CommandDeck-Smoke-Missing-" + context.runId], cwd: privateDirectory, timeoutMs: 5000 });
	assert.equal(command.exitCode, 1); assert.equal(command.treeConfirmed, true); assert.equal(command.streamsDrained, true);
	const proof = { runId: context.runId, sourceRevision: manifest.sourceRevision, piCommit: result.sourceCommit, packaged: true, visibleRenderer: true, rendererNodeDisabled: true, emptyIsolatedWorkspace: true, userProfilesUntouched: true, externalActionsRejected: true, embeddedPiRoundtrip: true, syntheticModelRequests: 2, syntheticTools: 1, uiReloadRetainsRuntimeAndResult: true, noModelReplay: true, ownNativeFixtureEmbeddedAndDetached: true, selfContainedCommandCache: true, commandExitCode: 1, commandTreeAndStreamsConfirmed: true, gameCalls: 0, realModelRequests: 0, cleanWindowsVmVerified: false, installerVerified: false };
	await writeFile(join(context.root, "application-proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
}
