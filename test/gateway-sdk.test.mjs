import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdtemp, realpath, writeFile, readFile, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentGateway } from "../apps/desktop/agent-gateway.mjs";
import { runOfficialGatewayClient } from "../scripts/official-gateway-client.mjs";
import { gatewaySdkFile, gatewaySdkReadyFile, publishGatewaySdkFile, readGatewaySdkFile } from "../apps/desktop/agent-gateway-sdk-case.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("official MCP 2.4 client reads all panels and pagination, negotiates legacy/auto and rejects revoked configs", async t => {
	const datum = data => ({ state: "observed", ageMs: 1, data }); let connected = true;
	const planets = [1, 2].map(planetId => ({ planetId, production: [{ itemId: 6001, actualProductionPerMinute: 24, findings: [] }] }));
	const source = { bridge: datum({ gameLoaded: true }), session: datum({ gameLoaded: true, owned: true, accessRestricted: false }), summary: datum({ snapshotId: "summary", planets, research: { currentTechId: 1 }, coverage: { complete: true, total: 2, returned: 2, pages: 2 } }), production: datum({ snapshotId: "production", planets, coverage: { complete: true, total: 2, returned: 2, pages: 2 } }) };
	const gateway = new AgentGateway({ snapshot: () => ({ observation: { ...source, connected } }) }); t.after(() => gateway.stop()); await gateway.start();
	const binding = gateway.connection(), config = { command: process.execPath, args: [join(root, "apps/desktop/agent-gateway-stdio.mjs")], env: { COMMANDDECK_GATEWAY_PIPE: binding.pipe, COMMANDDECK_GATEWAY_KEY: binding.key } };
	for (const stage of ["fresh", "stale"]) { connected = stage === "fresh"; for (const mode of ["legacy", "auto"]) { const result = await runOfficialGatewayClient(config, root, { stage, mode }); assert.equal(result.observations, 6); assert.equal(result.transportClosed, true); } }
	assert.equal(gateway.snapshot().reads, 24); await gateway.stop();
	for (const mode of ["legacy", "auto"]) assert.equal((await runOfficialGatewayClient(config, root, { stage: "closed", mode })).observations, 1);
});

test("SDK rendezvous rejects mismatched runs, stages and unrecognized completion data", async t => {
	const temporary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(temporary, "commanddeck-gateway-sdk-"))), context = { root: directory, runId: randomUUID() };
	t.after(async () => { assert.equal(dirname(await realpath(directory)).toLowerCase(), temporary.toLowerCase()); await rm(directory, { recursive: true, force: true }); });
	assert.equal(await readGatewaySdkFile(context, "fresh", true), null); assert.throws(() => gatewaySdkFile(context, "../escape"));
	const file = gatewaySdkFile(context, "fresh", true), valid = { version: 1, runId: context.runId, stage: "fresh", ok: true };
	await writeFile(gatewaySdkReadyFile(context, "fresh", true), "", { flag: "wx" });
	for (const invalid of [{ ...valid, runId: randomUUID() }, { ...valid, stage: "stale" }, { ...valid, ok: "true" }, { ...valid, command: "extra" }]) { await writeFile(file, JSON.stringify(invalid)); await assert.rejects(readGatewaySdkFile(context, "fresh", true)); }
	await writeFile(file, JSON.stringify(valid)); assert.deepEqual(await readGatewaySdkFile(context, "fresh", true), valid);
});

test("SDK rendezvous does not read an empty or partial payload before its writer publishes readiness", async t => {
	const temporary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(temporary, "commanddeck-gateway-sdk-"))), context = { root: directory, runId: randomUUID() };
	t.after(async () => { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), temporary.toLowerCase()); await rm(canonical, { recursive: true, force: true }); });
	const file = gatewaySdkFile(context, "stale", true), valid = { version: 1, runId: context.runId, stage: "stale", ok: true }, text = JSON.stringify(valid);
	const writer = await open(file, "wx");
	try {
		assert.equal(await readGatewaySdkFile(context, "stale", true), null);
		await writer.write(text.slice(0, 15)); assert.equal(await readGatewaySdkFile(context, "stale", true), null);
		await writer.write(text.slice(15)); assert.equal(await readGatewaySdkFile(context, "stale", true), null);
	} finally { await writer.close(); }
	assert.equal(await readGatewaySdkFile(context, "stale", true), null);
	await writeFile(gatewaySdkReadyFile(context, "stale", true), "", { flag: "wx" });
	assert.deepEqual(await readGatewaySdkFile(context, "stale", true), valid);
});

test("SDK publication is single-use in both directions and malformed published data remains a failure", async t => {
	const temporary = await realpath(tmpdir()), directory = await realpath(await mkdtemp(join(temporary, "commanddeck-gateway-sdk-"))), context = { root: directory, runId: randomUUID() };
	t.after(async () => { const canonical = await realpath(directory); assert.equal(canonical, directory); assert.equal(dirname(canonical).toLowerCase(), temporary.toLowerCase()); await rm(canonical, { recursive: true, force: true }); });
	for (const completed of [false, true]) {
		const valid = { version: 1, runId: context.runId, stage: "fresh", ...(completed ? { ok: true } : { config: { fixed: "synthetic-only" } }) };
		await publishGatewaySdkFile(context, "fresh", valid, completed); assert.deepEqual(await readGatewaySdkFile(context, "fresh", completed), valid);
		await assert.rejects(publishGatewaySdkFile(context, "fresh", { ...valid, version: 2 }, completed), { code: "EEXIST" });
		assert.deepEqual(await readGatewaySdkFile(context, "fresh", completed), valid);
	}
	await writeFile(gatewaySdkFile(context, "fresh", true), "{"); await assert.rejects(readGatewaySdkFile(context, "fresh", true), SyntaxError);
	await writeFile(gatewaySdkReadyFile(context, "fresh"), "untrusted marker"); await assert.rejects(readGatewaySdkFile(context, "fresh"), /GATEWAY_SDK_PUBLICATION_MARKER_INVALID/);
	assert.equal(await readFile(gatewaySdkFile(context, "fresh", true), "utf8"), "{");
});
