import React from "react";
import { modelUsageSnapshot } from "../../desktop/model-usage.mjs";
import { modelContextSnapshot } from "../../desktop/model-context.mjs";

type Rates = { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null };
export type Usage = { version: 1; requests: number; responses: number; reportedResponses: number; pendingResponses: number; unknownResponses: number; coverage: "unknown" | "partial" | "reported"; tokens: (Rates & { totalTokens: number; reasoning: number | null }) | null; pricing: Rates | null; estimate: { status: "unknown" | "partial" | "estimated"; usd: number | null; unpricedTokens: number | null } };
export type ModelContext = { version: 1; method: "pi-estimate"; stage: "task_end"; contextWindow: number | null; estimatedTokens: number | null; percent: number | null };
const number = (value: number | null) => value === null ? "未知" : value.toLocaleString("zh-CN");
const dollars = (value: number) => value > 0 && value < 1e-9 ? "<0.000000001" : value.toLocaleString("zh-CN", { maximumFractionDigits: 9 });

export function ModelUsage({ value: received, context: receivedContext }: { value?: Usage | null; context?: ModelContext | null }) {
	let value: Usage | null = null;
	let context: ModelContext | null = null;
	try { if (received) value = modelUsageSnapshot(received) as Usage; } catch {}
	try { if (receivedContext) context = modelContextSnapshot(receivedContext) as ModelContext; } catch {}
	return <section className="model-usage" aria-label="模型用量与费用"><b>模型用量与费用</b>{value ? <>
		<p>已登记 {value.requests} 次请求；{value.reportedResponses} 次有用量，{value.unknownResponses} 次缺失，{value.pendingResponses} 次未取得终报。</p>
		{value.tokens ? <p>{value.coverage === "partial" ? "已知部分" : "报告用量"}：{number(value.tokens.totalTokens)} tokens<br />输入 {number(value.tokens.input)} · 输出 {number(value.tokens.output)} · 缓存读取 {number(value.tokens.cacheRead)} · 缓存写入 {number(value.tokens.cacheWrite)}{value.tokens.reasoning !== null && <> · 推理 {number(value.tokens.reasoning)}（已含在输出中）</>}</p> : <p>用量未知；缺失或全零报告不视为免费。</p>}
		<p>{value.estimate.usd === null ? "费用估算未知：缺少用量或适用价格。" : <>费用估算：US$ {dollars(value.estimate.usd)}{value.estimate.status === "partial" ? "（仅已知且已定价部分，总额未知）" : "（按本任务配置）"}</>}</p>
		{value.pricing && <details><summary>任务价格快照 · USD / 百万 tokens</summary><p>输入 {number(value.pricing.input)} · 输出 {number(value.pricing.output)} · 缓存读取 {number(value.pricing.cacheRead)} · 缓存写入 {number(value.pricing.cacheWrite)}</p></details>}
	</> : <p>{received ? "此任务的用量记录无法验证，费用未知。" : "此历史任务未记录用量，费用未知。"}</p>}
		<p className="model-context" aria-label="任务末次上下文估计">任务末次上下文估计：{context?.estimatedTokens !== null && context?.estimatedTokens !== undefined ? `${number(context.estimatedTokens)} tokens` : "未知"}{context?.contextWindow ? ` / ${number(context.contextWindow)}` : ""}{context?.percent !== null && context?.percent !== undefined ? `（${context.percent.toFixed(1)}%）` : ""}。Pi 估计值，不代表下一请求的可用额度。</p>
		<p className="muted">仅统计本工作台收到的报告，按任务开始时的统一费率估算；服务重试、分档、折扣和账单差异以服务方为准。</p></section>;
}
