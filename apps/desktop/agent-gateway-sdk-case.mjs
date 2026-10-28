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
export function gatewaySdkReadyFile(context, stage, completed = false) {
	return gatewaySdkFile(context, stage, completed) + ".ready";
}
export async function publishGatewaySdkFile(context, stage, value, completed = false) {
	const file = gatewaySdkFile(context, stage, completed), bytes = JSON.stringify(value);
	assert.ok(Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= 8192, "GATEWAY_SDK_PAYLOAD_SIZE_INVALID");
	// Both files are single-use. Existence of an opened payload is not readiness.
	await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
	await writeFile(gatewaySdkReadyFile(context, stage, completed), "", { flag: "wx", mode: 0o600 });
}
export async function readGatewaySdkFile(context, stage, completed = false) {
	const file = gatewaySdkFile(context, stage, completed), ready = gatewaySdkReadyFile(context, stage, completed); let marker;
	try { marker = await lstat(ready); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.size === 0, "GATEWAY_SDK_PUBLICATION_MARKER_INVALID");
	assert.equal((await realpath(ready)).toLowerCase(), ready.toLowerCase());
	const info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "GATEWAY_SDK_PAYLOAD_FILE_INVALID");
	assert.ok(info.size > 0 && info.size <= 8192, "GATEWAY_SDK_PAYLOAD_SIZE_INVALID");
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
	await publishGatewaySdkFile(driver.context, stage, { version: 1, runId: driver.runId, stage, config });
	const deadline = performance.now() + 30000;
	while (true) {
		const done = await readGatewaySdkFile(driver.context, stage, true);
		if (done) { assert.equal(done.ok, true, "OFFICIAL_GATEWAY_CLIENT_FAILED"); return; }
		assert.ok(performance.now() < deadline, "OFFICIAL_GATEWAY_CLIENT_TIMEOUT"); await new Promise(resolve => setTimeout(resolve, 50));
	}
}
