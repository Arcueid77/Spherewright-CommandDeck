import assert from "node:assert/strict";
import { Server } from "node:http";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

// Test-only binding to this process's listening HTTP server. Never accept a
// provider from a renderer, pre-existing vault, external config or MCP data.
export function syntheticProviderScope() {
	let binding;
	function requireLive() {
		if (!binding || !binding.server.listening || binding.server.address()?.port !== binding.port) throw new Error("SYNTHETIC_PROVIDER_NOT_BOUND");
		return binding;
	}
	function fields(value, key) {
		const expected = requireLive();
		if (value?.id !== expected.id || value.api !== "openai-completions" || value.modelId !== "fixture" || value.baseUrl !== expected.url || key !== expected.key) throw new Error("SYNTHETIC_PROVIDER_REQUIRED");
	}
	return Object.freeze({
		register(server, id, key) {
			if (binding || !(server instanceof Server) || !server.listening || !/^deckvault-[0-9a-f-]{36}$/.test(id ?? "") || !/^synthetic-game-smoke-[0-9a-f-]{36}$/.test(key ?? "")) throw new Error("SYNTHETIC_PROVIDER_BINDING_INVALID");
			const address = server.address();
			if (!address || address.address !== "127.0.0.1" || !Number.isSafeInteger(address.port) || address.port <= 0) throw new Error("SYNTHETIC_PROVIDER_BINDING_INVALID");
			binding = { server, id, key, port: address.port, url: `http://127.0.0.1:${address.port}/v1` };
		},
		assertDraft(value) { fields(value, value?.apiKey); },
		assertResolved(value) { fields(value, value?.key); },
		assertReference(providerId, modelId) { const expected = requireLive(); if (providerId !== expected.id || modelId !== "fixture") throw new Error("SYNTHETIC_PROVIDER_REQUIRED"); },
	});
}

export async function preparePortableFixtureDirectory(context) {
	assert.match(context.runId, /^[a-f0-9-]{36}$/);
	let directory = await realpath(context.root);
	assert.equal(directory.toLowerCase(), context.root.toLowerCase());
	for (const part of ["runtime-fixtures", "m3-smoke", context.runId]) {
		directory = join(directory, part);
		try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; if (part === context.runId) throw new Error("PORTABLE_FIXTURE_ALREADY_EXISTS"); }
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("PORTABLE_FIXTURE_DIRECTORY_REDIRECTED");
	}
	return directory;
}
