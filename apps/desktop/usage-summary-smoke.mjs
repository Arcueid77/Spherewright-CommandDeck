import assert from "node:assert/strict";
import { modelContextSnapshot } from "./model-context.mjs";

// Read-only assertions shared by existing source and whole-application restart fixtures.
export async function verifyUsageSummary(driver, { domain, usage, context: receivedContext }) {
	const context = modelContextSnapshot(receivedContext), summary = await driver.api("model-usage");
	assert.equal(summary.version, 1); assert.equal(summary.limitPerSource, 256); assert.equal(summary.partialSources, false); assert.equal(summary.truncated, false);
	assert.equal(summary.groups.length, 1); assert.equal(summary.groups[0].domain, domain); assert.equal(summary.totals.tasks, 1); assert.equal(summary.totals.legacyTasks, 0); assert.equal(summary.totals.invalidTasks, 0);
	assert.equal(summary.totals.knownRequests, usage.requests); assert.equal(summary.totals.tokens.totalTokens, usage.tokens.totalTokens); assert.equal(summary.totals.estimatedUsd, usage.estimate.usd);
	assert.equal(summary.totals.contexts, 1); assert.equal(summary.totals.maxContextPercent, context.percent); assert.ok(context.contextWindow > 0 && context.estimatedTokens > 0);
	const evaluate = source => driver.testCommand("evaluate", { source }), deadline = performance.now() + 10000;
	let opened = false;
	while (true) {
		if (!opened) opened = await evaluate("(()=>{const button=[...document.querySelectorAll('header button')].find(value=>value.textContent==='用量汇总');if(!button||button.disabled)return false;button.click();return true})()");
		if (opened && await evaluate("(()=>{const panel=document.querySelector('[aria-label=模型用量汇总]'),total=panel?.querySelector('[data-usage-summary-total]')?.textContent,cost=panel?.querySelector('[data-usage-summary-cost]')?.textContent;return Boolean(total?.includes('已读取 1 项任务')&&panel?.textContent.includes(" + JSON.stringify(usage.tokens.totalTokens + " tokens") + ")&&cost?.includes(" + JSON.stringify(usage.estimate.usd.toLocaleString("zh-CN", { maximumFractionDigits: 9 })) + ")&&panel?.textContent.includes('实际账单未知'))})()")) break;
		assert.ok(performance.now() < deadline, "USAGE_SUMMARY_UI_NOT_READY"); await new Promise(resolve => setTimeout(resolve, 50));
	}
	assert.deepEqual(await evaluate("(async()=>{const value=await window.deck.modelUsage();return {tokens:value.totals.tokens.totalTokens,requests:value.totals.knownRequests,context:value.totals.maxContextPercent}})()"), { tokens: usage.tokens.totalTokens, requests: usage.requests, context: context.percent });
	return { readOnlySummaryVerified: true, boundedTasks: 1, normalizedTokens: usage.tokens.totalTokens, estimatedUsd: usage.estimate.usd, taskEndContext: context, fullInvoiceVerified: false };
}
