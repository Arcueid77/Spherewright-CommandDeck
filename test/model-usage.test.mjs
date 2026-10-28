import test from "node:test";
import assert from "node:assert/strict";
import { ModelUsage, modelPricing, modelUsageSnapshot } from "../apps/desktop/model-usage.mjs";

const report = (extra = {}) => ({ usage: { input: 80, output: 20, cacheRead: 10, cacheWrite: 5, reasoning: 7, totalTokens: 115, cost: { total: 0 }, ...extra } });
const rates = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 };
function fixture(pricing = rates) { const events = [], usage = new ModelUsage({ pricing, publish: value => events.push(structuredClone(value)) }); return { usage, events }; }

test("normalized cache and reasoning counts are not double billed; retries of result do not double count", async () => {
	const f = fixture(), id = f.usage.start(), source = f.usage.track(id, { result: async () => report() });
	await source.result(); await source.result(); f.usage.finish(id, report());
	const value = f.usage.snapshot();
	assert.deepEqual(value.tokens, { input: 80, output: 20, cacheRead: 10, cacheWrite: 5, totalTokens: 115, reasoning: 7 });
	assert.equal(value.requests, 1); assert.equal(value.reportedResponses, 1); assert.equal(value.coverage, "reported");
	assert.equal(value.estimate.status, "estimated"); assert.ok(Math.abs(value.estimate.usd - 0.00038) < 1e-12);
	assert.equal(f.events.length, 2); assert.equal(f.events[0].pendingResponses, 1);
});

test("unreported, all-zero, malformed and failed responses stay unknown rather than free", async () => {
	for (const message of [null, {}, report({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 }), report({ input: -1 }), report({ output: "20" }), report({ totalTokens: 116 }), report({ reasoning: 21 }), report({ input: Infinity }), report({ input: 1e13, totalTokens: 1e13 + 35 })]) {
		const f = fixture(); f.usage.finish(f.usage.start(), message);
		assert.equal(f.usage.snapshot().coverage, "unknown"); assert.equal(f.usage.snapshot().tokens, null); assert.equal(f.usage.snapshot().estimate.usd, null);
	}
	const f = fixture(), id = f.usage.start(), source = f.usage.track(id, { result: async () => { throw new Error("SYNTHETIC_PROVIDER_ERROR"); } });
	await assert.rejects(source.result(), /SYNTHETIC/); assert.equal(f.usage.snapshot().unknownResponses, 1);
});

test("pending and missing reports keep known partial usage and immutable price snapshots", () => {
	const prices = { ...rates }, f = fixture(prices); prices.input = 999;
	f.usage.finish(f.usage.start(), report()); f.usage.start();
	assert.equal(f.usage.snapshot().coverage, "partial"); assert.equal(f.usage.snapshot().pendingResponses, 1); assert.equal(f.usage.snapshot().pricing.input, 2);
	assert.equal(f.usage.snapshot().estimate.status, "partial");
	f.usage.finish(2, null); const before = f.usage.snapshot();
	assert.equal(before.unknownResponses, 1); assert.equal(before.tokens.totalTokens, 115);
	before.pricing.input = 100; before.tokens.input = 1;
	assert.equal(f.usage.snapshot().pricing.input, 2); assert.equal(f.usage.snapshot().tokens.input, 80);
});

test("missing rate differs from explicit zero, and unpriced nonzero categories keep the estimate partial", () => {
	const unknown = fixture(null); unknown.usage.finish(unknown.usage.start(), report()); assert.equal(unknown.usage.snapshot().estimate.usd, null);
	const free = fixture({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); free.usage.finish(free.usage.start(), report()); assert.equal(free.usage.snapshot().estimate.usd, 0); assert.equal(free.usage.snapshot().estimate.status, "estimated");
	const partial = fixture({ input: 2 }); partial.usage.finish(partial.usage.start(), report()); assert.equal(partial.usage.snapshot().estimate.usd, 0.00016); assert.equal(partial.usage.snapshot().estimate.unpricedTokens, 35); assert.equal(partial.usage.snapshot().estimate.status, "partial");
	const unused = fixture({ input: 2, output: 10 }); unused.usage.finish(unused.usage.start(), report({ cacheRead: 0, cacheWrite: 0, totalTokens: 100 })); assert.equal(unused.usage.snapshot().estimate.status, "estimated");
});

test("bounded out-of-order stream completion and reasoning subset coverage remain explicit", () => {
	const f = fixture(); f.usage.start(); f.usage.start(); f.usage.finish(2, report({ reasoning: undefined })); f.usage.finish(1, report());
	assert.equal(f.usage.snapshot().tokens.totalTokens, 230); assert.equal(f.usage.snapshot().tokens.reasoning, null);
	assert.throws(() => f.usage.finish(3, report()), /MISMATCH/);
	for (let i = 0; i < 4; i++) f.usage.start(); assert.throws(() => f.usage.start(), /LIMIT/);
});

test("ledger projection recomputes estimates and drops provider-controlled extra fields", () => {
	const f = fixture(); f.usage.finish(f.usage.start(), report());
	const before = f.usage.snapshot(), selected = modelUsageSnapshot({ ...before, text: "PRIVATE_PROVIDER_TEXT", credential: "PRIVATE_CREDENTIAL", estimate: { usd: 9999 }, tokens: { ...before.tokens, secret: "PRIVATE_TOKEN" } });
	assert.deepEqual(selected, before); assert.ok(!JSON.stringify(selected).includes("PRIVATE_"));
	for (const patch of [{ version: 2 }, { requests: 7 }, { responses: 2 }, { reportedResponses: -1 }, { tokens: null }, { pricing: { input: -1 } }]) assert.throws(() => modelUsageSnapshot({ ...before, ...patch }));
	for (const pricing of ["0", [], { input: "2" }, { input: NaN }, { input: 1e6 + 1 }, { unexpected: 0 }]) assert.throws(() => modelPricing(pricing), /PRICING/);
	assert.equal(modelPricing({ input: null }), null);
});
