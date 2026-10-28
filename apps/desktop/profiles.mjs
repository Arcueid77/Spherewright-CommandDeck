import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { modelPricing } from "./model-usage.mjs";

export function readModelPricing(path, providerId, modelId) {
	try {
		if (statSync(path).size > 1024 * 1024) return null;
		const config = JSON.parse(readFileSync(path, "utf8"));
		const provider = config.providers?.[providerId], model = provider?.models?.find(value => value.id === modelId);
		// Only caller-configured prices, never the registry's default zero prices.
		const override = provider?.modelOverrides?.[modelId]?.cost;
		if (model?.cost?.tiers || override?.tiers) return null; // Tiered billing needs its own estimator.
		if (!model?.cost && !override) return null;
		return modelPricing(Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, override?.[key] ?? model?.cost?.[key] ?? null])));
	} catch { return null; }
}

function validateEndpoint(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("PI_ENDPOINT_INVALID");
	}
	if (
		!["https:", "http:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("PI_ENDPOINT_INVALID");
	if (
		url.protocol === "http:" &&
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
	)
		throw new Error("PI_REMOTE_TLS_REQUIRED");
}

export function readProfiles(
	directory = process.env.COMMANDDECK_PI_CONFIG_DIR ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent"),
) {
	const path = join(resolve(directory), "models.json");
	if (statSync(path).size > 1024 * 1024) throw new Error("PI_CONFIG_TOO_LARGE");
	let config;
	try {
		config = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("PI_CONFIG_INVALID");
	}
	const profiles = [];
	for (const [providerId, provider] of Object.entries(config.providers ?? {})) {
		if (
			!provider ||
			typeof provider !== "object" ||
			(provider.models !== undefined && !Array.isArray(provider.models))
		)
			continue;
		const authValues = [
			provider.apiKey,
			...Object.values(provider.headers ?? {}),
			...(provider.models ?? []).flatMap((model) =>
				Object.values(model.headers ?? {}),
			),
			...Object.values(provider.modelOverrides ?? {}).flatMap((model) =>
				Object.values(model.headers ?? {}),
			),
		];
		if (
			authValues.some(
				(value) =>
					typeof value === "string" && value.trimStart().startsWith("!"),
			)
		)
			throw new Error("PI_CREDENTIAL_COMMAND_REQUIRES_SEPARATE_REVIEW");
		if (provider.baseUrl !== undefined) validateEndpoint(provider.baseUrl);
		for (const model of provider.models ?? []) {
			if (model.baseUrl !== undefined) validateEndpoint(model.baseUrl);
			if (typeof (model.baseUrl ?? provider.baseUrl) !== "string") continue;
			const api = model.api ?? provider.api ?? "unknown";
			if (
				typeof model.id === "string" &&
				model.id.length > 0 &&
				model.id.length <= 200 &&
				typeof providerId === "string" &&
				providerId.length <= 200 &&
				typeof api === "string" &&
				api.length <= 100
			)
				profiles.push({
					providerId,
					modelId: model.id,
					api,
				});
		}
	}
	// Never return provider config, endpoints, authentication or headers to the renderer.
	return { path, profiles };
}

export function publicProfiles() {
	return readProfiles().profiles;
}
