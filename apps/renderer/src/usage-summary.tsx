import React, { useEffect, useRef, useState } from "react";

type Totals = { tasks: number; recordedTasks: number; legacyTasks: number; invalidTasks: number; knownRequests: number; reportedResponses: number; missingResponses: number; unknownUsageTasks: number; estimatedTasks: number; partialEstimateTasks: number; unpricedTasks: number; contexts: number; unknownContexts: number; invalidContexts: number; maxContextPercent: number | null; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | null; estimatedUsd: number | null };
export type UsageSummary = { version: 1; limitPerSource: number; sources: { domain: string; status: string; sampledAt: string | null; count: number | null; hasMore: boolean | null }[]; partialSources: boolean; truncated: boolean; totals: Totals; groups: (Totals & { domain: string; provider: string | null; model: string | null })[] };
const number = (value: number | null) => value === null ? "未知" : value.toLocaleString("zh-CN");
const dollars = (value: number | null) => value === null ? "未知" : value > 0 && value < 1e-9 ? "US$ <0.000000001" : `US$ ${value.toLocaleString("zh-CN", { maximumFractionDigits: 9 })}`;
const domainName = (value: string) => value === "development" ? "开发 Agent" : "游戏任务";

export function UsageSummaryPanel() {
	const [state, setState] = useState<UsageSummary | null>(null), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [error, setError] = useState(false);
	const alive = useRef(true), loading = useRef(false), revision = useRef(0);
	async function refresh() {
		if (loading.current || !alive.current) return;
		loading.current = true; setBusy(true); setError(false); const expected = revision.current;
		try { const value = await window.deck.modelUsage<UsageSummary>(); if (alive.current) { setState(value); setDirty(revision.current !== expected); } }
		catch { if (alive.current) { setState(null); setError(true); } }
		finally { loading.current = false; if (alive.current) setBusy(false); }
	}
	useEffect(() => {
		alive.current = true; void refresh();
		const unsubscribe = window.deck.onEvent(event => { if (["workbench", "game-changed", "runtime-stopped"].includes(event.type)) { revision.current++; setDirty(true); } });
		return () => { alive.current = false; unsubscribe(); };
	}, []);
	const total = state?.totals;
	return <div className="panel usage-summary" aria-label="模型用量汇总">
		<div className="eyebrow">LOCAL MODEL USAGE</div><h2>用量与费用汇总</h2>
		<p className="muted">分别读取最近最多 {state?.limitPerSource ?? 256} 项开发 Agent 任务和 {state?.limitPerSource ?? 256} 项游戏任务。仅包含当前工作台本地记录，不含探针、其他应用或账号账单。</p>
		<div className="actions"><button disabled={busy} onClick={() => void refresh()}>{busy ? "读取中…" : "刷新用量汇总"}</button>{dirty && <span role="status">记录有变化，请刷新。</span>}</div>
		{error && <p className="notice">用量记录暂不可用，原记录会保留。</p>}
		{state && <>
			{(state.partialSources || state.truncated) && <p className="notice">此汇总不完整：{state.partialSources ? "部分来源不可用。" : ""}{state.truncated ? "部分来源仅列出最近任务。" : ""} 未读取的部分保持未知。</p>}
			<ul>{state.sources.map(source => <li key={source.domain}>{domainName(source.domain)}：{source.status !== "available" ? "不可用" : `${source.count} 项${source.hasMore ? "（还有更早任务未计入）" : ""}；读取于 ${new Date(source.sampledAt!).toLocaleString()}`}</li>)}</ul>
		</>}
		{total && <>
			<p data-usage-summary-total>{total.tasks ? <>已读取 {total.tasks} 项任务，已登记 {number(total.knownRequests)} 次请求；{total.reportedResponses} 次有用量，{total.missingResponses} 次缺失或未取得终报。</> : "当前可读范围没有任务记录，用量与费用未知。"}</p>
			<p>未记录用量的旧任务 {total.legacyTasks} 项 · 无法验证的记录 {total.invalidTasks} 项 · 用量不完整或未知 {total.unknownUsageTasks} 项。</p>
			<p data-usage-summary-cost>已知且已定价部分：{dollars(total.estimatedUsd)}。完整估算 {total.estimatedTasks} 项，部分估算 {total.partialEstimateTasks} 项，无法估算 {total.unpricedTasks} 项。实际账单未知。</p>
			{total.tokens && <p>已报告 {number(total.tokens.totalTokens)} tokens：输入 {number(total.tokens.input)} · 输出 {number(total.tokens.output)} · 缓存读取 {number(total.tokens.cacheRead)} · 缓存写入 {number(total.tokens.cacheWrite)}。</p>}
			<p>任务末次上下文估计占比最大值：{total.maxContextPercent === null ? "未知" : `${total.maxContextPercent.toFixed(1)}%`}；无有效估计 {total.unknownContexts} 项{total.invalidContexts ? `（含 ${total.invalidContexts} 项无法验证的记录）` : ""}。不同任务的上下文不相加。</p>
			{state!.groups.length > 0 && <div className="usage-table-scroll"><table><thead><tr><th>任务 / 模型</th><th>任务数</th><th>已报告 tokens</th><th>已定价部分</th><th>缺失说明</th></tr></thead><tbody>{state!.groups.map((group, index) => <tr key={index}><td>{domainName(group.domain)}<br />{group.provider ?? "provider 未记录"}<br />{group.model ?? "模型未记录"}</td><td>{group.tasks}</td><td>{number(group.tokens?.totalTokens ?? null)}</td><td>{dollars(group.estimatedUsd)}</td><td>用量未知/不全 {group.unknownUsageTasks}<br />部分估算 {group.partialEstimateTasks} · 无估算 {group.unpricedTasks}</td></tr>)}</tbody></table></div>}
		</>}
		<p className="muted">各来源分别采样；费用沿用每项任务的原价格快照，改价不会重算历史。部分费用不能当完整总额。上下文为 Pi 的任务末次估计，不代表下一请求的可用额度。</p>
	</div>;
}
