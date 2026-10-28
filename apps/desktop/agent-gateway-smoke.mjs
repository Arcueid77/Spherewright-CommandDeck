import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GatewaySmokeClient } from "./agent-gateway-smoke-client.mjs";

export function gatewaySmokeUi(driver) {
	const evaluate = source => driver.testCommand("evaluate", { source }), state = () => driver.api("gateway", { action: "snapshot" });
	const until = async (predicate, label) => { const end = performance.now() + 10000; while (!await predicate()) { assert.ok(performance.now() < end, "GATEWAY_SMOKE_TIMEOUT_" + label); await new Promise(resolve => setTimeout(resolve, 40)); } };
	const open = async () => { await until(() => evaluate("[...document.querySelectorAll('header button')].some(button=>button.textContent==='外部 Agent'&&!button.disabled)"), "HEADER"); await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='外部 Agent').click();true"); await until(() => evaluate("Boolean(document.querySelector('[aria-label=\"外部 Agent 只读网关\"]'))"), "PANEL"); };
	const click = async label => { const selector = `[...document.querySelectorAll('[aria-label="外部 Agent 只读网关"] button')].find(button=>button.textContent===${JSON.stringify(label)}&&!button.disabled)`; await until(() => evaluate(`Boolean(${selector})`), "BUTTON"); await evaluate(`${selector}.click();true`); };
	const copy = async () => { await click("复制 MCP 配置"); await until(() => evaluate("document.querySelector('[aria-label=\"外部 Agent 只读网关\"] [role=status]')?.textContent.includes('已复制')===true"), "COPIED"); const config = driver.getGatewayConfigurationForSmoke()?.mcpServers?.["spherewright-commanddeck"]; assert.equal(config.command, process.execPath); assert.deepEqual(config.args, [join(driver.root, "apps/desktop/agent-gateway-stdio.mjs")]); assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1"); assert.ok(!String(await evaluate("document.body.innerText")).includes(config.env.COMMANDDECK_GATEWAY_KEY)); return config; };
	return { evaluate, state, until, open, click, copy };
}

export async function runGatewaySmoke(driver) {
	const directory = driver.context?.root ?? join(driver.root, ".local/gateway-smoke", driver.runId), fixtureRoot = driver.gatewayFixtureDirectory ?? join(driver.root, ".local/m2-smoke", driver.runId);
	await mkdir(directory, { recursive: true }); await mkdir(fixtureRoot, { recursive: true });
	const marker = join(fixtureRoot, "Spherewright.Mcp.exe"); await writeFile(marker, "OWNED_M2_SYNTHETIC_FIXTURE", { flag: "wx" });
	const { evaluate, state, until, open, click, copy } = gatewaySmokeUi(driver);
	const peers = [], exits = []; const peerFor = async config => { const peer = new GatewaySmokeClient(config, driver.root); peers.push(peer); assert.equal((await peer.initialize()).result.protocolVersion, "2025-11-25"); return peer; };
	const runtime = driver.getRuntimePid(), probes = driver.getProbeSequence(); assert.equal(probes, 0); assert.equal((await state()).enabled, false);
	try {
		await assert.rejects(driver.api("gateway", { action: "start" }), /TRUSTED_UI_REQUIRED/);
		await driver.api("bridge-select", marker); await driver.api("bridge", { action: "refresh" });
		await until(async () => (await driver.api("bridge", { action: "snapshot" })).observation?.production?.data?.coverage?.complete === true, "CACHE");
		await open(); await click("开启只读网关"); await until(async () => (await state()).enabled, "ENABLED");
		const firstConfig = await copy(), firstPeer = await peerFor(firstConfig), listed = await firstPeer.request("tools/list"); assert.equal(listed.result.tools.length, 1); assert.equal(listed.result.tools[0].annotations.readOnlyHint, true);
		const fresh = (await firstPeer.observe({ section: "production", limit: 1 })).result.structuredContent; assert.equal(fresh.state, "observed"); assert.equal(fresh.planets[0].production[0].actualProductionPerMinute, 24);
		assert.ok((await firstPeer.request("tools/call", { name: "commit", arguments: {} })).error);
		await driver.api("bridge", { action: "disconnect" }); assert.equal(driver.bridgeExitConfirmed(), true);
		const before = (await driver.api("bridge", { action: "snapshot" })).requestPerformance.started;
		for (const section of ["status", "research", "production", "power", "logistics"]) {
			const reply = await firstPeer.observe({ section }); assert.equal(reply.result.isError, false); const value = reply.result.structuredContent;
			assert.equal(value.cachedOnly, true); assert.equal(value.connected, false); assert.ok(!JSON.stringify(value).includes("PRIVATE_SYNTHETIC")); if (section !== "status") assert.equal(value.state, "stale");
		}
		const next = (await firstPeer.observe({ section: "production", snapshotId: fresh.snapshotId, offset: 1, limit: 1 })).result.structuredContent; assert.equal(next.page.nextOffset, null); assert.equal(next.planets.length, 1);
		await driver.testCommand("reload"); await open(); assert.equal((await state()).enabled, true); const retained = await copy(); assert.deepEqual(retained, firstConfig); assert.equal((await firstPeer.observe({ section: "research" })).result.isError, false);
		assert.equal((await driver.api("bridge", { action: "snapshot" })).requestPerformance.started, before);
		await click("关闭网关"); await until(async () => !(await state()).enabled && !(await state()).busy, "DISABLED"); assert.equal((await firstPeer.observe({ section: "status" })).result.isError, true);
		await click("开启只读网关"); await until(async () => (await state()).enabled, "REOPENED"); const secondConfig = await copy(); assert.notEqual(secondConfig.env.COMMANDDECK_GATEWAY_KEY, firstConfig.env.COMMANDDECK_GATEWAY_KEY); assert.notEqual(secondConfig.env.COMMANDDECK_GATEWAY_PIPE, firstConfig.env.COMMANDDECK_GATEWAY_PIPE);
		const secondPeer = await peerFor(secondConfig); assert.equal((await secondPeer.observe({ section: "research" })).result.isError, false); assert.equal((await firstPeer.observe({ section: "research" })).result.isError, true);
		driver.emitPowerForSmoke("suspend"); await until(async () => !(await state()).enabled && !driver.getPower().snapshot().draining, "SUSPENDED"); assert.equal((await secondPeer.observe({ section: "status" })).result.isError, true);
		assert.equal(await evaluate("window.deck.gateway('start').then(()=>false,error=>error.message.includes('SYSTEM_POWER_PAUSED'))"), true);
		driver.emitPowerForSmoke("resume"); await until(() => driver.getPower().ready, "WAKE"); assert.equal((await state()).enabled, false); assert.equal((await secondPeer.observe({ section: "status" })).result.isError, true);
		assert.equal(driver.getRuntimePid(), runtime); assert.equal(driver.getProbeSequence(), probes); assert.equal((await driver.api("bridge", { action: "snapshot" })).requestPerformance.started, before);
		if (driver.gatewayCase?.phase === "record") {
			await click("开启只读网关"); await until(async () => (await state()).enabled, "BEFORE_APPLICATION_EXIT");
			const exitConfig = await copy(), exitPeer = await peerFor(exitConfig); assert.equal((await exitPeer.observe({ section: "research" })).result.isError, false);
			await writeFile(join(directory, "gateway-exit-config.private.json"), JSON.stringify(exitConfig), { flag: "wx", mode: 0o600 });
		}
		while (peers.length) { exits.push(await peers[0].close()); peers.shift(); }
		const proof = { runId: driver.runId, readOnlyGateway: true, copiedConfigurationAccepted: true, protocolToolScopeVerified: true, freshAndStaleCacheVerified: true, noExtraMcpRequestsAfterDisconnect: true, uiReloadRetainsGateway: true, oldConfigRevokedAfterRestart: true, suspendRevokesWithoutAutomaticReopen: true, credentialsNotRendered: true, sameRuntimeWithoutModelReplay: true, ownServerExitConfirmed: true, gatewayEnabledBeforeApplicationExit: (await state()).enabled, externalPeerExits: exits, rpcCountAfterDisconnect: before, gameCalls: 0, realModelRequests: 0, syntheticModelRequests: 0, clipboardOsWriteVerified: false, physicalInputVerified: false, actualOsSleepVerified: false, fullPackagedGatewayVerified: false };
		if (!driver.gatewayCase) await writeFile(join(directory, "application.private.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
		return proof;
	} finally { for (const peer of peers) await peer.close().catch(() => {}); }
}
