import assert from "node:assert/strict";
import { Server } from "node:http";
import { mkdir, lstat, realpath, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

export function syntheticMcpEnvironment(source = process.env) {
	// Match async realpath: the native Windows resolver expands DOS aliases.
	const temporary = realpathSync.native(tmpdir());
	// Bind the child's environment to the creating test process's physical temp
	// root. Windows can otherwise select another value from mixed-case aliases.
	const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !/^(?:TEMP|TMP|TMPDIR)$/i.test(key)));
	return { ...environment, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
}

// Test-only binding to this process's listening HTTP server. Never accept a
// provider from a renderer, pre-existing vault, external config or MCP data.
export function syntheticProviderScope({ multipleApis = false } = {}) {
	const bindings = new Map(), apis = multipleApis === true ? ["openai-completions", "anthropic-messages"] : ["openai-completions"];
	function requireLive(id) {
		const binding = bindings.get(id);
		if (!binding || !binding.server.listening || binding.server.address()?.port !== binding.port) throw new Error("SYNTHETIC_PROVIDER_NOT_BOUND");
		return binding;
	}
	function fields(value, key) {
		if (!bindings.has(value?.id)) throw new Error("SYNTHETIC_PROVIDER_REQUIRED");
		const expected = requireLive(value.id);
		if (value.api !== expected.api || value.modelId !== "fixture" || value.baseUrl !== expected.url || key !== expected.key) throw new Error("SYNTHETIC_PROVIDER_REQUIRED");
	}
	return Object.freeze({
		register(server, id, key, api = "openai-completions") {
			if (!apis.includes(api) || bindings.size >= apis.length || bindings.has(id) || [...bindings.values()].some(value => value.api === api || value.server === server || value.key === key) || !(server instanceof Server) || !server.listening || !/^deckvault-[0-9a-f-]{36}$/.test(id ?? "") || !/^synthetic-(?:game|development)-smoke-[0-9a-f-]{36}$/.test(key ?? "")) throw new Error("SYNTHETIC_PROVIDER_BINDING_INVALID");
			const address = server.address();
			if (!address || address.address !== "127.0.0.1" || !Number.isSafeInteger(address.port) || address.port <= 0) throw new Error("SYNTHETIC_PROVIDER_BINDING_INVALID");
			bindings.set(id, { server, id, key, api, port: address.port, url: `http://127.0.0.1:${address.port}` + (api === "openai-completions" ? "/v1" : "") });
		},
		assertDraft(value) { fields(value, value?.apiKey); },
		assertResolved(value) { fields(value, value?.key); },
		assertReference(providerId, modelId) { if (!bindings.has(providerId) && bindings.size) throw new Error("SYNTHETIC_PROVIDER_REQUIRED"); requireLive(providerId); if (modelId !== "fixture") throw new Error("SYNTHETIC_PROVIDER_REQUIRED"); },
	});
}

export async function preparePortableFixtureDirectory(context) {
	assert.match(context.runId, /^[a-f0-9-]{36}$/);
	let directory = await realpath(context.root);
	assert.equal(directory.toLowerCase(), context.root.toLowerCase());
	assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
	assert.match(basename(directory), /^commanddeck-(?:desktop-smoke|mcp-recovery)-/);
	for (const part of ["runtime-fixtures", "m3-smoke", context.runId]) {
		directory = join(directory, part);
		try { await mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; if (part === context.runId) throw new Error("PORTABLE_FIXTURE_ALREADY_EXISTS"); }
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error("PORTABLE_FIXTURE_DIRECTORY_REDIRECTED");
	}
	return directory;
}

export async function createSyntheticResearchWorld(directory, runId) {
	assert.match(runId, /^[a-f0-9-]{36}$/);
	const path = join(directory, "synthetic-research-world.json");
	await writeFile(path, JSON.stringify({ version: 1, runId, commits: 0, techId: null, key: null, tick: 1200, lossInjected: false, launches: 0, prepares: 0, resultReads: 0 }), { flag: "wx" });
	return path;
}
