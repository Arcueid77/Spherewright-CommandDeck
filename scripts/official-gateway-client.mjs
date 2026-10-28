import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { officialGatewayClientVersion, gatewaySdkStages, gatewaySdkFile, readGatewaySdkFile } from "../apps/desktop/agent-gateway-sdk-case.mjs";
import { assertGatewayFixtureConfig } from "../apps/desktop/agent-gateway-packaged-smoke.mjs";

export async function runGatewaySdkStages(context, command, script, hasExited) {
	const sdk = JSON.parse(await readFile(new URL("../node_modules/@modelcontextprotocol/client/package.json", import.meta.url), "utf8")); assert.equal(sdk.version, officialGatewayClientVersion);
	const results = [];
	for (const stage of gatewaySdkStages) {
		let request;
		try {
			const deadline = performance.now() + 60000;
			while (!(request = await readGatewaySdkFile(context, stage))) { assert.equal(hasExited(), false, "GATEWAY_APP_EXITED_BEFORE_SDK"); assert.ok(performance.now() < deadline, "GATEWAY_SDK_READY_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 50)); }
			const config = assertGatewayFixtureConfig(request.config, command, script);
			for (const mode of ["legacy", "auto"]) results.push(await runOfficialGatewayClient(config, context.root, { stage, mode }));
			await writeFile(gatewaySdkFile(context, stage, true), JSON.stringify({ version: 1, runId: context.runId, stage, ok: true }), { flag: "wx" });
		} catch (error) {
			if (request) await writeFile(gatewaySdkFile(context, stage, true), JSON.stringify({ version: 1, runId: context.runId, stage, ok: false }), { flag: "wx" }).catch(() => {});
			await writeFile(join(context.root, "gateway-sdk-failure.private.json"), JSON.stringify({ stage, message: String(error?.message).slice(0, 1000), completed: results }), { flag: "wx" }).catch(() => {}); throw error;
		}
	}
	return results;
}

// The official SDK remains a test dependency outside the application bundle.
export async function runOfficialGatewayClient(config, cwd, { stage, mode }) {
	assert.ok(["fresh", "stale", "closed"].includes(stage)); assert.ok(["legacy", "auto"].includes(mode));
	const client = new Client({ name: "CommandDeck official SDK compatibility fixture", version: "1" }, { versionNegotiation: { mode, probe: { timeoutMs: 3000, maxRetries: 0 } } });
	const transport = new StdioClientTransport({ ...config, env: { PATH: process.env.SystemRoot + "\\System32", ...config.env }, cwd, stderr: "pipe", maxBufferSize: 1100000 });
	const options = { timeout: 5000 }; let diagnosticBytes = 0, errors = 0, closed = false, observations = 0, proof;
	transport.stderr.on("data", bytes => { diagnosticBytes += bytes.length; });
	client.onerror = () => { errors++; }; client.onclose = () => { closed = true; };
	try {
		await client.connect(transport, options);
		assert.equal(client.getNegotiatedProtocolVersion(), "2025-11-25"); assert.equal(client.getProtocolEra(), "legacy");
		assert.deepEqual(client.getServerCapabilities(), { tools: { listChanged: false } });
		const listed = await client.listTools(undefined, options); assert.equal(listed.tools.length, 1); assert.equal(listed.tools[0].name, "deck_observe"); assert.equal(listed.tools[0].annotations.readOnlyHint, true);
		const observe = async args => { observations++; return client.callTool({ name: "deck_observe", arguments: args }, options); };
		if (stage === "closed") { const denied = await observe({ section: "status" }); assert.equal(denied.isError, true); assert.equal(denied.content[0].text, "GATEWAY_UNAVAILABLE"); }
		else {
			let first;
			for (const section of ["status", "research", "production", "power", "logistics"]) {
				const result = await observe({ section, ...(section === "production" ? { limit: 1 } : {}) }); assert.equal(result.isError, false);
				assert.equal(result.content.length, 1); assert.equal(result.content[0].type, "text"); const value = result.structuredContent; assert.deepEqual(JSON.parse(result.content[0].text), value);
				assert.equal(value.readOnly, true); assert.equal(value.cachedOnly, true); assert.equal(value.connected, stage === "fresh"); assert.ok(!JSON.stringify(value).includes("PRIVATE_SYNTHETIC"));
				if (section !== "status") assert.equal(value.state, stage === "fresh" ? "observed" : "stale");
				if (section === "production") { first = value; assert.equal(value.planets[0].production[0].actualProductionPerMinute, 24); assert.equal(value.page.nextOffset, 1); }
			}
			const next = (await observe({ section: "production", limit: 1, offset: first.page.nextOffset, snapshotId: first.snapshotId })).structuredContent; assert.equal(next.planets[0].planetId, 2); assert.equal(next.page.nextOffset, null);
			await assert.rejects(client.callTool({ name: "commit", arguments: {} }, options));
			await assert.rejects(client.callTool({ name: "deck_observe", arguments: { section: "status", refresh: true } }, options));
		}
		proof = { clientPackage: "@modelcontextprotocol/client", clientVersion: officialGatewayClientVersion, mode, stage, protocol: client.getNegotiatedProtocolVersion(), era: client.getProtocolEra(), listedTools: listed.tools.map(tool => tool.name), observations };
	} finally { await client.close(); }
	assert.equal(closed, true); assert.equal(diagnosticBytes, 0); assert.equal(errors, 0);
	return { ...proof, transportClosed: true, stderrBytes: diagnosticBytes, protocolErrors: errors };
}
