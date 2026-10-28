import assert from "node:assert/strict";
import { readFile, writeFile, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { gatewaySmokeUi, runGatewaySmoke } from "./agent-gateway-smoke.mjs";
import { GatewaySmokeClient } from "./agent-gateway-smoke-client.mjs";
import { gatewayConnection } from "./agent-gateway-wire.mjs";

export const packagedGatewayVersion = 2;
export function assertGatewayFixtureConfig(config, command, script) {
	assert.deepEqual(Object.keys(config).sort(), ["args", "command", "env"]); assert.equal(config.command, command); assert.deepEqual(config.args, [script]);
	assert.deepEqual(Object.keys(config.env).sort(), ["COMMANDDECK_GATEWAY_KEY", "COMMANDDECK_GATEWAY_PIPE", "ELECTRON_RUN_AS_NODE"]); assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
	gatewayConnection({ pipe: config.env.COMMANDDECK_GATEWAY_PIPE, key: config.env.COMMANDDECK_GATEWAY_KEY }); return config;
}
export async function readGatewayExitConfig(context, command, script) {
	const file = join(context.root, "gateway-exit-config.private.json"), info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size < 8192);
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const config = JSON.parse(await readFile(file, "utf8"));
	return assertGatewayFixtureConfig(config, command, script);
}

export async function runPackagedGatewaySmoke(driver, manifest) {
	const { context, gatewayCase } = driver;
	assert.equal(manifest.portableReadOnlyGateway, packagedGatewayVersion);
	const empty = async () => {
		const work = await driver.api("workbench", { action: "state" }), game = await driver.api("game", { action: "snapshot" });
		assert.deepEqual(work.roots, []); assert.deepEqual(work.tasks, []); assert.equal(work.executionBlocked, false);
		assert.deepEqual(game.tasks, []); assert.deepEqual(game.unresolved, []); assert.equal(game.developmentFrozen, false); assert.equal(game.syntheticOnly, true); assert.equal(driver.getProbeSequence(), 0);
	};
	await empty(); let proof;
	if (gatewayCase.phase === "record") proof = await runGatewaySmoke(driver);
	else {
		assert.equal(gatewayCase.phase, "reopen");
		const { state, open, click, copy, until } = gatewaySmokeUi(driver), runtime = driver.getRuntimePid();
		assert.equal((await state()).enabled, false);
		const bridge = await driver.api("bridge", { action: "snapshot" }); assert.equal(bridge.selected, null); assert.equal(driver.getBridgePid(), undefined);
		const oldConfig = await readGatewayExitConfig(context, process.execPath, join(driver.root, "apps/desktop/agent-gateway-stdio.mjs"));
		const peers = [], exits = []; const peerFor = async config => { const peer = new GatewaySmokeClient(config, context.root); peers.push(peer); assert.equal((await peer.initialize()).result.protocolVersion, "2025-11-25"); return peer; };
		try {
			const oldPeer = await peerFor(oldConfig); assert.equal((await oldPeer.observe({ section: "status" })).result.isError, true);
			await open(); await click("开启只读网关"); await until(async () => (await state()).enabled, "FRESH_REOPEN");
			const config = await copy(); assert.notEqual(config.env.COMMANDDECK_GATEWAY_PIPE, oldConfig.env.COMMANDDECK_GATEWAY_PIPE); assert.notEqual(config.env.COMMANDDECK_GATEWAY_KEY, oldConfig.env.COMMANDDECK_GATEWAY_KEY);
			const peer = await peerFor(config); const fresh = (await peer.observe({ section: "research" })).result;
			assert.equal(fresh.isError, false); assert.equal(fresh.structuredContent.state, "unavailable"); assert.equal(fresh.structuredContent.data, null); assert.equal(fresh.structuredContent.connected, false);
			assert.equal((await oldPeer.observe({ section: "research" })).result.isError, true);
			await click("关闭网关"); await until(async () => !(await state()).enabled && !(await state()).busy, "REOPEN_CLOSED"); assert.equal((await peer.observe({ section: "status" })).result.isError, true);
			assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getBridgePid(), undefined); assert.equal((await driver.api("bridge", { action: "snapshot" })).selected, null);
			while (peers.length) { exits.push(await peers[0].close()); peers.shift(); }
			proof = { runId: context.runId, defaultOffAfterApplicationRestart: true, noAutomaticBridgeConnection: true, oldConfigurationRejectedAfterApplicationRestart: true, freshConfigurationReadsOnlyUnavailableCache: true, credentialsNotRendered: true, externalPeerExits: exits, gameCalls: 0, realModelRequests: 0, syntheticModelRequests: 0, physicalInputVerified: false, clipboardOsWriteVerified: false, actualOsSleepVerified: false };
		} finally { for (const peer of peers) await peer.close().catch(() => {}); }
	}
	await empty();
	Object.assign(proof, { phase: gatewayCase.phase, sourceRevision: manifest.sourceRevision, piCommit: manifest.piCommit, packaged: true, rendererNodeDisabled: true, zeroDevelopmentAndGameTasks: true });
	await writeFile(join(context.root, "gateway-" + gatewayCase.phase + "-application.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
}
