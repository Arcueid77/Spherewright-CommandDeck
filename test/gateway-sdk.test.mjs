import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentGateway } from "../apps/desktop/agent-gateway.mjs";
import { runOfficialGatewayClient } from "../scripts/official-gateway-client.mjs";
import { gatewaySdkFile, readGatewaySdkFile } from "../apps/desktop/agent-gateway-sdk-case.mjs";

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
	for (const invalid of [{ ...valid, runId: randomUUID() }, { ...valid, stage: "stale" }, { ...valid, ok: "true" }, { ...valid, command: "extra" }]) { await writeFile(file, JSON.stringify(invalid)); await assert.rejects(readGatewaySdkFile(context, "fresh", true)); }
	await writeFile(file, JSON.stringify(valid)); assert.deepEqual(await readGatewaySdkFile(context, "fresh", true), valid);
});
