import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useBridge } from "./bridge";
import { profileToken, type Profile } from "./providers";

type Intent = { intentId: string; taskId: string; state: string; actionId: string | null; terminal: { beforeQueue: number[]; afterQueue: number[]; freshQueue: number[]; completedAtGameTick: number } | null };
type Task = { id: string; state: string; expiresAt: number | null; scope: { techId: number; planetId: number; capturedAtGameTick: number }; details: { mode?: string; techName?: string; provider?: string; model?: string }; intent: Intent | null };
type GameState = { busy: boolean; phase: string; currentTaskId: string | null; error: string | null; developmentFrozen: boolean; unresolved: Intent[]; tasks: Task[]; events: { sequence: number; kind: string; text: string; name: string; code: string | null }[]; syntheticOnly?: boolean; catalog?: { id: string; planetId: number; capturedAtGameTick: number; expiresAt: number; truncated: boolean; items: { techId: number; name: string; prerequisitesObservedComplete: boolean }[] } | null };
type Context = { state: GameState; profiles: Profile[]; healthy: boolean; busy: boolean; notice: string; act: (action: string, args?: Record<string, unknown>) => Promise<void>; confirm: (taskId: string) => Promise<void> };
const Context = createContext<Context>(null!);
const phases: Record<string, string> = { idle: "等待任务", reading_catalog: "读取科研列表", catalog_ready: "科研列表已读取", observing: "读取现场", planning: "Agent 正在分析", preparing: "原生预检中", awaiting_approval: "等待你确认", confirming: "核对确认与现场", accepted: "游戏已受理", reconciling: "核对原动作", completed: "队列变化已核对", advised: "只读建议已完成", blocked: "等待核销", failed: "本次未完成", cancelled: "后续执行已停止" };
const errors: Record<string, string> = { OWNED_RESEARCH_WORLD_REQUIRED: "请先连接已载入的 Spherewright 自有世界。", HEALTHY_RESEARCH_WRITES_REQUIRED: "当前世界没有开放正常写入，请先处理游戏侧阻断。", RESEARCH_BRIDGE_UNAVAILABLE: "当前连接没有提供兼容的有限研究接口。", RESEARCH_TARGET_NOT_ELIGIBLE: "指定科技不存在、已经解锁或已在队列中，请核对目标。", RESEARCH_SELECTION_CHANGED: "科研队列已变化，本次预检停止，请重新核对目标。", COMMIT_RECEIPT_UNAVAILABLE: "提交回执丢失。保留原任务，禁止再次提交。", UNKNOWN_COMMIT_HAS_NO_ACTION_ID: "没有取得原动作编号，需独立核销，不能重试。", INDEPENDENT_GAME_AUDIT_REQUIRED: "游戏报告了需要独立核销的结果，后续写入已冻结。", UNRESOLVED_GAME_INTENT_BLOCKS_WRITES: "先核销已有游戏任务，才能继续。", GAME_RUNTIME_RESPONSE_TIMEOUT: "Agent 未在时限内结束，运行状态需先核对。", GAME_EXECUTION_OWNS_RUNTIME: "游戏任务正在占用运行环境。" };

export function GameTasksProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<GameState>({ busy: false, phase: "idle", currentTaskId: null, error: null, developmentFrozen: false, unresolved: [], tasks: [], events: [] }), [profiles, setProfiles] = useState<Profile[]>([]), [healthy, setHealthy] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	const generation = useRef(0), pending = useRef(false), mutating = useRef(false), stopped = useRef(false);
	async function refresh() { if (pending.current || mutating.current || stopped.current) return; pending.current = true; const expected = generation.current; try { const value = await window.deck.game<GameState>("snapshot"); if (!stopped.current && expected === generation.current) { setState(value); setHealthy(true); } } catch { if (expected === generation.current) setHealthy(false); } finally { pending.current = false; } }
	async function models() { try { const value = await window.deck.profiles(); if (!stopped.current) setProfiles(value); } catch {} }
	useEffect(() => { void refresh(); void models(); const timer = setInterval(() => void refresh(), 1000), unsubscribe = window.deck.onEvent((event) => { if (event.type === "supervisor-disconnected") { stopped.current = true; setHealthy(false); } else if (event.type === "game-changed") void refresh(); else if (event.type === "profiles-changed") void models(); }); return () => { clearInterval(timer); unsubscribe(); }; }, []);
	async function run(operation: () => Promise<unknown>) {
		if (mutating.current || stopped.current) return; mutating.current = true; generation.current++; setBusy(true); setNotice("");
		try { const value = await operation(); if (!stopped.current && value && typeof value === "object" && "phase" in value) setState(value as GameState); }
		catch { setNotice("本次操作未完成。请核对任务状态；存在未决动作时先核销原动作。"); }
		finally { generation.current++; mutating.current = false; setBusy(false); }
		await refresh();
	}
	return <Context.Provider value={{ state, profiles, healthy, busy, notice, act: (action, args = {}) => run(() => window.deck.game(action, args)), confirm: (taskId) => run(() => window.deck.confirmResearch(taskId)) }}>{children}</Context.Provider>;
}

export function GameTasksPanel() {
	const c = useContext(Context), bridge = useBridge().state, state = c.state;
	const [model, setModel] = useState(""), [mode, setMode] = useState("assist"), [tech, setTech] = useState(""), [prompt, setPrompt] = useState("分析这项科技是否适合现在加入科研队列，并说明原因。");
	const profile = c.profiles.find((value) => profileToken(value) === model), task = state.tasks.find((value) => value.id === state.currentTaskId) ?? state.tasks[0];
	const locked = state.busy || state.developmentFrozen || state.unresolved.length > 0;
	const observedSession = bridge.observation?.session;
	const ready = c.healthy && bridge.metadata?.researchAvailable && bridge.observation?.connected && observedSession?.state === "observed" && observedSession.data?.gameLoaded && observedSession.data.owned && !observedSession.data.accessRestricted;
	const expired = task?.expiresAt !== null && task?.expiresAt !== undefined && task.expiresAt <= Date.now();
	const catalogFresh = state.catalog && state.catalog.expiresAt > Date.now();
	return <div className="panel game-tasks-panel"><div className="eyebrow">BOUNDED GAME TASK</div><h2>游戏 Agent</h2><p>先从一项指定科技开始：Agent 读取科研状态并提出建议，你确认后正常入队，随后核对原动作和队列。</p>
		{state.syntheticOnly && <p className="notice">合成验收 · NO DSP · 只操作替身</p>}
		<details className="game-task-settings" open={!task}><summary>{task ? "新任务设置" : "本次任务设置"}</summary><form onSubmit={(event) => { event.preventDefault(); if (profile && catalogFresh) void c.act("start", { mode, techId: Number(tech), catalogId: state.catalog!.id, prompt, providerId: profile.providerId, modelId: profile.modelId }); }}>
			<fieldset disabled={!c.healthy || c.busy || locked}><label>运行方式<select aria-label="游戏任务模式" value={mode} onChange={(event) => setMode(event.target.value)}><option value="observe">观察与建议</option><option value="assist">协助执行 · 每项确认</option><option disabled value="autonomous">有界自主 · 待输入协调验收</option></select></label>
			<label>模型<select aria-label="游戏 Agent 模型" value={model} onChange={(event) => setModel(event.target.value)} required><option value="">请选择已配置模型</option>{c.profiles.map((value) => <option key={profileToken(value)} value={profileToken(value)}>{value.label || value.providerId} · {value.modelId}</option>)}</select></label>
			<label>目标科技<select aria-label="目标科技" required value={tech} onChange={(event) => setTech(event.target.value)} disabled={!catalogFresh}><option value="">{catalogFresh ? "请选择现场观察到的科技" : "先读取当前世界的科研列表"}</option>{state.catalog?.items.map((value) => <option key={value.techId} value={value.techId}>{value.name || `科技 #${value.techId}`}{value.prerequisitesObservedComplete ? "" : " · 前置待核对"}</option>)}</select></label><button type="button" disabled={!ready} onClick={() => void c.act("catalog")}>{state.catalog ? "刷新科研列表" : "读取科研列表"}</button>{state.catalog?.truncated && <p className="muted">当前仅列出前512项；未列出不代表不存在。</p>}
			<label>本次目标<textarea aria-label="游戏任务目标" maxLength={2000} rows={3} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
			<button className="accent" disabled={!ready || !catalogFresh || !profile || !state.catalog?.items.some((value) => value.techId === Number(tech))}>开始分析</button></fieldset>
		</form>
		{!ready && <p className="muted">请在“只读舰桥”连接兼容服务，并在游戏中准备可操作的 Spherewright 自有世界。</p>}</details>
		<div className="game-task-stage" role="status">{phases[state.phase] ?? state.phase}{state.developmentFrozen ? " · 开发写入与构建已冻结" : ""}</div>
		{!c.healthy && <p className="notice">控制连接尚未确认。原任务不视为已停止，恢复连接后先核对状态。</p>}
		{state.error && <p className="notice">{errors[state.error] ?? "本次任务未能完成，原因保留在下方记录。"}<small>{state.error}</small></p>}
		{c.notice && <p className="notice">{c.notice}</p>}
		{state.phase === "idle" && task && ["preparing", "awaiting_approval", "approved"].includes(task.state) && <p className="muted">上次预检已失效，请重新分析；旧票据和确认不会恢复。</p>}
		{task && <><h3>{task.details.techName || "指定科技"} #{task.scope.techId}</h3><p className="data-scope">星球 #{task.scope.planetId} · 初次观察 tick {task.scope.capturedAtGameTick}<br />{task.details.model} · {task.details.mode === "observe" ? "只读建议" : "最多一次正常入队"}</p>
			<div className="actions"><button className="accent" disabled={!c.healthy || c.busy || state.busy || state.phase !== "awaiting_approval" || expired} onClick={() => void c.confirm(task.id)}>核对并确认入队</button>{state.phase === "awaiting_approval" && <button disabled={!c.healthy || c.busy || state.busy} onClick={() => void c.act("reprepare")}>{expired ? "预检已过期 · 重新预检" : "重新预检"}</button>}<button disabled={!c.healthy || c.busy || !locked} onClick={() => void c.act("stop")}>停止后续 / 请求接手</button></div>
			{task.intent?.terminal && <div className="game-task-receipt"><b>队列变化已核对</b><p>之前：{task.intent.terminal.beforeQueue.map((id) => `#${id}`).join(" → ") || "空"}<br />之后：{task.intent.terminal.afterQueue.map((id) => `#${id}`).join(" → ")}<br />终态 tick {task.intent.terminal.completedAtGameTick}</p><p className="muted">这证明正常入队与读回，科技研究完成需继续观察。</p></div>}
		</>}
		{state.unresolved.map((intent) => <div className="game-task-receipt" key={intent.intentId}><b>未决动作：{intent.actionId || "尚无编号"}</b><p>后续写入保持冻结，只查询原动作。</p><button disabled={!c.healthy || c.busy || state.busy || !intent.actionId} onClick={() => void c.act("reconcile", { intentId: intent.intentId })}>核销原动作</button></div>)}
		{state.events.length > 0 && <section className="game-task-transcript" aria-label="Agent 与执行记录"><h3>Agent 与执行记录</h3>{state.events.map((event) => <div key={event.sequence} className={`game-event ${event.kind}`}>{event.kind === "stage" ? phases[event.text] ?? event.text : event.kind === "tool" ? `${event.name} · ${event.text === "started" ? "开始" : "完成"}` : event.code ? errors[event.code] ?? event.code : event.text}</div>)}</section>}
		<p className="muted">游戏输入互斥尚未验收。“停止后续”会冻结新提交，已受理的动作继续核销；窗口焦点变化不表示动作已取消。</p>
		{state.tasks.length > 1 && <details><summary>最近 {state.tasks.length} 项任务</summary>{state.tasks.map((value) => <p key={value.id}>#{value.scope.techId} · {phases[value.state] ?? value.state}</p>)}</details>}
	</div>;
}
