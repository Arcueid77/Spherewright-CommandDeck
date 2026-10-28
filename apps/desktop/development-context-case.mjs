export const contextSeedPrompt = "CONTEXT_SEED_MARKER " + "Historical synthetic detail. ".repeat(450);
export const contextContinuePrompt = "CONTEXT_CONTINUE " + "Recent synthetic detail. ".repeat(450);
export const contextCompactPrompt = "CONTEXT_AFTER_COMPACT";

// Only the three fixed tasks in the owned packaged fixture; no arbitrary prompt or lineage.
export function assertContextFixtureTask(args, { rootId, profileId, tasks = [], pending = false } = {}) {
	const reject = () => { throw new Error("PORTABLE_SMOKE_ACTION_REJECTED"); };
	if (pending || tasks.length >= 3 || typeof rootId !== "string" || typeof profileId !== "string" || args?.rootId !== rootId || args?.providerId !== profileId || args?.modelId !== "fixture") reject();
	const prompts = [contextSeedPrompt, contextContinuePrompt, contextCompactPrompt];
	if (args.prompt !== prompts[tasks.length]) reject();
	const keys = ["rootId", "providerId", "modelId", "prompt"];
	if (tasks.length) {
		keys.push("contextMode", "sourceTaskId", "sourceSha256");
		if (args.contextMode !== (tasks.length === 1 ? "continue" : "compact") || args.sourceTaskId !== tasks.at(-1) || !/^[a-f0-9]{64}$/.test(args.sourceSha256 ?? "")) reject();
	}
	if (Object.keys(args).some(key => !keys.includes(key))) reject();
}
