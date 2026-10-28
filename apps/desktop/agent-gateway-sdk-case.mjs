import assert from "node:assert/strict";
import { lstat, realpath, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const officialGatewayClientVersion = "2.4.0";
export const gatewaySdkStages = Object.freeze(["fresh", "stale"]);
export function gatewaySdkFile(context, stage, completed = false) {
	assert.ok(gatewaySdkStages.includes(stage));
	assert.match(context.runId, /^[a-f0-9-]{36}$/);
	return join(context.root, "gateway-sdk-" + stage + (completed ? "-complete" : "") + ".private.json");
}
export async function readGatewaySdkFile(context, stage, completed = false) {
	const file = gatewaySdkFile(context, stage, completed); let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 8192);
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.deepEqual(Object.keys(value).sort(), (completed ? ["ok", "runId", "stage", "version"] : ["config", "runId", "stage", "version"]).sort());
	assert.equal(value.version, 1); assert.equal(value.runId, context.runId); assert.equal(value.stage, stage);
	if (completed) assert.equal(typeof value.ok, "boolean");
	return value;
}
export async function gatewaySdkHandoff(driver, stage, config) {
	if (!driver.gatewayCase) return;
	assert.equal(driver.gatewayCase.phase, "record");
	await writeFile(gatewaySdkFile(driver.context, stage), JSON.stringify({ version: 1, runId: driver.runId, stage, config }), { flag: "wx", mode: 0o600 });
	const deadline = performance.now() + 30000;
	while (true) {
		const done = await readGatewaySdkFile(driver.context, stage, true);
		if (done) { assert.equal(done.ok, true, "OFFICIAL_GATEWAY_CLIENT_FAILED"); return; }
		assert.ok(performance.now() < deadline, "OFFICIAL_GATEWAY_CLIENT_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 50));
	}
}
