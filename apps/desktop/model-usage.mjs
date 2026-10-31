const categories = ["input", "output", "cacheRead", "cacheWrite"];
export const maximumUsageRequests = 256;
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e15;

// Prices are explicit flat USD rates per million normalized Pi tokens. Missing is not free.
export function modelPricing(value) {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !categories.includes(key))) throw new Error("INVALID_MODEL_PRICING");
	const rates = {};
	for (const key of categories) {
		const rate = value[key] ?? null;
		if (rate !== null && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0 || rate > 1e6)) throw new Error("INVALID_MODEL_PRICING");
		rates[key] = rate;
	}
	return categories.some(key => rates[key] !== null) ? rates : null;
}

function tokens(value) {
	if (!value || !categories.every(key => count(value[key])) || !count(value.totalTokens) || value.totalTokens === 0 || value.totalTokens !== categories.reduce((sum, key) => sum + value[key], 0)) return null;
	const reasoning = value.reasoning === undefined || value.reasoning === null ? null : value.reasoning;
	if (reasoning !== null && (!count(reasoning) || reasoning > value.output)) return null;
	return Object.fromEntries([...categories.map(key => [key, value[key]]), ["totalTokens", value.totalTokens], ["reasoning", reasoning]]);
}

function summarize(requests, responses, reportedResponses, total, pricing) {
	const unknownResponses = responses - reportedResponses, pendingResponses = requests - responses;
	const coverage = !reportedResponses ? "unknown" : reportedResponses === requests ? "reported" : "partial";
	let usd = null, unpricedTokens = total?.totalTokens ?? null;
	if (total && pricing) {
		let priced = false; usd = 0; unpricedTokens = 0;
		for (const key of categories) {
			if (total[key] === 0) continue;
			if (pricing[key] === null) unpricedTokens += total[key];
			else { priced = true; usd += total[key] * pricing[key] / 1e6; }
		}
		if (!priced) usd = null;
	}
	return { version: 1, requests, responses, reportedResponses, unknownResponses, pendingResponses, coverage, tokens: total, pricing, estimate: { status: usd === null ? "unknown" : coverage === "reported" && unpricedTokens === 0 ? "estimated" : "partial", usd, unpricedTokens } };
}

// Structured projection for the game ledger. No provider text, IDs, endpoints or raw payloads.
export function modelUsageSnapshot(value) {
	if (!value || value.version !== 1 || ![value.requests, value.responses, value.reportedResponses].every(count) || value.requests > maximumUsageRequests || value.responses > value.requests || value.reportedResponses > value.responses) throw new Error("INVALID_MODEL_USAGE");
	const total = value.tokens === null ? null : tokens(value.tokens);
	if (Boolean(total) !== (value.reportedResponses > 0)) throw new Error("INVALID_MODEL_USAGE");
	return summarize(value.requests, value.responses, value.reportedResponses, total, modelPricing(value.pricing));
}

export class ModelUsage {
	constructor({ pricing, publish, maximumRequests = 6 }) { if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1 || maximumRequests > maximumUsageRequests) throw new Error("INVALID_MODEL_USAGE_LIMIT"); this.maximumRequests = maximumRequests; this.pricing = modelPricing(pricing); this.publish = publish; this.requests = 0; this.finished = new Set(); this.reported = 0; this.total = null; }
	snapshot() { return summarize(this.requests, this.finished.size, this.reported, this.total && { ...this.total }, this.pricing && { ...this.pricing }); }
	start() { if (this.requests >= this.maximumRequests) throw new Error("MODEL_USAGE_REQUEST_LIMIT"); const id = ++this.requests; this.publish(this.snapshot()); return id; }
	finish(id, message) {
		if (!Number.isInteger(id) || id < 1 || id > this.requests) throw new Error("MODEL_USAGE_REQUEST_MISMATCH");
		if (this.finished.has(id)) return;
		this.finished.add(id);
		const usage = tokens(message?.usage);
		if (usage && usage.totalTokens <= 1e12) {
			if (this.total) { for (const key of [...categories, "totalTokens"]) this.total[key] += usage[key]; this.total.reasoning = this.total.reasoning === null || usage.reasoning === null ? null : this.total.reasoning + usage.reasoning; }
			else this.total = usage;
			this.reported++;
		}
		this.publish(this.snapshot());
	}
	track(id, source) {
		const result = source.result.bind(source);
		source.result = async () => {
			let message;
			try { message = await result(); } catch (error) { this.finish(id, null); throw error; }
			this.finish(id, message); return message;
		};
		return source;
	}
}
