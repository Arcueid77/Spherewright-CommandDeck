import { ModelRuntime } from "../../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { AuthStorage } from "../../vendor/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { AssistantMessageEventStream } from "../../vendor/pi/node_modules/@earendil-works/pi-ai/dist/index.js";

const structural = new Set(["type", "role", "stopReason", "api", "provider", "model", "id", "name", "toolName"]);
function scrub(value, key, field = "") {
	if (typeof value === "string") {
		if (structural.has(field) && value.includes(key)) throw new Error("PROVIDER_CREDENTIAL_IN_CONTROL_FIELD");
		return value.split(key).join("[redacted]");
	}
	if (Array.isArray(value)) return value.map((entry) => scrub(entry, key));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
		if (name.includes(key)) throw new Error("PROVIDER_CREDENTIAL_IN_CONTROL_FIELD");
		return [name, scrub(entry, key, name)];
	}));
	return value;
}

// The registered provider contains no credential. A runtime-only overlay supplies the literal key.
export async function createProtectedRuntime(profile, signal, { createRuntime = (options) => ModelRuntime.create(options) } = {}) {
	const credentials = AuthStorage.inMemory();
	let runtime;
	try {
		runtime = await createRuntime({ credentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal });
		runtime.registerProvider(profile.id, { name: profile.label, api: profile.api, baseUrl: profile.baseUrl, models: [{ id: profile.modelId, name: profile.modelId, api: profile.api, input: ["text"], reasoning: false, contextWindow: profile.contextWindow, maxTokens: profile.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
		await runtime.setRuntimeApiKey(profile.id, profile.key, { signal });
	} catch {
		try { await runtime?.removeRuntimeApiKey(profile.id); } catch {}
		// Pi's synchronization errors can contain credential.key and nested causes.
		throw new Error("PROTECTED_RUNTIME_INITIALIZATION_FAILED");
	}
	const stream = runtime.streamSimple.bind(runtime);
	runtime.streamSimple = (model, context, options) => {
		const output = new AssistantMessageEventStream();
		void (async () => {
			try {
				const source = stream(model, context, options);
				// Never forward provider fragments: a literal credential may span SSE chunks.
				for await (const _event of source) {}
				const safe = scrub(await source.result(), profile.key);
				if (safe.content.filter((block) => block.type === "text").map((block) => block.text).join("").includes(profile.key)) throw new Error("PROVIDER_CREDENTIAL_IN_SPLIT_CONTENT");
				if (["error", "aborted"].includes(safe.stopReason)) output.push({ type: "error", reason: safe.stopReason, error: safe });
				else {
					output.push({ type: "start", partial: { ...safe, content: [] } });
					for (const [contentIndex, block] of safe.content.entries()) if (block.type === "text") output.push({ type: "text_delta", contentIndex, delta: block.text, partial: safe });
					output.push({ type: "done", reason: safe.stopReason, message: safe });
				}
				output.end(safe);
			} catch {
				const error = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "MODEL_PROVIDER_FAILED", timestamp: Date.now() };
				output.push({ type: "error", reason: "error", error }); output.end(error);
			}
		})();
		return output;
	};
	return runtime;
}
