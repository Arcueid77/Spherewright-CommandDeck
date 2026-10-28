export const contextProviderApis = Object.freeze(["openai-completions", "anthropic-messages"]);
export const providerContextFailures = Object.freeze(["cancel", "http-error"]);
export function providerContextPrefix(summaryFailure = null) {
	if (summaryFailure !== null && !providerContextFailures.includes(summaryFailure)) throw new Error("INVALID_CONTEXT_FAILURE_CASE");
	return summaryFailure ? "context-" + summaryFailure + "-" : "context-providers-";
}
export const providerContextSteps = Object.freeze([
	{ provider: 0, source: null, mode: "new", marker: "PROVIDER_CONTEXT_SEED" },
	{ provider: 1, source: 0, mode: "continue", marker: "PROVIDER_CONTEXT_TO_ANTHROPIC" },
	{ provider: 0, source: 1, mode: "continue", marker: "PROVIDER_CONTEXT_TO_OPENAI" },
	{ provider: 1, source: 2, mode: "compact", marker: "PROVIDER_CONTEXT_COMPACT_ANTHROPIC" },
	{ provider: 0, source: 1, mode: "compact", marker: "PROVIDER_CONTEXT_COMPACT_OPENAI" },
].map(step => Object.freeze({ ...step, prompt: step.marker + (step.mode === "compact" ? "" : " Historical synthetic context detail.".repeat(350)) })));
export const contextProviderSettings = Object.freeze([
	{ contextWindow: 32768, pricing: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 } },
	{ contextWindow: 65536, pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
]);

export function assertProviderContextTask(args, { rootId, profiles = [], tasks = [], pending = false } = {}) {
	const reject = () => { throw new Error("PORTABLE_SMOKE_ACTION_REJECTED"); }, step = providerContextSteps[tasks.length];
	if (pending || !step || typeof rootId !== "string" || profiles.length !== 2 || new Set(profiles).size !== 2 || profiles.some(id => !/^deckvault-[a-f0-9-]{36}$/.test(id)) || args?.rootId !== rootId || args.providerId !== profiles[step.provider] || args.modelId !== "fixture" || args.prompt !== step.prompt) reject();
	const keys = ["rootId", "providerId", "modelId", "prompt"];
	if (step.source !== null) {
		keys.push("contextMode", "sourceTaskId", "sourceSha256");
		if (args.contextMode !== step.mode || args.sourceTaskId !== tasks[step.source] || !/^[a-f0-9]{64}$/.test(args.sourceSha256 ?? "")) reject();
	}
	if (Object.keys(args).some(key => !keys.includes(key))) reject();
}
