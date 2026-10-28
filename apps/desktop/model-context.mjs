const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
export function modelContextSnapshot(value) {
	if (!value || value.version !== 1 || value.method !== "pi-estimate" || value.stage !== "task_end") throw new Error("INVALID_MODEL_CONTEXT");
	const contextWindow = value.contextWindow ?? null, estimatedTokens = value.estimatedTokens ?? null;
	if (contextWindow !== null && (!Number.isInteger(contextWindow) || contextWindow <= 0 || contextWindow > 16777216) || estimatedTokens !== null && !integer(estimatedTokens)) throw new Error("INVALID_MODEL_CONTEXT");
	return { version: 1, method: "pi-estimate", stage: "task_end", contextWindow, estimatedTokens, percent: contextWindow && estimatedTokens !== null ? estimatedTokens / contextWindow * 100 : null };
}
export function sampleModelContext(session) {
	try { const value = session.getContextUsage(); return modelContextSnapshot({ version: 1, method: "pi-estimate", stage: "task_end", contextWindow: value?.contextWindow, estimatedTokens: value?.tokens }); }
	catch { return modelContextSnapshot({ version: 1, method: "pi-estimate", stage: "task_end" }); }
}
