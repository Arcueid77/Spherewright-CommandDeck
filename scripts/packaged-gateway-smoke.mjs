import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { bundleExecutable, copyBundleTree, verifyBundle } from "./desktop-bundle-files.mjs";
import { observePackagedProcesses } from "./observe-packaged-processes.mjs";
import { packagedGatewayVersion, readGatewayExitConfig } from "../apps/desktop/agent-gateway-packaged-smoke.mjs";
import { GatewaySmokeClient } from "../apps/desktop/agent-gateway-smoke-client.mjs";
import { runGatewaySdkStages, runOfficialGatewayClient } from "./official-gateway-client.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), args = process.argv.slice(2), runId = randomUUID();
if (process.platform !== "win32" || args.length !== 2 || args[0] !== "--source") throw new Error("EXPLICIT_PACKAGED_GATEWAY_REQUIRED");
const source = await realpath(resolve(root, args[1])), manifest = await verifyBundle(source);
assert.equal(manifest.portableReadOnlyGateway, packagedGatewayVersion, "PACKAGED_GATEWAY_REBUILD_REQUIRED"); assert.equal(manifest.nativeProcessObserver, 1);
const directory = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-"))), copy = join(directory, "bundle"), proofRoot = join(root, ".local/packaged-gateway", runId);
await mkdir(proofRoot, { recursive: true }); await writeFile(join(proofRoot, "context.private.json"), JSON.stringify({ runId, directory, sourceRevision: manifest.sourceRevision }), { flag: "wx" });
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PI_|COMMANDDECK_|NODE_|ELECTRON_|PSModulePath$)|KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(key)));
const env = { ...inherited, PATH: join(process.env.SystemRoot, "System32"), PI_OFFLINE: "1", DOTNET_ROOT: join(directory, "no-shared-dotnet"), DOTNET_ROOT_X64: join(directory, "no-shared-dotnet"), DOTNET_MULTILEVEL_LOOKUP: "0", DOTNET_DISABLE_GUI_ERRORS: "1", COMMANDDECK_PORTABLE_ROOT: directory, COMMANDDECK_PORTABLE_RUN_ID: runId };
const observer = () => observePackagedProcesses({ executable: join(copy, "resources/app/artifacts/native/CommandDeck.NativeHost.exe"), roots: [directory], env });
let passed = false; const phases = [], afterExitPeers = [], officialSdk = [];
try {
	await copyBundleTree(source, copy); await verifyBundle(copy);
	for (const phase of ["record", "reopen"]) {
		assert.equal((await observer()).count, 0);
		const child = spawn(join(copy, bundleExecutable), ["--portable-smoke", "--portable-gateway=" + phase], { cwd: directory, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", timedOut = false; child.stdout.on("data", bytes => { output = (output + bytes).slice(-16384); }); child.stderr.on("data", bytes => { output = (output + bytes).slice(-16384); });
		let exited = false; child.once("exit", () => { exited = true; });
		const sdkPending = phase === "record" ? runGatewaySdkStages({ root: directory, runId }, join(copy, bundleExecutable), join(copy, "resources/app/apps/desktop/agent-gateway-stdio.mjs"), () => exited).then(results => ({ results }), error => ({ error })) : Promise.resolve({ results: [] });
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 90000); let code, signal; try { [code, signal] = await once(child, "exit"); } finally { clearTimeout(timer); }
		const sdkResult = await sdkPending; await writeFile(join(proofRoot, phase + "-sdk.json"), JSON.stringify({ results: sdkResult.results ?? [], failed: Boolean(sdkResult.error) }), { flag: "wx" });
		await writeFile(join(proofRoot, phase + "-exit.private.json"), JSON.stringify({ runId, phase, code, signal, timedOut, output }), { flag: "wx" });
		let observed; const deadline = performance.now() + 25000; do { observed = await observer(); if (!observed.count) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (performance.now() < deadline);
		await writeFile(join(proofRoot, phase + "-process-observation.private.json"), JSON.stringify(observed), { flag: "wx" }); assert.equal(observed.count, 0); assert.equal(timedOut, false); assert.equal(code, 0, signal ?? output);
		if (sdkResult.error) throw sdkResult.error; officialSdk.push(...sdkResult.results);
		const proof = JSON.parse(await readFile(join(directory, "gateway-" + phase + "-application.json"), "utf8"));
		assert.equal(proof.runId, runId); assert.equal(proof.phase, phase); assert.equal(proof.sourceRevision, manifest.sourceRevision); assert.equal(proof.piCommit, manifest.piCommit); assert.equal(proof.packaged, true);
		for (const field of ["rendererNodeDisabled", "zeroDevelopmentAndGameTasks", "credentialsNotRendered"]) assert.equal(proof[field], true);
		for (const field of ["gameCalls", "realModelRequests", "syntheticModelRequests"]) assert.equal(proof[field], 0);
		if (phase === "record") for (const field of ["mechaReadOnlyPanelVerified", "mechaExplicitOptInVerified", "mechaPauseAndResumeVerified", "mechaPrivateFieldsOmitted", "mechaUiReloadRetainsSameObserver", "mechaEnabledBeforeDisconnect"]) assert.equal(proof[field], true, field);
		if (phase === "reopen") assert.equal(proof.mechaDefaultOffAfterApplicationRestart, true);
		assert.equal(proof.externalPeerExits.length, phase === "record" ? 3 : 2); for (const exit of proof.externalPeerExits) { assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.stderrBytes, 0); }
		if (phase === "record") for (const field of ["readOnlyGateway", "copiedConfigurationAccepted", "protocolToolScopeVerified", "freshAndStaleCacheVerified", "noExtraMcpRequestsAfterDisconnect", "uiReloadRetainsGateway", "oldConfigRevokedAfterRestart", "suspendRevokesWithoutAutomaticReopen", "sameRuntimeWithoutModelReplay", "ownServerExitConfirmed", "gatewayEnabledBeforeApplicationExit"]) assert.equal(proof[field], true);
		else for (const field of ["defaultOffAfterApplicationRestart", "noAutomaticBridgeConnection", "oldConfigurationRejectedAfterApplicationRestart", "freshConfigurationReadsOnlyUnavailableCache"]) assert.equal(proof[field], true);
		// Reuse the exact UI-produced config after the complete app has exited.
		// The peer still initializes, but the retired pipe must refuse observation.
		const config = await readGatewayExitConfig({ root: directory }, join(copy, bundleExecutable), join(copy, "resources/app/apps/desktop/agent-gateway-stdio.mjs"));
		const peer = new GatewaySmokeClient(config, directory);
		try { assert.equal((await peer.initialize()).result.protocolVersion, "2025-11-25"); const denied = (await peer.observe({ section: "status" })).result; assert.equal(denied.isError, true); assert.equal(denied.content[0].text, "GATEWAY_UNAVAILABLE"); }
		finally { afterExitPeers.push(await peer.close()); }
		for (const mode of ["legacy", "auto"]) officialSdk.push({ ...await runOfficialGatewayClient(config, directory, { stage: "closed", mode }), afterPhase: phase });
		assert.equal((await observer()).count, 0);
		await writeFile(join(proofRoot, phase + "-application.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); phases.push(proof); await verifyBundle(copy);
	}
	await verifyBundle(source);
	assert.equal(officialSdk.length, 8);
	const proof = { packagedReadOnlyGateway: "passed", runId, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, applicationRuns: 2, phases, afterExitPeers, officialSdk, officialClientSdkVerified: true, oldConfigurationRevokedOnApplicationExit: true, applicationRestartDefaultsOff: true, independentlyObservedOwnedImagesExited: true, completeBundlesUnchanged: true, outsideSourceCheckout: true, usesBundledNodeOnly: true, clientSdkRunsInTestController: true, gameCalls: 0, modelRequests: 0, physicalInputVerified: false, clipboardOsWriteVerified: false, actualOsSleepVerified: false, thirdPartyClientVerified: false };
	await writeFile(join(proofRoot, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" }); await writeFile(join(root, ".local/packaged-gateway-smoke.json"), JSON.stringify(proof, null, 2)); passed = true;
	console.log(JSON.stringify({ packagedReadOnlyGateway: "passed", runId, sourceRevision: manifest.sourceRevision, applicationRuns: 2, gameCalls: 0, modelRequests: 0 }));
} finally {
	if (passed) { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
