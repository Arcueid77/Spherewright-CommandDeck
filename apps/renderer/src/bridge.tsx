import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ageObservation } from "./observation-state";
import { UiPerformance, type UiPerformanceSnapshot } from "./ui-performance";

type Datum<T> = { state: string; reason: string | null; ageMs: number | null; data: T | null };
type Coverage = { complete: boolean; returned: number; total: number; pages: number };
type Numbers = Record<string, number | null>;
type DurationStatistics = { meanMs: number; p95Ms: number; maxMs: number };
type ClientTiming = { sampleCount: number; roundTripSampleCount: number; windowDurationMs: number | null; lastCompletedAgeMs: number | null; durationMs: DurationStatistics | null };
type ClientCounts = { started: number; responses: number; rpcErrors: number; aborted: number };
type ClientPerformance = ClientTiming & ClientCounts & { version: number; source: string; sampleCapacity: number; pending: number; pendingCapacity: number; peakPending: number; transportClosed: boolean; duplicateReplies: number; rejectedBeforeAdmission: number; byKind: Record<"metadata" | "tool" | "resource", ClientTiming & ClientCounts>; lifetime: { state: string; basis: string; durationMs: number; endedAgeMs: number | null }; observationLimit?: { maxToolRequests: number; maxDurationMs: number; toolRequests: number; remainingToolRequests: number; stopReason: string | null } };
type RuntimePerformance = { version: number; source: string; scope: string; sampleCount: number; sampleCapacity: number; completedUpdates: number; windowDurationMs: number; sampleAgeMs: number | null; updateInterval: DurationStatistics | null; bridgePump: DurationStatistics | null; pendingMainThreadRequests: number; mainThreadQueueCapacity: number; lastProcessedMainThreadRequests: number; maxRequestsPerFrame: number; mainThreadBudgetMs: number };
type Planet = { planetId: number; name: string | null; capturedAtGameTick: number; power: Numbers; logistics: Numbers; production: Item[] };
type Item = { itemId: number; itemName: string | null; actualProductionPerMinute: number | null; actualConsumptionPerMinute: number | null; theoreticalProductionPerMinute: number | null; theoreticalCoverage: string | null; utilization: number | null; findingsTruncated: boolean | null; findings: { kind: string; confidence: string; objectId: number }[] };
type Snapshot = { source: string; scope: string; capturedAtGameTick: number; snapshotId: string; coverage: Coverage; planets: Planet[]; research?: Numbers & { currentTechName?: string | null; techQueue?: number[]; techQueueTruncated?: boolean | null }; window?: { state: string; resetReason: string | null; startGameTick: number | null; endGameTick: number | null; elapsedGameTicks: number | null; elapsedGameSeconds: number | null } };
type Mecha = { source: string; scope: string; capturedAtGameTick: number; planetId: number; position: Numbers; movementState: string | null; isAlive: boolean | null; isOnPlanet: boolean | null; isFlying: boolean | null; isSailing: boolean | null; speedMetresPerSecond: number | null; coreEnergyFraction: number | null; reactorItemId: number | null; reactorItemName: string | null; autoReplenishFuel: boolean | null; fuelStorage: { itemId: number | null; name: string | null; count: number | null; slotCount: number | null }[] | null; constructionDrones: { enabled: boolean | null; constructionEnabled: boolean | null; total: number | null; alive: number | null; idle: number | null; working: number | null; pendingBuildTargets: number | null; pendingRepairTargets: number | null }; handcraftQueue: { queueIndex: number | null; recipeId: number | null; recipeName: string | null; remainingCraftCount: number | null; progress: number | null; progressRequired: number | null }[] | null };
type State = { connectionGeneration?: number; busy: boolean; selected: { path: string; cohortHash: string; fileCount: number } | null; metadata: { protocolVersion: string; serverVersion: string; toolCount: number; resourceCount: number; readTools: string[]; researchAvailable?: boolean; schemaHash: string } | null; error: string | null; requestPerformance?: ClientPerformance | null; observationPolicy?: { maxToolRequests: number; maxDurationMs: number } | null; observation: { connected: boolean; refreshing: boolean; itemIds: number[]; requests: number; bridge: Datum<{ pluginVersion: string; gameVersion: string; protocolVersion: number; gameLoaded: boolean }>; session: Datum<{ gameLoaded: boolean; owned: boolean; accessRestricted: boolean; tick: number | null }>; summary: Datum<Snapshot>; production: Datum<Snapshot>; runtimePerformance?: Datum<RuntimePerformance>; mechaEnabled?: boolean; mecha?: Datum<Mecha>; events: { reason: string }[] } | null };
type Context = { state: State; notice: string; uiPerformance: UiPerformanceSnapshot; refresh: () => Promise<void>; act: (action: string, args?: Record<string, unknown>) => Promise<void>; choose: () => Promise<void> };
const Context = createContext<Context>(null!);
export const useBridge = () => useContext(Context);
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.bridge<T>(action, args);
const status: Record<string, string> = { observed: "已观测", stale: "旧数据 · 已过期", unsupported: "此版本未支持", unavailable: "暂无数据", restricted: "当前世界受限", estimated: "理论估计", ready: "窗口就绪", warming_up: "窗口尚未就绪", discontinuous: "采样不连续" };
const reasons: Record<string, string> = { MAIN_MENU: "游戏停在主菜单，尚未载入世界。", READ_ACCESS_RESTRICTED: "当前世界未开放观察权限。", READ_CONTEXT_CHANGED: "世界已切换，旧数据已清除。", MCP_UNAVAILABLE: "服务或游戏连接暂不可用。", READ_TOOL_UNSUPPORTED: "当前服务未提供对应的只读接口。", READ_CONTEXT_UNSUPPORTED: "当前服务缺少兼容的连接接口。", WATCH_CHANGED: "关注列表已更新，等待下一次采样。", READ_CYCLE_TIME_LIMIT: "本轮读取超时，保留旧数据并等待下一轮。" };
const fmt = (value: number | null | undefined, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";
const yesNo = (value: boolean | null | undefined) => value === true ? "是" : value === false ? "否" : "—";
Object.assign(reasons, { MECHA_OBSERVATION_DISABLED: "机甲观测已暂停，保留记录仅供回看。", WAITING_FOR_MECHA: "正在等待机甲快照。", NO_LOCAL_PLANET: "当前没有可读取的本地星球机甲快照。", READ_MECHA_SCOPE_CHANGED: "星球或采样范围已变化，等待新的完整快照。", READ_MECHA_SCHEMA_CHANGED: "机甲数据格式发生变化，本轮快照未显示。", MECHA_READ_FAILED: "本轮机甲快照暂不可用。" });
export function BridgeProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<State>({ busy: false, selected: null, metadata: null, error: null, observation: null }), [notice, setNotice] = useState("");
	const pending = useRef(false), stopped = useRef(false), receivedAt = useRef(performance.now()), generation = useRef(0), mutating = useRef(false);
	const [mutationBusy, setMutationBusy] = useState(false);
	const [clock, setClock] = useState(performance.now());
	const meter = useRef<UiPerformance | null>(null), [delivery, setDelivery] = useState(0);
	if (!meter.current) meter.current = new UiPerformance({ visible: document.visibilityState === "visible" });
	const measure = meter.current;
	const syncVisibility = () => measure.setVisible(document.visibilityState === "visible");
	function unavailable() { measure.setConnection(null, false); measure.interrupt(); const now = performance.now(), elapsed = Math.max(0, now - receivedAt.current); receivedAt.current = now; setState((value) => ({ ...value, observation: ageObservation(value.observation, elapsed, true) })); }
	function accept(value: State, started: number, expectedGeneration: number, probe?: ReturnType<UiPerformance['beginSnapshot']>) {
		if (stopped.current || expectedGeneration !== generation.current) { probe?.discarded(); return; }
		syncVisibility(); measure.setConnection(value.connectionGeneration ?? null, value.observation?.connected === true); const id = probe?.received(); if (!probe) measure.interrupt();
		const now = performance.now(); receivedAt.current = now; setState({ ...value, observation: ageObservation(value.observation, Math.max(0, now - started)) });
		if (id !== null && id !== undefined) setDelivery(id);
	}
	async function refresh() {
		if (pending.current || stopped.current || mutating.current) return; pending.current = true; syncVisibility();
		const started = performance.now(), expected = generation.current, probe = measure.beginSnapshot();
		try { accept(await call<State>("snapshot"), started, expected, probe); } catch { probe.failed(); if (expected === generation.current) unavailable(); } finally { pending.current = false; }
	}
	useLayoutEffect(() => { syncVisibility(); measure.committed(delivery); }, [delivery]);
	useEffect(() => {
		stopped.current = false; void refresh();
		const timer = setInterval(() => { setClock(performance.now()); void refresh(); }, 1000);
		const unsubscribe = window.deck.onEvent((event) => { if (event.type === "supervisor-disconnected") { stopped.current = true; unavailable(); } else if (event.type === "system-power") { generation.current++; unavailable(); void refresh(); } else if (event.type === "bridge-changed") void refresh(); });
		document.addEventListener("visibilitychange", syncVisibility);
		return () => { stopped.current = true; generation.current++; measure.interrupt(); clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", syncVisibility); };
	}, []);
	async function act(action: string, args: Record<string, unknown> = {}) { if (mutating.current || stopped.current) return; mutating.current = true; setMutationBusy(true); setNotice(""); const expected = ++generation.current, started = performance.now(); try { accept(await call<State>(action, args), started, expected); } catch { unavailable(); setNotice("操作未完成。请检查连接状态、所选服务文件和关注列表。 "); } finally { generation.current++; mutating.current = false; setMutationBusy(false); } await refresh(); }
	async function choose() { if (mutating.current || stopped.current) return; mutating.current = true; setMutationBusy(true); setNotice(""); const expected = ++generation.current, started = performance.now(); try { const value = await window.deck.chooseBridge(); if (value && typeof value === "object" && "busy" in value) accept(value as State, started, expected); } catch { unavailable(); setNotice("服务未连接。请选择 Spherewright.Mcp.exe；文件改变后需要重新选择。 "); } finally { generation.current++; mutating.current = false; setMutationBusy(false); } await refresh(); }
	const shown = { ...state, busy: state.busy || mutationBusy, observation: ageObservation(state.observation, Math.max(0, clock - receivedAt.current), stopped.current) };
	return <Context.Provider value={{ state: shown, notice, uiPerformance: measure.snapshot(), refresh, act, choose }}>{children}</Context.Provider>;
}
function DataState({ value }: { value: Datum<{ capturedAtGameTick: number; source: string; coverage?: Coverage }> | undefined }) {
	return <><div className={`observation-state ${value?.state ?? "unavailable"}`}>{status[value?.state ?? "unavailable"] ?? value?.state}{value?.ageMs !== null && value?.ageMs !== undefined ? ` · ${fmt(value.ageMs / 1000)} 秒前收到` : ""}</div>{value?.reason && <p className="muted">{reasons[value.reason] ?? "本轮数据未能完整核对，不能作为实时依据。"}</p>}{value?.data && <p className="data-scope">tick {value.data.capturedAtGameTick}{value.data.coverage && <> · 已建工厂 {value.data.coverage.returned} / {value.data.coverage.total} · {value.data.coverage.complete ? "分页完整" : "只取得部分页面"}</>}<br />来源：{value.data.source}</p>}</>;
}
export function ConnectionPanel() {
	const c = useBridge(), { state } = c, observation = state.observation;
	return <div className="panel bridge-panel"><div className="eyebrow">M2 · READ ONLY</div><h2>只读舰桥</h2><p>选择本机 Spherewright 服务后，即可查看科研、生产、电力和物流。无需模型。</p>
		{state.observationPolicy && <p className="notice" role="status">本次限时只读观测：最多 {state.observationPolicy.maxToolRequests} 次工具请求 / {fmt(state.observationPolicy.maxDurationMs / 1000)} 秒。游戏执行、Agent 与开发写入入口已关闭；本次运行仅启动一次服务，重连不续额度。</p>}
		<div className="actions"><button className="accent" disabled={state.busy} onClick={() => void c.choose()}>选择 MCP 服务</button><button disabled={state.busy || !state.selected || observation?.connected} onClick={() => void c.act("connect")}>重新连接</button><button disabled={state.busy || !observation?.connected} onClick={() => void c.act("disconnect")}>断开</button><button disabled={!observation?.connected} onClick={() => void c.act("refresh")}>刷新数据</button></div>
		<p>{state.busy ? "正在核对并连接本机服务…" : observation?.connected ? "MCP 服务已连接" : "MCP 服务未连接"} · 本页面只读</p>
		{observation?.bridge.data && <p>Spherewright {observation.bridge.data.pluginVersion} · DSP {observation.bridge.data.gameVersion}<br />游戏状态：{observation.session.data?.gameLoaded ? observation.session.data.owned && !observation.session.data.accessRestricted ? "已载入可观察世界" : "世界观察受限" : "主菜单或尚未就绪"}{observation.bridge.state === "stale" ? "（旧状态）" : ""}</p>}
		<RuntimePerformanceReadout value={observation?.runtimePerformance} />
		<ClientPerformanceReadout value={state.requestPerformance} connected={observation?.connected === true && observation.bridge.state !== "stale"} />
		<UiPerformanceReadout value={c.uiPerformance} />
		<ConnectedUiPerformanceReadout value={c.uiPerformance.connected} />
		{state.metadata && <p>已发现 {state.metadata.toolCount} 个接口 / {state.metadata.resourceCount} 个资源；本页面仅使用已核对的 {state.metadata.readTools.length} 个只读接口。{state.metadata.researchAvailable ? "有限研究可在“游戏 Agent”中单独发起。" : ""}</p>}
		{(state.error || c.notice) && <p role="status" className="notice">{c.notice || "连接尚未确认。文件发生变化时请重新选择服务；不会自动启动第二份。"}</p>}
		<p className="muted">本页不会载入存档或提交游戏动作。关闭面板后，连接继续由后台维护；退出应用会关闭本次创建的 MCP 服务。每次启动应用后需重新选择服务。</p>
		{state.selected && <details><summary>连接详情</summary><p className="repository-path">{state.selected.path}</p><p>服务文件组：{state.selected.fileCount} 个文件</p><code>{state.selected.cohortHash}</code>{state.metadata && <p>MCP {state.metadata.serverVersion} · 协议 {state.metadata.protocolVersion}<br />接口摘要 {state.metadata.schemaHash}</p>}</details>}
		{observation?.events.length ? <details><summary>最近的读取事件</summary>{observation.events.slice(-6).map((event, index) => <p key={index}>{reasons[event.reason] ?? event.reason}</p>)}</details> : null}
	</div>;
}
function UiPerformanceReadout({ value }: { value: UiPerformanceSnapshot }) {
	const rows: [string, DurationStatistics | null][] = [["界面快照往返", value.rpc.durationMs], ["收到至界面提交", value.frame.commitMs], ["提交至下一帧回调", value.frame.nextFrameMs], ["请求至下一帧回调", value.frame.totalMs]];
	return <section aria-label="界面响应测量" data-measurement={JSON.stringify(value)}><h3>界面响应测量</h3>
		<p>本界面 · {value.visible ? "窗口可见" : "窗口隐藏"} · RPC 样本 {value.rpc.sampleCount} / {value.sampleCapacity} · 帧回调样本 {value.frame.sampleCount} / {value.sampleCapacity}</p>
		<table><thead><tr><th>耗时（毫秒）</th><th>平均</th><th>P95</th><th>最大</th></tr></thead><tbody>{rows.map(([label, timing]) => <tr key={label}><td>{label}</td><td>{fmt(timing?.meanMs, 2)}</td><td>{fmt(timing?.p95Ms, 2)}</td><td>{fmt(timing?.maxMs, 2)}</td></tr>)}</tbody></table>
		<p>帧样本窗口 {fmt(value.frame.windowDurationMs === null ? null : value.frame.windowDurationMs / 1000, 2)} 秒 · 末次回调 {fmt(value.frame.latestAgeMs === null ? null : value.frame.latestAgeMs / 1000)} 秒前<br />隐藏或跨可见性 {value.hiddenOrTransition} · 合并交付 {value.coalesced} · 中断 {value.interrupted}<br />请求失败 {value.failed} · 丢弃回复 {value.discarded} · 帧回调不可用 {value.frameUnavailable}</p>
		<details><summary>测量范围</summary><p className="muted">沿用界面的只读快照请求。可见期间，以本界面单调时钟记录请求、接收、React提交和后续动画帧回调；回调先于绘制，不代表GPU呈现或键鼠输入延迟。隐藏/跨可见性样本单列，长可见停顿保留；最多128个样本，界面重载重新计数。</p></details>
	</section>;
}
function ConnectedUiPerformanceReadout({ value }: { value: UiPerformanceSnapshot['connected'] }) {
	const rows: [string, DurationStatistics | null][] = [["连接期快照往返", value?.rpc.durationMs ?? null], ["连接期收到至提交", value?.frame.commitMs ?? null], ["连接期提交至帧回调", value?.frame.nextFrameMs ?? null], ["连接期请求至帧回调", value?.frame.totalMs ?? null]];
	return <section aria-label="当前连接的界面响应" data-connected-measurement={JSON.stringify(value)}><h3>当前连接的界面响应</h3>
		<p>{value ? `${value.active ? "当前连接" : "保留已确认样本"} · 第 ${value.generation} 次连接` : "等待连接"} · 已核对快照 {value?.rpc.sampleCount ?? 0} / 128 · 已核对帧回调 {value?.frame.sampleCount ?? 0} / 128</p>
		<table><thead><tr><th>耗时（毫秒）</th><th>平均</th><th>P95</th><th>最大</th></tr></thead><tbody>{rows.map(([label, timing]) => <tr key={label}><td>{label}</td><td>{fmt(timing?.meanMs, 2)}</td><td>{fmt(timing?.p95Ms, 2)}</td><td>{fmt(timing?.maxMs, 2)}</td></tr>)}</tbody></table>
		<p>连接期帧窗口 {fmt(value?.frame.windowDurationMs === null || value?.frame.windowDurationMs === undefined ? null : value.frame.windowDurationMs / 1000, 2)} 秒 · 边界回复 {value?.boundaryResponses ?? 0}<br />未获后续确认的快照 {value?.unconfirmedSnapshots ?? 0} / 帧 {value?.unconfirmedFrames ?? 0}{value?.awaitingSnapshotConfirmation || value?.awaitingFrameConfirmation ? " · 仍有样本待确认" : ""}</p>
		<details><summary>测量范围</summary><p className="muted">只记录可见且前后属于同一次活动连接的快照；快照接收和帧回调完成后，还须由其后发起的界面快照确认连接仍活动。连接前准备、连接切换和断开后的操作不进入此表，未确认的末尾样本单列。重新连接建立新窗口；原始整界面测量仍保留长停顿。本表不代表GPU呈现或游戏输入延迟，不增加游戏请求。</p></details>
	</section>;
}
function ClientPerformanceReadout({ value, connected }: { value?: ClientPerformance | null; connected: boolean }) {
	if (!value) return null;
	const lifetime = value.lifetime, phase = lifetime.state === "exit_observed" ? "子进程退出已确认" : lifetime.state === "launch_failed" ? "子进程未能启动" : value.transportClosed ? "退出待确认" : "运行中快照";
	const rows: [string, DurationStatistics | null][] = [["全部 RPC", value.durationMs], ["工具 RPC", value.byKind.tool.durationMs]];
	return <section aria-label="MCP 客户端测量"><h3>MCP 客户端测量</h3><p>{connected ? "本连接快照" : "已保留快照 · 当前未确认实时连接"} · {phase}</p>
		{value.observationLimit && <p>本次工具请求 {value.observationLimit.toolRequests} / {value.observationLimit.maxToolRequests} · 剩余 {value.observationLimit.remainingToolRequests}<br />{value.observationLimit.stopReason === 'MCP_OBSERVATION_TIME_LIMIT' ? '已达观测时限' : value.observationLimit.stopReason === 'MCP_OBSERVATION_REQUEST_LIMIT' ? '已达请求上限' : value.observationLimit.stopReason ? '本次读取已结束' : '限额内读取中'}</p>}
		<p>RPC 发起 {value.started} · 工具 {value.byKind.tool.started} · 元数据 {value.byKind.metadata.started} · 资源 {value.byKind.resource.started}<br />RPC 回包 {value.responses} · RPC 错误 {value.rpcErrors} · 中止 {value.aborted}<br />本地在途 {value.pending} / {value.pendingCapacity} · 峰值 {value.peakPending}</p>
		<table><thead><tr><th>往返耗时（毫秒）</th><th>平均</th><th>P95</th><th>最大</th></tr></thead><tbody>{rows.map(([label, timing]) => <tr key={label}><td>{label}</td><td>{fmt(timing?.meanMs, 2)}</td><td>{fmt(timing?.p95Ms, 2)}</td><td>{fmt(timing?.maxMs, 2)}</td></tr>)}</tbody></table>
		<p>最近 {value.sampleCount} / {value.sampleCapacity} 个结束请求 · 窗口 {fmt(value.windowDurationMs === null ? null : value.windowDurationMs / 1000, 2)} 秒<br />往返回包样本 {value.roundTripSampleCount}（工具 {value.byKind.tool.roundTripSampleCount}）<br />{lifetime.basis === "launch_request" ? "启动请求" : "客户端接入"}后计时 {fmt(lifetime.durationMs / 1000, 3)} 秒</p>
		<details><summary>测量范围</summary><p className="muted">本连接的单调时钟测量，往返包含本地传输和服务处理。计数在发起时累计，回包与工具、游戏动作成功分别记录。最近128个结束请求构成窗口；往返仅统计收到RPC结果或错误的样本，中止另计。子进程退出事件冻结生命周期计时，重连建立新计数。界面快照读取沿用现有通道。</p><p>重复回包 {value.duplicateReplies} · 接口或参数拒绝 {value.rejectedBeforeAdmission}</p></details>
	</section>;
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
export function MechaPanel() {
	const c = useBridge(), observation = c.state.observation, value = observation?.mecha, data = value?.data, enabled = observation?.mechaEnabled === true;
	const capable = c.state.metadata?.readTools.includes("spherewright_get_player_state") === true;
	const movements: Record<string, string> = { Walk: "地面移动", Fly: "飞行", Sail: "航行" };
	return <div className="panel bridge-panel" aria-label="机甲状态"><div className="eyebrow">MECHA</div><h2>机甲状态</h2>
		<button disabled={!observation?.connected || c.state.busy || !capable} onClick={() => void c.act("mecha", { enabled: !enabled })}>{enabled ? "暂停机甲观测" : "开始机甲观测"}</button>
		{!enabled && <p className="muted">{data ? "机甲观测已暂停，以下为保留记录。" : "机甲观测尚未开启。"}启用后沿用当前连接。</p>}{!capable && <p className="muted">当前服务未提供兼容的机甲只读接口。</p>}
		{c.notice && <p role="status" className="notice">{c.notice}</p>}{(enabled || data) && <DataState value={value} />}
		{data && <><p>本地星球 #{data.planetId} · tick {fmt(data.capturedAtGameTick, 0)}<br />移动：{movements[data.movementState ?? ""] ?? data.movementState ?? "—"} · 速度 {fmt(data.speedMetresPerSecond)} m/s<br />位置：{["x", "y", "z"].map(axis => `${axis} ${fmt(data.position[axis], 2)}`).join(" · ")}<br />存活 {yesNo(data.isAlive)} · 在星球上 {yesNo(data.isOnPlanet)} · 飞行 {yesNo(data.isFlying)} · 航行 {yesNo(data.isSailing)}</p>
			<h3>核心与燃料</h3><p>核心电量 {fmt(data.coreEnergyFraction === null ? null : data.coreEnergyFraction * 100)}%<br />反应堆燃料：{data.reactorItemName || (data.reactorItemId === 0 ? "空" : data.reactorItemId ? `#${data.reactorItemId}` : "—")} · 自动补充 {yesNo(data.autoReplenishFuel)}</p>
			{data.fuelStorage === null ? <p>储备燃料未提供。</p> : data.fuelStorage.length === 0 ? <p>储备燃料为空。</p> : <div className="table-scroll"><table><thead><tr><th>储备燃料</th><th>件数</th><th>槽位</th></tr></thead><tbody>{data.fuelStorage.map((item, index) => <tr key={index}><td>{item.name || (item.itemId === null ? "—" : `#${item.itemId}`)}</td><td>{fmt(item.count, 0)}</td><td>{fmt(item.slotCount, 0)}</td></tr>)}</tbody></table></div>}
			<h3>施工无人机</h3><p>总数 {fmt(data.constructionDrones.total, 0)} · 存活 {fmt(data.constructionDrones.alive, 0)} · 空闲 {fmt(data.constructionDrones.idle, 0)} · 工作中 {fmt(data.constructionDrones.working, 0)}<br />待施工目标 {fmt(data.constructionDrones.pendingBuildTargets, 0)} · 待修复目标 {fmt(data.constructionDrones.pendingRepairTargets, 0)}</p><p className="muted">工作中无人机数量不等于未完成建筑数。</p>
			<h3>手工队列</h3>{data.handcraftQueue === null ? <p>队列未提供。</p> : data.handcraftQueue.length === 0 ? <p>队列为空。</p> : <div className="table-scroll"><table><thead><tr><th>配方</th><th>剩余次数</th><th>当前进度</th></tr></thead><tbody>{data.handcraftQueue.map((task, index) => <tr key={index}><td>{task.recipeName || (task.recipeId === null ? "—" : `#${task.recipeId}`)}</td><td>{fmt(task.remainingCraftCount, 0)}</td><td>{fmt(task.progress, 0)} / {fmt(task.progressRequired, 0)}</td></tr>)}</tbody></table></div>}
		</>}
		<p className="muted">仅观察当前本地星球的机甲快照。此面板不提交移动、补料或施工动作。</p>
	</div>;
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
