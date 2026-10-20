import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { NativeClient } from "../apps/desktop/native-client.mjs";
import { GameAdapterClient, readAdapterDescriptor } from "../apps/desktop/game-adapter.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
	const deadline = performance.now() + 8000;
	while (!(await check())) { if (performance.now() > deadline) throw new Error("ADAPTER_BRIDGE_PROOF_TIMEOUT"); await delay(50); }
}
function restored(state) {
	for (const key of ["gameAlive", "gameVisible", "topLevel", "styleRestored", "exStyleRestored", "boundsRestored"])
		assert.equal(state[key], true, key);
}
const game = new NativeClient(["--adapter-pipe-fixture"]);
const ui = new NativeClient(["--fixture"]);
let client, descriptorPath;
const proof = { fixtureOnly: true, actualUnity: false, gameCalls: 0 };
async function rawConnection(descriptor, frame, wait = false) {
	const socket = createConnection(`\\\\.\\pipe\\${descriptor.pipeName}`);
	socket.on("error", () => {});
	await once(socket, "connect");
	const closed = once(socket, "close");
	if (frame) socket.write(frame);
	if (!wait && !frame) socket.destroy();
	let timer;
	try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { socket.destroy(); reject(new Error("RAW_CONNECTION_TIMEOUT")); }, 7000); })]); }
	finally { clearTimeout(timer); }
}
async function rawFixtureClient(descriptor) {
	assert.equal(descriptor.kind, "fixture");
	const socket = createConnection(`\\\\.\\pipe\\${descriptor.pipeName}`);
	await once(socket, "connect");
	let buffer = "", sequence = 0;
	const pending = new Map();
	socket.setEncoding("utf8");
	socket.on("data", (data) => {
		buffer += data;
		let end;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
			const operation = pending.get(message.id);
			if (operation) { clearTimeout(operation.timer); pending.delete(message.id); operation.resolve(message); }
		}
	});
	function waiting(id) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(id); reject(new Error("RAW_RPC_TIMEOUT")); }, 6000);
			pending.set(id, { resolve, timer });
		});
	}
	const hello = waiting("hello");
	socket.write(JSON.stringify({ method: "hello", clientPid: process.pid, secret: descriptor.secret }) + "\n");
	assert.equal((await hello).ok, true);
	return {
		request(method) { const id = `raw-${++sequence}`; const response = waiting(id); socket.write(JSON.stringify({ id, method }) + "\n"); return response; },
		close() { socket.end(); },
	};
}
try {
	const [ready, uiReady] = await Promise.all([game.ready, ui.ready]);
	descriptorPath = ready.descriptor;
	const descriptor = await readAdapterDescriptor(descriptorPath);
	assert.equal(descriptor.kind, "fixture");
	await rawConnection(descriptor, JSON.stringify({ method: "hello", clientPid: process.pid, secret: "A".repeat(43) + "=" }) + "\n");
	proof.wrongSecretRejected = true;
	await delay(100);
	await rawConnection(descriptor, Buffer.from([255, 10]));
	await delay(100);
	await rawConnection(descriptor, JSON.stringify({ method: "hello", clientPid: { invalid: true } }) + "\n");
	await delay(100);
	await rawConnection(descriptor, null, true); // Bounded unauthenticated hello deadline.
	await delay(100);
	const exitedClient = spawn(process.execPath, ["-e", "const s=require('node:net').createConnection(process.argv[1]);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));", `\\\\.\\pipe\\${descriptor.pipeName}`], { stdio: "ignore", windowsHide: true });
	assert.equal((await once(exitedClient, "exit"))[0], 0);
	await delay(100);
	proof.malformedUtf8AndHelloOnlyDropConnection = true;
	proof.helloTimeoutAndClientExitOnlyDropConnection = true;
	const collision = await game.request("fixture-descriptor-collision");
	assert.deepEqual(collision, { rejected: true, originalPreserved: true });
	proof.descriptorCollisionPreservesOriginal = true;
	// Rewrite only this test-created fake game's descriptor, then restore its original bytes.
	const originalDescriptorBytes = await readFile(descriptorPath);
	try {
		await writeFile(descriptorPath, JSON.stringify({ ...descriptor, pipeName: "Spherewright.CommandDeck." + randomUUID().replaceAll("-", "") }));
		const staleInstance = new GameAdapterClient(descriptor);
		await assert.rejects(staleInstance.ready, /ADAPTER_PIPE_NAME_REJECTED/);
		proof.changedEndpointInstanceRejected = true;
	} finally { await writeFile(descriptorPath, originalDescriptorBytes); }
	const fakePipeName = "Spherewright.CommandDeck." + randomUUID().replaceAll("-", "");
	let observedBytes = 0;
	const fakeServer = createServer((socket) => { socket.on("data", (data) => { observedBytes += data.length; }); });
	await new Promise((resolve) => fakeServer.listen(`\\\\.\\pipe\\${fakePipeName}`, resolve));
	const fakePath = join(dirname(descriptorPath), `${process.pid}-${descriptor.gameStartedTicks}.json`);
	let fakeOwned = false;
	try {
		await writeFile(fakePath, JSON.stringify({ ...descriptor, gamePid: process.pid, pipeName: fakePipeName }), { flag: "wx" });
		fakeOwned = true;
		const fake = new GameAdapterClient(await readAdapterDescriptor(fakePath));
		await assert.rejects(fake.ready, /ADAPTER_DISCONNECTED/);
		assert.equal(observedBytes, 0, "Secret or window request reached an unverified OS peer");
		proof.osPeerRejectedBeforeSecret = true;
	} finally { if (fakeOwned) await unlink(fakePath); await new Promise((resolve) => fakeServer.close(resolve)); }
	client = new GameAdapterClient(descriptor);
	let state = await client.ready;
	assert.equal(state.window.active, false);
	restored(await game.request("restored"));
	proof.authDoesNotCreateHost = true;
	await client.request("activate");
	state = await client.request("adopt", uiReady);
	assert.equal(state.window.attached, true); assert.equal(state.window.gameParentMatches, true);
	await client.request("rect", { x: 150, y: 70, width: 620, height: 410, visible: true });
	await until(async () => {
		state = await client.request("status");
		return !state.window.uiOperationPending && state.window.layoutRequested === state.window.layoutApplied;
	});
	const size = await game.request("restored");
	assert.equal(size.gameWidth, 620); assert.equal(size.gameHeight, 410);
	assert.equal((await client.request("focus-ui")).window.uiThreadHasFocus, true);
	proof.explicitActivationAndNativeLayout = true;
	await assert.rejects(client.request("save"), /WINDOW_METHOD_UNSUPPORTED/);
	client.disconnect();
	await until(async () => ui.latest?.parent === "0" && ui.latest?.boundsRestored && (await game.request("restored")).topLevel);
	restored(await game.request("restored"));
	proof.eofRestoresBoth = true;
	await delay(100);
	const raw = await rawFixtureClient(descriptor);
	try {
		assert.equal((await raw.request("activate")).ok, true);
		const rejection = await raw.request("save");
		assert.equal(rejection.ok, false); assert.equal(rejection.code, "WINDOW_METHOD_UNSUPPORTED");
		proof.serverRejectsGameMethods = true;
	} finally { raw.close(); }
	await until(async () => (await game.request("restored")).topLevel);
	await delay(100);
	client = new GameAdapterClient(descriptor);
	await client.ready; await client.request("activate"); await client.request("adopt", uiReady);
	assert.equal((await game.request("fixture-break-marker")).broken, true);
	await assert.rejects(client.request("deactivate"), /ADAPTER_REQUEST_REJECTED/);
	assert.equal((await client.request("status")).quarantined, true);
	client.disconnect();
	await until(() => client.stopped);
	await delay(100);
	client = new GameAdapterClient(descriptor);
	state = await client.ready;
	assert.equal(state.quarantined, true); assert.equal(state.window.active, true); assert.equal(state.ready, false);
	await assert.rejects(client.request("activate"), /ADAPTER_REQUEST_REJECTED/);
	assert.equal((await stat(descriptorPath)).isFile(), true);
	proof.restorationFailureRetainsRestrictedDiagnosticEndpoint = true;
	assert.equal((await game.request("fixture-restore-marker")).restored, true);
	await client.request("deactivate");
	restored(await game.request("restored"));
	proof.explicitReconciliationAfterFixtureRepair = true;
	await client.request("activate"); await client.request("adopt", uiReady);
	await game.request("fixture-windowed", { windowed: false });
	await until(async () => !(await client.request("status")).window.active);
	restored(await game.request("restored"));
	assert.equal((await client.request("status")).ready, false);
	await assert.rejects(client.request("activate"), /ADAPTER_REQUEST_REJECTED/);
	proof.displayModeChangeDeactivates = true;
	client.disconnect();
	await game.request("close");
	await until(async () => { try { await stat(descriptorPath); return false; } catch (error) { return error.code === "ENOENT"; } });
	proof.privateDescriptorRemovedAtStop = true;
	await mkdir(".local", { recursive: true });
	await writeFile(".local/adapter-bridge-smoke.json", JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof));
} finally {
	client?.disconnect();
	if (!game.stopped) { try { await game.request("close"); } catch { game.child.kill(); } }
	if (!ui.stopped) { const exited = once(ui.child, "exit"); ui.child.stdin.write("close\n"); await exited; }
}
