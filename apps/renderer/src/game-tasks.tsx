import React, { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useBridge } from "./bridge";
import { profileToken, type Profile } from "./providers";
import { ModelUsage, type Usage, type ModelContext } from "./model-usage";
import { GameGoalPanel, canContinueGoal, type GameGoal } from "./game-goal";

type Intent = { intentId: string; taskId: string; state: string; actionId: string | null; terminal: { beforeQueue: number[]; afterQueue: number[]; freshQueue: number[]; completedAtGameTick: number } | null };
type Task = { id: string; state: string; expiresAt: number | null; scope: { kind?: string; actionKind?: string; techId: number; planetId: number; capturedAtGameTick: number }; details: { mode?: string; techName?: string; prompt?: string; provider?: string; model?: string; usage?: Usage; context?: ModelContext }; intent: Intent | null };
type GameState = { busy: boolean; runtimeAvailable: boolean; systemPaused?: boolean; storageAvailable: boolean; phase: string; currentTaskId: string | null; error: string | null; developmentFrozen: boolean; unresolved: Intent[]; tasks: Task[]; goal?: GameGoal | null; events: { sequence: number; kind: string; text: string; name: string; code: string | null }[]; syntheticOnly?: boolean; readOnlyObservation?: boolean; mcp?: { available: boolean; tools: number; families: string[]; awaitingConfirmation: boolean; awaitingAuthorization: boolean; authorized: boolean; expiresAt: number | null; submissions: number }; catalog?: { id: string; planetId: number; capturedAtGameTick: number; expiresAt: number; truncated: boolean; items: { techId: number; name: string; prerequisitesObservedComplete: boolean }[] } | null };
type Context = { state: GameState; profiles: Profile[]; healthy: boolean; busy: boolean; notice: string; act: (action: string, args?: Record<string, unknown>) => Promise<void>; confirm: (taskId: string) => Promise<void> };
const Context = createContext<Context>(null!);
export const useGameTasks = () => useContext(Context);

export function GameTaskSummary() {
	const { state } = useGameTasks();
	const task = state.tasks.find(value => value.id === state.currentTaskId) ?? state.tasks[0];
	return <div className="panel game-task-summary" aria-label="当前游戏任务只读摘要">
		<h2>当前游戏任务</h2>
		<p className="game-goal-title">{state.goal?.title ?? task?.details.prompt ?? "尚无当前任务"}</p>
		<p role="status">{phases[state.phase] ?? "等待核对任务状态"}</p>
		{state.goal?.stage && <p>{state.goal.stage.title}</p>}
		{state.goal?.nextStep && <p>下一步 · {state.goal.nextStep}</p>}
		{state.unresolved.length > 0 && <p className="notice">有 {state.unresolved.length} 项原动作待核销。</p>}
		<p className="muted">只读摘要。任务操作位于游戏工作区。</p>
	</div>;
}
const phases: Record<string, string> = { idle: "等待任务", reading_catalog: "读取科研列表", catalog_ready: "科研列表已读取", observing: "读取现场", planning: "Agent 正在分析", preparing: "原生预检中", awaiting_approval: "等待你确认", confirming: "核对确认与现场", accepted: "游戏已受理", reconciling: "核对原动作", completed: "队列变化已核对", advised: "只读建议已完成", blocked: "等待核销", failed: "本次未完成", cancelled: "后续执行已停止" };
Object.assign(phases, { waiting: "等待现场条件", verifying: "核验目标条件", goal_completed: "目标条件已核对", goal_blocked: "目标暂未完成" });
const errors: Record<string, string> = { GAME_MODEL_OUTPUT_LIMIT: "模型输出达到本轮上限，当前目标暂未完成，请核对原动作与验收记录。", GAME_MODEL_DID_NOT_FINISH: "模型轮次未正常结束，请核对当前目标和原动作记录。", RESEARCH_READBACK_NOT_SUPPORTED: "当前服务尚未提供可验证的科研回执，请更新同批 Spherewright 组件。", RESEARCH_BUDGET_INVALID: "科研材料需求格式不受支持，本次没有提交。", RESEARCH_BUDGET_MISMATCH: "科研材料需求已变化，请重新核对并预检。", OWNED_RESEARCH_WORLD_REQUIRED: "请先连接已载入的 Spherewright 自有世界。", HEALTHY_RESEARCH_WRITES_REQUIRED: "当前世界没有开放正常写入，请先处理游戏侧阻断。", RESEARCH_BRIDGE_UNAVAILABLE: "当前连接没有提供兼容的有限研究接口。", RESEARCH_TARGET_NOT_ELIGIBLE: "指定科技不存在、已经解锁或已在队列中，请核对目标。", RESEARCH_SELECTION_CHANGED: "科研队列已变化，本次预检停止，请重新核对目标。", COMMIT_RECEIPT_UNAVAILABLE: "提交回执丢失。保留原任务，禁止再次提交。", UNKNOWN_COMMIT_HAS_NO_ACTION_ID: "没有取得原动作编号，需独立核销，不能重试。", INDEPENDENT_GAME_AUDIT_REQUIRED: "游戏报告了需要独立核销的结果，后续写入已冻结。", UNRESOLVED_GAME_INTENT_BLOCKS_WRITES: "先核销已有游戏任务，才能继续。", GAME_RUNTIME_RESPONSE_TIMEOUT: "Agent 未在时限内结束，运行状态需先核对。", GAME_EXECUTION_OWNS_RUNTIME: "游戏任务正在占用运行环境。" };

Object.assign(errors, {
	GAME_GOAL_TOOL_LIMIT: "本目标的工具额度已用完，当前目标与原动作记录已保存。",
	GAME_GOAL_REMAINING_BUDGET_REQUIRED: "本轮设置超过原目标的剩余预算或时间，请核对设置。",
	INVALID_GAME_OBJECTIVE: "请核对目标产量和持续游戏时间。",
	GAME_GOAL_PRODUCTION_SCOPE_CHANGED: "产量观察的世界或窗口不一致，请重新核对现场。",
	GAME_LEDGER_STORAGE_UNAVAILABLE: "任务记录无法写入，后续执行已冻结。请保护现有记录，核对存储后重新打开工作台；未决动作不会重做。",
	ORIGINAL_MCP_DISCONNECTED: "游戏服务连接已中断。核销时会重新连接原服务，只核对已有动作。",
	MCP_EXITED: "游戏服务连接已中断。保留原任务，先核销已有动作。",
	ORIGINAL_MCP_RECONNECT_UNAVAILABLE: "原连接状态尚未确认，暂不能重新连接。后续写入保持冻结。",
	ORIGINAL_MCP_COHORT_REQUIRED: "服务版本或接口与原任务不符，不能核销已有动作。",
	MCP_COHORT_CHANGED_RESELECT_REQUIRED: "原服务文件已变化，后续写入保持冻结。",
	MCP_EXIT_NOT_CONFIRMED: "尚未确认原服务退出，暂不启动第二个连接。",
	GAME_CONTEXT_CHANGED: "当前世界或会话与原动作不符，后续写入保持冻结。",
});

export function GameTasksProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<GameState>({ busy: false, runtimeAvailable: false, storageAvailable: false, phase: "idle", currentTaskId: null, error: null, developmentFrozen: false, unresolved: [], tasks: [], events: [] }), [profiles, setProfiles] = useState<Profile[]>([]), [healthy, setHealthy] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	const generation = useRef(0), pending = useRef(false), mutating = useRef(false), stopped = useRef(false);
	async function refresh() { if (pending.current || mutating.current || stopped.current) return; pending.current = true; const expected = generation.current; try { const value = await window.deck.game<GameState>("snapshot"); if (!stopped.current && expected === generation.current) { setState(value); setHealthy(true); } } catch { if (expected === generation.current) setHealthy(false); } finally { pending.current = false; } }
	async function models() { try { const value = await window.deck.profiles(); if (!stopped.current) setProfiles(value); } catch {} }
	useEffect(() => { void refresh(); void models(); const timer = setInterval(() => void refresh(), 1000), unsubscribe = window.deck.onEvent((event) => { if (event.type === "supervisor-disconnected") { stopped.current = true; setHealthy(false); } else if (event.type === "game-changed" || event.type === "system-power") void refresh(); else if (event.type === "profiles-changed") void models(); }); return () => { clearInterval(timer); unsubscribe(); }; }, []);
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
	const formId = useId();
	const [editing, setEditing] = useState(false), [taskKind, setTaskKind] = useState("mcp");
	const [model, setModel] = useState(""), [mode, setMode] = useState("autonomous"), [prompt, setPrompt] = useState("");
	const [writes, setWrites] = useState(128), [minutes, setMinutes] = useState(60), [requests, setRequests] = useState(128), [calls, setCalls] = useState(1024);
	const [families, setFamilies] = useState<string[] | null>(null), [continuous, setContinuous] = useState(true), [acceptance, setAcceptance] = useState("evidence");
	const [itemId, setItemId] = useState(6001), [rate, setRate] = useState(60), [windowSeconds, setWindowSeconds] = useState(60);
	const [continueTaskId, setContinueTaskId] = useState<string | null>(null);
	const [researchModel, setResearchModel] = useState(""), [researchMode, setResearchMode] = useState("assist"), [tech, setTech] = useState("");
	const [researchPrompt, setResearchPrompt] = useState("分析这项科技是否适合现在加入科研队列，并说明原因。");
	const task = state.tasks.find(value => value.id === state.currentTaskId) ?? state.tasks[0];
	const generic = task?.scope.kind === "mcp-session" || task?.scope.kind === "mcp-action";
	const profile = c.profiles.find(value => profileToken(value) === model);
	const researchProfile = c.profiles.find(value => profileToken(value) === researchModel);
	const allowedFamilies = families ?? state.mcp?.families ?? [];
	const locked = !c.healthy || state.systemPaused || !state.runtimeAvailable || !state.storageAvailable || state.readOnlyObservation || c.busy || state.busy || state.developmentFrozen || state.unresolved.length > 0;
	const session = bridge.observation?.session;
	const researchReady = c.healthy && !state.systemPaused && state.runtimeAvailable && state.storageAvailable && !state.readOnlyObservation && bridge.metadata?.researchAvailable && bridge.observation?.connected && session?.state === "observed" && session.data?.gameLoaded && session.data.owned && !session.data.accessRestricted;
	const catalogFresh = state.catalog && state.catalog.expiresAt > Date.now();
	const expired = task?.expiresAt !== null && task?.expiresAt !== undefined && task.expiresAt <= Date.now();
	const hasCurrent = Boolean(state.goal || task);
	const showForm = (!hasCurrent || editing) && !state.unresolved.length && !state.busy && !state.goal?.active;
	const phaseText = state.phase === "runtime_unavailable" ? "Agent 运行时已停止" : generic && state.phase === "advised" ? "本轮 Agent 已结束" : phases[state.phase] ?? "任务状态待核对";
	const controlDisabled = !c.healthy || state.systemPaused || c.busy || !state.storageAvailable;
	useEffect(() => { setEditing(false); }, [state.currentTaskId]);

	function editGoal() {
		const goal = state.goal;
		setTaskKind("mcp");
		if (goal && state.currentTaskId && canContinueGoal(goal)) {
			setContinueTaskId(state.currentTaskId); setPrompt(goal.title); setContinuous(true); setAcceptance(goal.objective.kind);
			setItemId(goal.objective.itemId ?? 6001); setRate(goal.objective.minimumPerMinute ?? 60); setWindowSeconds(goal.objective.windowSeconds ?? 60);
			setRequests(goal.limits.modelRequests - goal.usage.modelRequests); setCalls(goal.limits.toolCalls - goal.usage.toolCalls); setWrites(goal.limits.writes - goal.usage.writes);
			setMinutes(Math.max(0.01, Math.floor((goal.deadlineAt - Date.now()) / 60000 * 100) / 100));
			const previous = c.profiles.find(value => value.providerId === task?.details.provider && value.modelId === task?.details.model);
			if (previous) setModel(profileToken(previous));
		} else setContinueTaskId(null);
		setEditing(true);
	}
	function start(event: React.FormEvent) {
		event.preventDefault();
		if (!profile || locked) return;
		const requestedMs = Math.floor(minutes * 60000);
		const durationMs = continueTaskId && state.goal ? Math.min(requestedMs, state.goal.deadlineAt - Date.now()) : requestedMs;
		const objective = acceptance === "production" ? { kind: "production", itemId, minimumPerMinute: rate, windowSeconds } : { kind: "evidence" };
		void c.act("start", {
			kind: "mcp", mode, prompt, providerId: profile.providerId, modelId: profile.modelId,
			limits: { modelRequests: requests, toolCalls: calls, writes: mode === "observe" ? 0 : writes, durationMs },
			...(mode === "autonomous" ? { allowedFamilies } : {}),
			...(continuous && mode !== "observe" ? { objective } : {}),
			...(continueTaskId ? { continueTaskId } : {}),
		});
		setContinueTaskId(null); setEditing(false);
	}
	function startResearch(event: React.FormEvent) {
		event.preventDefault();
		if (!researchProfile || !catalogFresh || locked) return;
		void c.act("start", { mode: researchMode, techId: Number(tech), catalogId: state.catalog!.id, prompt: researchPrompt, providerId: researchProfile.providerId, modelId: researchProfile.modelId });
		setEditing(false);
	}

	let primary: ReactNode;
	const unresolved = state.unresolved[0];
	if (unresolved) primary = <button className="accent" disabled={controlDisabled || state.busy || !unresolved.actionId} onClick={() => void c.act("reconcile", { intentId: unresolved.intentId })}>核销原动作</button>;
	else if (state.mcp?.awaitingConfirmation && !state.mcp.awaitingAuthorization && task) primary = <button className="accent" disabled={controlDisabled || (state.mcp.expiresAt ?? 0) <= Date.now()} onClick={() => void c.confirm(task.id)}>核对并确认本次操作</button>;
	else if (task && !generic && state.phase === "awaiting_approval") primary = expired
		? <button className="accent" disabled={controlDisabled || state.busy} onClick={() => void c.act("reprepare")}>预检已过期 · 重新预检</button>
		: <button className="accent" disabled={controlDisabled || state.busy} onClick={() => void c.confirm(task.id)}>核对并确认入队</button>;
	else if (state.busy || state.goal?.active) primary = <button className="accent" disabled={controlDisabled} onClick={() => void c.act("stop")}>{state.goal?.active ? "暂停后续 / 请求接手" : "停止后续 / 请求接手"}</button>;
	else if (showForm) primary = taskKind === "mcp"
		? <button className="accent" type="submit" form={formId + "-mcp"} disabled={locked || !profile || !prompt.trim() || !state.mcp?.available || mode === "autonomous" && !allowedFamilies.length}>{continueTaskId ? "核对并继续目标" : mode === "autonomous" ? "核对授权并开始" : "开始游戏任务"}</button>
		: <button className="accent" type="submit" form={formId + "-research"} disabled={locked || !researchReady || !catalogFresh || !researchProfile || !state.catalog?.items.some(value => value.techId === Number(tech))}>开始分析</button>;
	else primary = <button className="accent" disabled={controlDisabled || state.readOnlyObservation || !state.runtimeAvailable} onClick={editGoal}>{state.goal && canContinueGoal(state.goal) ? "继续或调整目标" : "新建游戏任务"}</button>;

	return <div className="game-tasks-panel">
		<div className="game-task-scroll">
			{state.syntheticOnly && <p className="notice">合成验收 · NO DSP · 只操作替身</p>}
			{!showForm && state.goal ? <GameGoalPanel goal={state.goal} connected={c.healthy && state.storageAvailable && bridge.observation?.connected === true} /> : <section className="current-task-overview">
				<div className="game-goal-heading"><h2>{showForm ? continueTaskId ? "继续当前目标" : "新建游戏任务" : "当前任务"}</h2><span className="task-status" role="status">{phaseText}</span></div>
				{!showForm && <><p className="game-goal-title">{task?.details.prompt || task?.details.techName || "等待现场反馈"}</p><dl className="game-goal-next"><dt>当前阶段</dt><dd>{phaseText}</dd><dt>下一步</dt><dd>{unresolved ? "先核销原动作" : state.phase === "awaiting_approval" ? "核对预检并确认" : state.busy ? "等待当前回执" : "核对本次结果后开始下一项任务"}</dd></dl></>}
			</section>}
			{unresolved && <div className="game-task-receipt"><b>原动作需要核销</b><p>{unresolved.actionId ? "后续写入保持冻结，核销会核对原版本及世界。" : "提交可能已生效，原动作编号尚未取得。请保留记录并独立核对。"}</p></div>}
			{!c.healthy && <p className="notice">控制连接尚未确认，恢复连接后先核对原任务状态。</p>}
			{c.healthy && !state.runtimeAvailable && <p className="notice">Agent 运行时已停止。请核对原动作与回执后重新打开工作台。</p>}
			{state.error && <p className="notice">{errors[state.error] ?? "本次任务未能完成，请展开执行记录核对原因。"}</p>}
			{c.notice && <p className="notice">{c.notice}</p>}
			{state.developmentFrozen && <p className="muted">开发写入与构建已冻结</p>}
			{state.phase === "idle" && task && ["preparing", "awaiting_approval", "approved"].includes(task.state) && <p className="notice">上次预检已失效，请重新分析。</p>}

			<div className="game-task-editor" hidden={!showForm}>
				<form id={formId + "-mcp"} className="mcp-game-form" onSubmit={start} hidden={taskKind !== "mcp"}>
					<fieldset disabled={locked}>
						<label>游戏目标<textarea aria-label="MCP 游戏任务目标" value={prompt} onChange={event => setPrompt(event.target.value)} required maxLength={2000} rows={3} /></label>
						<label>模型<select aria-label="MCP 游戏 Agent 模型" value={model} onChange={event => setModel(event.target.value)} required><option value="">请选择已配置模型</option>{c.profiles.map(value => <option key={profileToken(value)} value={profileToken(value)}>{value.label || value.providerId} · {value.modelId}</option>)}</select></label>
						<label>运行方式<select aria-label="MCP 游戏任务模式" value={mode} onChange={event => setMode(event.target.value)}><option value="autonomous">自主执行 · 本轮授权</option><option value="observe">观察与建议</option><option value="assist">协助执行 · 每次确认</option></select></label>
						<details className="game-task-settings"><summary>高级设置</summary>
							{mode !== "observe" && <><label className="game-goal-toggle"><input aria-label="按目标持续执行" type="checkbox" checked={continuous} onChange={event => { setContinuous(event.target.checked); setContinueTaskId(null); }} />按目标持续推进</label>
								{continuous && <><label>验收方式<select aria-label="目标验收方式" value={acceptance} onChange={event => setAcceptance(event.target.value)}><option value="evidence">现场条件验收</option><option value="production">持续产量验收</option></select></label>
									{acceptance === "production" && <div className="game-goal-production-fields">
										<label>目标产物<select aria-label="目标产物" value={itemId} onChange={event => setItemId(Number(event.target.value))}>{["电磁矩阵（蓝糖）", "能量矩阵（红糖）", "结构矩阵（黄糖）", "信息矩阵（紫糖）", "引力矩阵（绿糖）", "宇宙矩阵（白糖）"].map((name, index) => <option key={name} value={6001 + index}>{name}</option>)}</select></label>
										<label>每分钟目标产量<input aria-label="目标每分钟产量" type="number" min={1} max={1e9} value={rate} onChange={event => setRate(Number(event.target.value))} /></label>
										<label>持续游戏秒数<input aria-label="产量持续游戏秒数" type="number" min={10} max={3600} value={windowSeconds} onChange={event => setWindowSeconds(Number(event.target.value))} /></label>
									</div>}
								</>}
							</>}
							<label>本轮分钟数<input aria-label="MCP 任务分钟上限" type="number" min={0.01} step={0.01} max={120} value={minutes} onChange={event => setMinutes(Number(event.target.value))} /></label>
							{mode !== "observe" && <label>最多提交次数<input aria-label="MCP 任务提交上限" type="number" min={1} max={256} value={writes} onChange={event => setWrites(Number(event.target.value))} /></label>}
							<label>模型请求上限<input aria-label="MCP 模型请求上限" type="number" min={1} max={256} value={requests} onChange={event => setRequests(Number(event.target.value))} /></label>
							<label>工具调用上限<input aria-label="MCP 工具调用上限" type="number" min={1} max={2048} value={calls} onChange={event => setCalls(Number(event.target.value))} /></label>
							{mode === "autonomous" && (state.mcp?.families ?? []).map(family => <label className="game-goal-toggle" key={family}><input type="checkbox" checked={allowedFamilies.includes(family)} onChange={event => setFamilies(event.target.checked ? [...allowedFamilies, family] : allowedFamilies.filter(value => value !== family))} />{family}{family === "new_game" ? " · 另次确认" : family === "save" ? " · 正常保存当前受管世界" : ""}</label>)}
							<p className="muted">已发现可用工具 {state.mcp?.tools ?? 0} 项</p>
						</details>
					</fieldset>
				</form>
				<div className="game-task-settings research-game-form" hidden={taskKind !== "research"}>
					<form id={formId + "-research"} onSubmit={startResearch}><fieldset disabled={locked}>
						<label>本次目标<textarea aria-label="游戏任务目标" maxLength={2000} rows={3} value={researchPrompt} onChange={event => setResearchPrompt(event.target.value)} /></label>
						<label>模型<select aria-label="游戏 Agent 模型" value={researchModel} onChange={event => setResearchModel(event.target.value)} required><option value="">请选择已配置模型</option>{c.profiles.map(value => <option key={profileToken(value)} value={profileToken(value)}>{value.label || value.providerId} · {value.modelId}</option>)}</select></label>
						<label>运行方式<select aria-label="游戏任务模式" value={researchMode} onChange={event => setResearchMode(event.target.value)}><option value="observe">观察与建议</option><option value="assist">协助执行 · 每项确认</option><option disabled value="autonomous">有界自主 · 待输入协调验收</option></select></label>
						<label>目标科技<select aria-label="目标科技" required value={tech} onChange={event => setTech(event.target.value)} disabled={!catalogFresh}><option value="">{catalogFresh ? "请选择现场观察到的科技" : "先读取当前世界的科研列表"}</option>{state.catalog?.items.map(value => <option key={value.techId} value={value.techId}>{value.name || "科技 #" + value.techId}{value.prerequisitesObservedComplete ? "" : " · 前置待核对"}</option>)}</select></label>
						<button type="button" disabled={!researchReady} onClick={() => void c.act("catalog")}>{state.catalog ? "刷新科研列表" : "读取科研列表"}</button>
						{state.catalog?.truncated && <p className="muted">当前仅列出前512项。</p>}
					</fieldset></form>
					{!researchReady && <p className="muted">请在观测工作区连接兼容服务，并准备可操作的 Spherewright 自有世界。</p>}
				</div>
				<details className="task-kind-options"><summary>其他任务方式</summary><button type="button" className="task-kind-toggle" onClick={() => setTaskKind(taskKind === "mcp" ? "research" : "mcp")}>{taskKind === "mcp" ? "指定科研入队" : "通用游戏任务"}</button></details>
			</div>

			{hasCurrent && <details className="game-task-records"><summary>任务回执与执行记录</summary>
				{state.error && <code>{state.error}</code>}
				{task && <><p className="full-goal-title">{task.details.prompt}</p><p className="data-scope">{task.details.model} · {generic ? task.scope.actionKind || "Spherewright MCP 任务" : "指定科技 #" + task.scope.techId + " · 星球 #" + task.scope.planetId + " · 初次观察 tick " + task.scope.capturedAtGameTick}</p>
					<ModelUsage value={task.details.usage} context={task.details.context} />
				</>}
				{task?.intent?.terminal && <div className="game-task-receipt"><b>队列变化已核对</b><p>之前 · {task.intent.terminal.beforeQueue.map(id => "#" + id).join(" → ") || "空"}<br />之后 · {task.intent.terminal.afterQueue.map(id => "#" + id).join(" → ")}<br />终态 tick {task.intent.terminal.completedAtGameTick}</p><p className="muted">科技研究完成需继续观察。</p></div>}
				{state.unresolved.map(intent => <div className="game-task-receipt" key={intent.intentId}><p>未决动作 {intent.actionId || "尚无编号"}</p><button disabled={controlDisabled || state.busy || !intent.actionId} onClick={() => void c.act("reconcile", { intentId: intent.intentId })}>核销原动作</button></div>)}
				<section className="game-task-transcript" aria-label="Agent 与执行记录">{state.events.filter(event => event.kind !== "usage").map(event => <div key={event.sequence} className={"game-event " + event.kind}>{event.kind === "stage" ? phases[event.text] ?? event.text : event.kind === "tool" ? event.name + " · " + (event.text === "started" ? "开始" : "完成") : event.code ? errors[event.code] ?? event.code : event.text}</div>)}</section>
				<p className="muted">游戏输入互斥尚待实机验收。停止后续会冻结新提交，已受理动作继续核销。</p>
				{state.tasks.length > 1 && <ul>{state.tasks.map(value => <li key={value.id}>{value.scope.kind?.startsWith("mcp-") ? value.scope.actionKind || "MCP 任务" : "#" + value.scope.techId} · {phases[value.state] ?? value.state}<ModelUsage value={value.details.usage} context={value.details.context} /></li>)}</ul>}
			</details>}
		</div>
		<div className="game-task-primary">
			{primary}
			{showForm && hasCurrent && <button type="button" onClick={() => setEditing(false)}>返回当前任务</button>}
			{!showForm && state.phase === "awaiting_approval" && !generic && !expired && <button disabled={controlDisabled || state.busy} onClick={() => void c.act("reprepare")}>重新预检</button>}
			{!showForm && (state.mcp?.awaitingConfirmation || state.phase === "awaiting_approval") && <button disabled={controlDisabled} onClick={() => void c.act("stop")}>停止后续 / 请求接手</button>}
		</div>
	</div>;
}
