import { modelUsageSnapshot } from "./model-usage.mjs";
import { modelContextSnapshot } from "./model-context.mjs";

export const usageTaskLimit = 256;
const categories = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
const metadata = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
export function decodeUsageJson(value) {
	if (value === null || value === undefined) return null;
	try { return typeof value === "string" && value.length <= 65536 ? JSON.parse(value) ?? false : false; } catch { return false; }
}
export function usageSample(rows, sampledAt = new Date().toISOString()) {
	if (!Array.isArray(rows) || rows.length > usageTaskLimit + 1) throw new Error("INVALID_USAGE_SAMPLE");
	return { status: "available", sampledAt, hasMore: rows.length > usageTaskLimit, rows: rows.slice(0, usageTaskLimit).map(received => {
		const row = received && typeof received === "object" && !Array.isArray(received) ? received : { usage: false, context: false };
		return { provider: metadata(row.provider), model: metadata(row.model), usage: row.usage, context: row.context };
	}) };
}
function empty() { return { tasks: 0, recordedTasks: 0, legacyTasks: 0, invalidTasks: 0, knownRequests: 0, reportedResponses: 0, missingResponses: 0, unknownUsageTasks: 0, estimatedTasks: 0, partialEstimateTasks: 0, unpricedTasks: 0, contexts: 0, unknownContexts: 0, invalidContexts: 0, maxContextPercent: null, tokens: null, estimatedUsd: null }; }
function add(target, record) {
	target.tasks++;
	let usage; try { usage = record.usage === null || record.usage === undefined ? null : modelUsageSnapshot(record.usage); if (usage?.tokens?.totalTokens > 6e12) throw new Error("USAGE_SUMMARY_RANGE"); } catch { usage = null; target.invalidTasks++; }
	if (!usage) { if (record.usage === null || record.usage === undefined) target.legacyTasks++; target.unknownUsageTasks++; target.unpricedTasks++; }
	else {
		target.recordedTasks++; target.knownRequests += usage.requests; target.reportedResponses += usage.reportedResponses; target.missingResponses += usage.unknownResponses + usage.pendingResponses;
		if (usage.coverage !== "reported") target.unknownUsageTasks++;
		if (usage.tokens) { target.tokens ??= Object.fromEntries(categories.map(key => [key, 0])); for (const key of categories) target.tokens[key] += usage.tokens[key]; }
		if (usage.estimate.usd !== null) target.estimatedUsd = (target.estimatedUsd ?? 0) + usage.estimate.usd;
		if (usage.estimate.status === "estimated") target.estimatedTasks++; else if (usage.estimate.status === "partial") target.partialEstimateTasks++; else target.unpricedTasks++;
	}
	try {
		if (record.context === null || record.context === undefined) target.unknownContexts++;
		else { const context = modelContextSnapshot(record.context); target.contexts++; if (context.percent === null) target.unknownContexts++; else target.maxContextPercent = Math.max(target.maxContextPercent ?? 0, context.percent); }
	} catch { target.invalidContexts++; target.unknownContexts++; }
}

// Each source is a separate bounded sample; no global transaction or invoice is implied.
export function summarizeModelUsage(input) {
	const totals = empty(), groups = new Map(), sources = [];
	for (const domain of ["development", "game"]) {
		const source = input?.[domain];
		if (source?.status !== "available" || !Array.isArray(source.rows) || source.rows.length > usageTaskLimit || typeof source.sampledAt !== "string") { sources.push({ domain, status: "unavailable", sampledAt: null, count: null, hasMore: null }); continue; }
		sources.push({ domain, status: "available", sampledAt: source.sampledAt, count: source.rows.length, hasMore: source.hasMore === true });
		for (const received of source.rows) {
			const record = received && typeof received === "object" && !Array.isArray(received) ? received : { usage: false, context: false };
			const provider = metadata(record.provider), model = metadata(record.model), key = JSON.stringify([domain, provider, model]);
			if (!groups.has(key)) groups.set(key, { domain, provider, model, ...empty() });
			add(totals, record); add(groups.get(key), record);
		}
	}
	return { version: 1, limitPerSource: usageTaskLimit, sources, partialSources: sources.some(source => source.status !== "available"), truncated: sources.some(source => source.hasMore === true), totals, groups: [...groups.values()] };
}

export async function readModelUsageSummary(readers) {
	const sources = await Promise.all(["development", "game"].map(async domain => {
		try { return [domain, await readers[domain]()]; } catch { return [domain, { status: "unavailable" }]; }
	}));
	return summarizeModelUsage(Object.fromEntries(sources));
}
