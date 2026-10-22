import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ageObservation } from "./observation-state";

type Datum<T> = { state: string; reason: string | null; ageMs: number | null; data: T | null };
type Coverage = { complete: boolean; returned: number; total: number; pages: number };
type Numbers = Record<string, number | null>;
type DurationStatistics = { meanMs: number; p95Ms: number; maxMs: number };
type RuntimePerformance = { version: number; source: string; scope: string; sampleCount: number; sampleCapacity: number; completedUpdates: number; windowDurationMs: number; sampleAgeMs: number | null; updateInterval: DurationStatistics | null; bridgePump: DurationStatistics | null; pendingMainThreadRequests: number; mainThreadQueueCapacity: number; lastProcessedMainThreadRequests: number; maxRequestsPerFrame: number; mainThreadBudgetMs: number };
type Planet = { planetId: number; name: string | null; capturedAtGameTick: number; power: Numbers; logistics: Numbers; production: Item[] };
type Item = { itemId: number; itemName: string | null; actualProductionPerMinute: number | null; actualConsumptionPerMinute: number | null; theoreticalProductionPerMinute: number | null; theoreticalCoverage: string | null; utilization: number | null; findingsTruncated: boolean | null; findings: { kind: string; confidence: string; objectId: number }[] };
type Snapshot = { source: string; scope: string; capturedAtGameTick: number; snapshotId: string; coverage: Coverage; planets: Planet[]; research?: Numbers & { currentTechName?: string | null; techQueue?: number[]; techQueueTruncated?: boolean | null }; window?: { state: string; resetReason: string | null; startGameTick: number | null; endGameTick: number | null; elapsedGameTicks: number | null; elapsedGameSeconds: number | null } };
type State = { busy: boolean; selected: { path: string; cohortHash: string; fileCount: number } | null; metadata: { protocolVersion: string; serverVersion: string; toolCount: number; resourceCount: number; readTools: string[]; researchAvailable?: boolean; schemaHash: string } | null; error: string | null; observation: { connected: boolean; refreshing: boolean; itemIds: number[]; requests: number; bridge: Datum<{ pluginVersion: string; gameVersion: string; protocolVersion: number; gameLoaded: boolean }>; session: Datum<{ gameLoaded: boolean; owned: boolean; accessRestricted: boolean; tick: number | null }>; summary: Datum<Snapshot>; production: Datum<Snapshot>; runtimePerformance?: Datum<RuntimePerformance>; events: { reason: string }[] } | null };
type Context = { state: State; notice: string; refresh: () => Promise<void>; act: (action: string, args?: Record<string, unknown>) => Promise<void>; choose: () => Promise<void> };
const Context = createContext<Context>(null!);
export const useBridge = () => useContext(Context);
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.bridge<T>(action, args);
const status: Record<string, string> = { observed: "已观测", stale: "旧数据 · 已过期", unsupported: "此版本未支持", unavailable: "暂无数据", restricted: "当前世界受限", estimated: "理论估计", ready: "窗口就绪", warming_up: "窗口尚未就绪", discontinuous: "采样不连续" };
const reasons: Record<string, string> = { MAIN_MENU: "游戏停在主菜单，尚未载入世界。", READ_ACCESS_RESTRICTED: "当前世界未开放观察权限。", READ_CONTEXT_CHANGED: "世界已切换，旧数据已清除。", MCP_UNAVAILABLE: "服务或游戏连接暂不可用。", READ_TOOL_UNSUPPORTED: "当前服务未提供对应的只读接口。", READ_CONTEXT_UNSUPPORTED: "当前服务缺少兼容的连接接口。", WATCH_CHANGED: "关注列表已更新，等待下一次采样。", READ_CYCLE_TIME_LIMIT: "本轮读取超时，保留旧数据并等待下一轮。" };
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";
export function BridgeProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<State>({ busy: false, selected: null, metadata: null, error: null, observation: null }), [notice, setNotice] = useState("");
	const pending = useRef(false), stopped = useRef(false), receivedAt = useRef(performance.now()), generation = useRef(0), mutating = useRef(false);
	const [mutationBusy, setMutationBusy] = useState(false);
	const [clock, setClock] = useState(performance.now());
	function unavailable() { const now = performance.now(), elapsed = Math.max(0, now - receivedAt.current); receivedAt.current = now; setState((value) => ({ ...value, observation: ageObservation(value.observation, elapsed, true) })); }
	function accept(value: State, started: number, expectedGeneration: number) { if (stopped.current || expectedGeneration !== generation.current) return; const now = performance.now(); receivedAt.current = now; setState({ ...value, observation: ageObservation(value.observation, Math.max(0, now - started)) }); }
	async function refresh() { if (pending.current || stopped.current || mutating.current) return; pending.current = true; const started = performance.now(), expected = generation.current; try { accept(await call<State>("snapshot"), started, expected); } catch { if (expected === generation.current) unavailable(); } finally { pending.current = false; } }
	useEffect(() => { void refresh(); const timer = setInterval(() => { setClock(performance.now()); void refresh(); }, 1000); const unsubscribe = window.deck.onEvent((event) => { if (event.type === "supervisor-disconnected") { stopped.current = true; unavailable(); } else if (event.type === "bridge-changed") void refresh(); }); return () => { clearInterval(timer); unsubscribe(); }; }, []);
	async function act(action: string, args: Record<string, unknown> = {}) { if (mutating.current || stopped.current) return; mutating.current = true; setMutationBusy(true); setNotice(""); const expected = ++generation.current, started = performance.now(); try { accept(await call<State>(action, args), started, expected); } catch { unavailable(); setNotice("操作未完成。请检查连接状态、所选服务文件和关注列表。 "); } finally { generation.current++; mutating.current = false; setMutationBusy(false); } await refresh(); }
	async function choose() { if (mutating.current || stopped.current) return; mutating.current = true; setMutationBusy(true); setNotice(""); const expected = ++generation.current, started = performance.now(); try { const value = await window.deck.chooseBridge(); if (value && typeof value === "object" && "busy" in value) accept(value as State, started, expected); } catch { unavailable(); setNotice("服务未连接。请选择 Spherewright.Mcp.exe；文件改变后需要重新选择。 "); } finally { generation.current++; mutating.current = false; setMutationBusy(false); } await refresh(); }
	const shown = { ...state, busy: state.busy || mutationBusy, observation: ageObservation(state.observation, Math.max(0, clock - receivedAt.current), stopped.current) };
	return <Context.Provider value={{ state: shown, notice, refresh, act, choose }}>{children}</Context.Provider>;
}
function DataState({ value }: { value: Datum<Snapshot> | undefined }) {
	return <><div className={`observation-state ${value?.state ?? "unavailable"}`}>{status[value?.state ?? "unavailable"] ?? value?.state}{value?.ageMs !== null && value?.ageMs !== undefined ? ` · ${fmt(value.ageMs / 1000)} 秒前收到` : ""}</div>{value?.reason && <p className="muted">{reasons[value.reason] ?? "本轮数据未能完整核对，不能作为实时依据。"}</p>}{value?.data && <p className="data-scope">tick {value.data.capturedAtGameTick} · 已建工厂 {value.data.coverage.returned} / {value.data.coverage.total} · {value.data.coverage.complete ? "分页完整" : "只取得部分页面"}<br />来源：{value.data.source}</p>}</>;
}
export function ConnectionPanel() {
	const c = useBridge(), { state } = c, observation = state.observation;
	return <div className="panel bridge-panel"><div className="eyebrow">M2 · READ ONLY</div><h2>只读舰桥</h2><p>选择本机 Spherewright 服务后，即可查看科研、生产、电力和物流。无需模型。</p>
		<div className="actions"><button className="accent" disabled={state.busy} onClick={() => void c.choose()}>选择 MCP 服务</button><button disabled={state.busy || !state.selected || observation?.connected} onClick={() => void c.act("connect")}>重新连接</button><button disabled={state.busy || !observation?.connected} onClick={() => void c.act("disconnect")}>断开</button><button disabled={!observation?.connected} onClick={() => void c.act("refresh")}>刷新数据</button></div>
		<p>{state.busy ? "正在核对并连接本机服务…" : observation?.connected ? "MCP 服务已连接" : "MCP 服务未连接"} · 本页面只读</p>
		{observation?.bridge.data && <p>Spherewright {observation.bridge.data.pluginVersion} · DSP {observation.bridge.data.gameVersion}<br />游戏状态：{observation.session.data?.gameLoaded ? observation.session.data.owned && !observation.session.data.accessRestricted ? "已载入可观察世界" : "世界观察受限" : "主菜单或尚未就绪"}{observation.bridge.state === "stale" ? "（旧状态）" : ""}</p>}
		<RuntimePerformanceReadout value={observation?.runtimePerformance} />
		{state.metadata && <p>已发现 {state.metadata.toolCount} 个接口 / {state.metadata.resourceCount} 个资源；本页面仅使用已核对的 {state.metadata.readTools.length} 个只读接口。{state.metadata.researchAvailable ? "有限研究可在“游戏 Agent”中单独发起。" : ""}</p>}
		{(state.error || c.notice) && <p role="status" className="notice">{c.notice || "连接尚未确认。文件发生变化时请重新选择服务；不会自动启动第二份。"}</p>}
		<p className="muted">本页不会载入存档或提交游戏动作。关闭面板后，连接继续由后台维护；退出应用会关闭本次创建的 MCP 服务。每次启动应用后需重新选择服务。</p>
		{state.selected && <details><summary>连接详情</summary><p className="repository-path">{state.selected.path}</p><p>服务文件组：{state.selected.fileCount} 个文件</p><code>{state.selected.cohortHash}</code>{state.metadata && <p>MCP {state.metadata.serverVersion} · 协议 {state.metadata.protocolVersion}<br />接口摘要 {state.metadata.schemaHash}</p>}</details>}
		{observation?.events.length ? <details><summary>最近的读取事件</summary>{observation.events.slice(-6).map((event, index) => <p key={index}>{reasons[event.reason] ?? event.reason}</p>)}</details> : null}
	</div>;
}
function RuntimePerformanceReadout({ value }: { value: Datum<RuntimePerformance> | undefined }) {
	const data = value?.data;
	const rows: [string, DurationStatistics | null][] = [["Unity 更新间隔", data?.updateInterval ?? null], ["Bridge 主线程处理", data?.bridgePump ?? null]];
	return <section aria-label="运行性能"><h3>运行性能</h3><div className={`observation-state ${value?.state ?? "unavailable"}`}>{status[value?.state ?? "unavailable"] ?? value?.state}{data?.sampleAgeMs !== null && data?.sampleAgeMs !== undefined && value?.ageMs !== null ? ` · 最后样本 ${fmt((value?.ageMs ?? 0) / 1000)} 秒前` : ""}</div>
		{value?.state === "unsupported" && <p className="muted">当前安装版本未提供兼容的运行性能数据。</p>}
		{value?.reason === "RUNTIME_PERFORMANCE_INVALID" && <p className="muted">性能数据未通过格式核对。</p>}
		{data && <><p>{data.sampleCount} / {data.sampleCapacity} 个间隔 · 窗口 {fmt(data.windowDurationMs / 1000, 2)} 秒 · 本次进程</p>
			<table><thead><tr><th>耗时（毫秒）</th><th>平均</th><th>P95</th><th>最大</th></tr></thead><tbody>{rows.map(([label, timing]) => <tr key={label}><td>{label}</td><td>{fmt(timing?.meanMs, 2)}</td><td>{fmt(timing?.p95Ms, 2)}</td><td>{fmt(timing?.maxMs, 2)}</td></tr>)}</tbody></table>
			<p>当前排队 {data.pendingMainThreadRequests} / {data.mainThreadQueueCapacity} · 上次处理 {data.lastProcessedMainThreadRequests} 个请求<br />每帧上限 {data.maxRequestsPerFrame} 个 · 调度预算 {fmt(data.mainThreadBudgetMs, 2)} 毫秒</p>
		</>}
		<p className="muted">更新间隔由游戏主线程计时，与 GPU 帧率不同。窗口保留长停顿；调度预算不抢占执行中的请求。</p>
	</section>;
}
export function ResearchPanel() {
	const value = useBridge().state.observation?.summary, research = value?.data?.research;
	return <div className="panel bridge-panel"><div className="eyebrow">RESEARCH</div><h2>科研与队列</h2><DataState value={value} />{research && <><h3>{research.currentTechName || (research.currentTechId === 0 ? "当前没有研究" : "当前研究名称未知")}</h3><p>研究点 {fmt(research.currentHashUploaded)} / {fmt(research.currentHashRequired)}<br />已解锁 {fmt(research.unlockedTechCount)} / {fmt(research.runtimeTechStateCount)}</p><p>队列 {fmt(research.queuedTechCount)} 项：{research.techQueue?.map((id) => `#${id}`).join(" → ") || "—"}{research.techQueueTruncated ? "（列表未完整返回）" : ""}</p></>}<p className="muted">研究入队和研究完成分别显示；此处只观察。</p></div>;
}
const findings: Record<string, string> = { material_shortage: "缺料", output_blocked: "输出堵塞", insufficient_power: "供电不足", logistics_blocked: "物流可能阻塞", vein_exhausted: "矿脉耗尽" };
export function ProductionPanel() {
	const c = useBridge(), value = c.state.observation?.production, [input, setInput] = useState("6001,6002,6003,6004");
	const itemKey = c.state.observation?.itemIds.join(","); useEffect(() => { if (itemKey) setInput(itemKey); }, [itemKey]);
	const rows = value?.data?.planets.flatMap((planet) => planet.production.map((item) => ({ planet, item }))) ?? [];
	return <div className="panel bridge-panel"><div className="eyebrow">PRODUCTION</div><h2>关注产物</h2><form className="watch-items" onSubmit={(event) => { event.preventDefault(); void c.act("watch", { itemIds: input.split(/[,，\s]+/).filter(Boolean).map(Number) }); }}><input aria-label="关注物品 ID" value={input} maxLength={200} onChange={(event) => setInput(event.target.value)} /><button disabled={!c.state.observation?.connected || c.state.busy}>应用</button></form><p className="muted">填写 1–16 个当前游戏的物品 ID，以逗号分隔。</p><DataState value={value} />
		{value?.data?.window && <p>生产窗口：{status[value.data.window.state] ?? value.data.window.state} · tick {value.data.window.startGameTick ?? "—"}–{value.data.window.endGameTick ?? "—"} · {fmt(value.data.window.elapsedGameSeconds)} 游戏秒</p>}
		{rows.length > 0 && <div className="table-scroll"><table><thead><tr><th>星球 / 产物</th><th>实产 / 分</th><th>实耗 / 分</th><th>理论 / 分</th><th>利用率</th><th>当前诊断</th></tr></thead><tbody>{rows.slice(0, 300).map(({ planet, item }) => <tr key={`${planet.planetId}/${item.itemId}`}><td>{planet.name ?? `#${planet.planetId}`}<br />{item.itemName ?? `#${item.itemId}`}</td><td>{fmt(item.actualProductionPerMinute)}</td><td>{fmt(item.actualConsumptionPerMinute)}</td><td>{fmt(item.theoreticalProductionPerMinute)}{item.theoreticalProductionPerMinute !== null ? <small>估计 · {item.theoreticalCoverage === "complete" ? "完整覆盖" : "部分覆盖"}</small> : null}</td><td>{fmt(item.utilization === null ? null : item.utilization * 100)}%</td><td>{item.findings.map((finding, index) => <small key={index}>{findings[finding.kind] ?? finding.kind}{finding.confidence === "suspected" ? "（疑似）" : ""} · #{finding.objectId}</small>)}{item.findingsTruncated ? <small>诊断列表未完整返回</small> : null}</td></tr>)}</tbody></table></div>}
		{rows.length > 300 && <p>只显示前 300 / {rows.length} 行；后台已取得的覆盖范围见上方。</p>}{c.notice && <p className="notice">{c.notice}</p>}<p className="muted">— 表示证据缺失或窗口未就绪。理论容量为估计值；重叠窗口不能累加为持续产量。</p>
	</div>;
}
export function PowerPanel() {
	const value = useBridge().state.observation?.summary, mw = (value: number | null) => fmt(value === null ? null : value * 60 / 1000000, 3);
	return <div className="panel bridge-panel"><div className="eyebrow">POWER</div><h2>供电</h2><DataState value={value} />{value?.data && <div className="table-scroll"><table><thead><tr><th>星球</th><th>当前发电</th><th>当前容量</th><th>需求</th><th>已供给</th><th>最低供电比</th></tr></thead><tbody>{value.data.planets.map((planet) => <tr key={planet.planetId}><td>{planet.name ?? `#${planet.planetId}`}</td><td>{mw(planet.power.totalEnergyGenerated)}</td><td>{mw(planet.power.totalEnergyCapacity)}</td><td>{mw(planet.power.totalEnergyRequired)}</td><td>{mw(planet.power.totalEnergyServed)}</td><td>{fmt(planet.power.minimumConsumerRatio === null ? null : planet.power.minimumConsumerRatio * 100)}%</td></tr>)}</tbody></table></div>}<p className="muted">单位 MW（游戏时间），按 60 tick / 秒从 J / tick 换算。当前满供不证明长期燃料或扩产余量；— 为未提供。</p></div>;
}
export function LogisticsPanel() {
	const value = useBridge().state.observation?.summary;
	return <div className="panel bridge-panel"><div className="eyebrow">LOGISTICS</div><h2>物流概览</h2><DataState value={value} />{value?.data && <div className="table-scroll"><table><thead><tr><th>星球</th><th>物流站</th><th>库存件数</th><th>配送机运行 / 空闲</th><th>运输船运行 / 空闲</th><th>供电不足站</th><th>待履约槽位</th></tr></thead><tbody>{value.data.planets.map((planet) => <tr key={planet.planetId}><td>{planet.name ?? `#${planet.planetId}`}</td><td>{fmt(planet.logistics.stationCount)}</td><td>{fmt(planet.logistics.storedItemCount)}</td><td>{fmt(planet.logistics.workingDroneCount)} / {fmt(planet.logistics.idleDroneCount)}</td><td>{fmt(planet.logistics.workingVesselCount)} / {fmt(planet.logistics.idleVesselCount)}</td><td>{fmt(planet.logistics.underpoweredStationCount)}</td><td>本地 {fmt(planet.logistics.outstandingLocalOrderSlotCount)}<br />星际 {fmt(planet.logistics.outstandingRemoteOrderSlotCount)}</td></tr>)}</tbody></table></div>}<p className="muted">范围仅包含已创建工厂的聚合观察。运行数、库存及运单不能单独证明持续供料。</p></div>;
}
