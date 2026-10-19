import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProfiles } from "../apps/desktop/profiles.mjs";

function config(value) {
	const directory = mkdtempSync(join(tmpdir(), "deck-config-test-"));
	writeFileSync(join(directory, "models.json"), JSON.stringify(value));
	return directory;
}
test("public profile metadata never contains credentials, headers or endpoints", () => {
	const directory = config({
		providers: {
			custom: {
				baseUrl: "https://example.invalid/v1",
				apiKey: "synthetic-secret",
				api: "openai-completions",
				headers: { authorization: "synthetic-header" },
				models: [{ id: "exact-model-id" }],
			},
		},
	});
	assert.deepEqual(readProfiles(directory).profiles, [
		{
			providerId: "custom",
			modelId: "exact-model-id",
			api: "openai-completions",
		},
	]);
});
test("credential commands reject before the Pi runtime is created", () => {
	const directory = config({
		providers: {
			custom: {
				baseUrl: "https://example.invalid",
				apiKey: "!arbitrary-command",
				models: [{ id: "a" }],
			},
		},
	});
	assert.throws(() => readProfiles(directory), /CREDENTIAL_COMMAND/);
});

test("model headers and overrides cannot bypass credential command checks", () => {
	for (const extra of [
		{ models: [{ id: "a", headers: { authorization: "!synthetic-command" } }] },
		{
			models: [{ id: "a" }],
			modelOverrides: {
				a: { headers: { authorization: "!synthetic-command" } },
			},
		},
	]) {
		const directory = config({
			providers: { custom: { baseUrl: "https://example.invalid", ...extra } },
		});
		assert.throws(() => readProfiles(directory), /CREDENTIAL_COMMAND/);
	}
});

test("model endpoint overrides retain the TLS and URL checks", () => {
	const directory = config({
		providers: {
			custom: {
				baseUrl: "https://example.invalid",
				models: [{ id: "a", baseUrl: "http://remote.invalid" }],
			},
		},
	});
	assert.throws(() => readProfiles(directory), /TLS_REQUIRED/);
});
test("credential-bearing URLs, non-network schemes and remote plaintext reject", () => {
	for (const baseUrl of [
		"https://user:password@example.invalid",
		"file:///secret",
		"http://example.invalid",
	]) {
		const directory = config({
			providers: {
				custom: { baseUrl, apiKey: "synthetic", models: [{ id: "a" }] },
			},
		});
		assert.throws(
			() => readProfiles(directory),
			/ENDPOINT_INVALID|TLS_REQUIRED/,
		);
	}
});
