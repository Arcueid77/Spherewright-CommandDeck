import test from "node:test";
import assert from "node:assert/strict";
import { parseProcessObservation, observePackagedProcesses } from "../scripts/observe-packaged-processes.mjs";

const roots = [process.platform === "win32" ? "C:\\owned" : "/owned"];
const options = { observerPid: 10, roots };
const reply = { version: 1, observerPid: 10, roots, count: 1, members: [{ pid: 11, startedUtcTicks: "639280000000000000", rootIndex: 0, relativeImage: "bundle/CommandDeck.NativeHost.exe" }] };

test("process observation binds exact roots and the created observer and retains live process identities", () => {
	assert.deepEqual(parseProcessObservation(JSON.stringify(reply), options), reply);
	assert.equal(parseProcessObservation(JSON.stringify({ ...reply, count: 0, members: [] }), options).count, 0);
	for (const value of ["", "{}", "null", JSON.stringify({ ...reply, version: 2 }), JSON.stringify({ ...reply, roots: ["/other"] }), JSON.stringify({ ...reply, observerPid: 11 }), JSON.stringify({ ...reply, count: 0 })]) assert.throws(() => parseProcessObservation(value, options));
});

test("missing births, duplicate processes, observer self-counts and unsafe images cannot count as valid observations", () => {
	for (const changed of [{ pid: 10 }, { startedUtcTicks: null }, { rootIndex: 1 }, { relativeImage: "../CommandDeck.NativeHost.exe" }, { relativeImage: "other.exe" }, { relativeImage: "C:\\owned\\CommandDeck.NativeHost.exe" }, { relativeImage: "folder//CommandDeck.NativeHost.exe" }]) {
		assert.throws(() => parseProcessObservation(JSON.stringify({ ...reply, members: [{ ...reply.members[0], ...changed }] }), options));
	}
	assert.throws(() => parseProcessObservation(JSON.stringify({ ...reply, count: 2, members: [...reply.members, ...reply.members] }), options));
});

test("an invalid request or failed observer never returns an invented zero process count", async () => {
	await assert.rejects(observePackagedProcesses({ executable: "relative.exe", roots }), /REQUEST_INVALID/);
	await assert.rejects(observePackagedProcesses({ executable: roots[0] + "/observer.exe", roots, includeNode: "true" }), /REQUEST_INVALID/);
	await assert.rejects(observePackagedProcesses({ executable: roots[0] + "/not-a-program.exe", roots, timeoutMs: 1000 }), /OBSERVATION_UNAVAILABLE/);
});

test("command observation requires explicit Node scope and a matching native acknowledgement", () => {
	const nodeReply = { ...reply, nodeImagesIncluded: true, members: [{ ...reply.members[0], relativeImage: "toolchain/node.exe" }] };
	assert.deepEqual(parseProcessObservation(JSON.stringify(nodeReply), { ...options, includeNode: true }), nodeReply);
	assert.throws(() => parseProcessObservation(JSON.stringify(nodeReply), options));
	for (const acknowledgement of [undefined, false, "true", 1]) {
		assert.throws(() => parseProcessObservation(JSON.stringify({ ...nodeReply, nodeImagesIncluded: acknowledgement }), { ...options, includeNode: true }));
	}
	assert.throws(() => parseProcessObservation(JSON.stringify({ ...nodeReply, nodeImagesIncluded: false }), options));
	assert.throws(() => parseProcessObservation(JSON.stringify({ ...reply, nodeImagesIncluded: true }), options));
	assert.equal(parseProcessObservation(JSON.stringify({ ...reply, nodeImagesIncluded: false }), options).count, 1);
	for (const changed of [{ startedUtcTicks: null }, { pid: 10 }, { rootIndex: 2 }, { relativeImage: "../node.exe" }, { relativeImage: "other.exe" }]) {
		assert.throws(() => parseProcessObservation(JSON.stringify({ ...nodeReply, members: [{ ...nodeReply.members[0], ...changed }] }), { ...options, includeNode: true }));
	}
});
