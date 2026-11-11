export type GameGoal = {
	experience?: { source: { revision: string }; lessonIds: string[] };
	activityProgress?: { idleDecisions: number; feedback: { message: string } | null };
	title: string;
	revision: number;
	status: string;
	active: boolean;
	deadlineAt: number;
	objective: { kind: "evidence" | "production"; itemId?: number; minimumPerMinute?: number; windowSeconds?: number };
	stage: { title: string; status: string } | null;
	reason: string | null;
	nextStep: string | null;
	problem: string | null;
	wait: { reason: string; deadlineAt: number } | null;
	completionChecks: { label: string; tool: string; path: string; operator: string; value: string | number | boolean }[];
	observations: { label: string; passed: boolean; available: boolean; actual: string | number | boolean | null; observedAt: number }[];
	verification: { state: string; stale: boolean; seconds: number; latestRate: number | null; minimumRate: number | null; ageMs: number; startTick: number | null; endTick: number | null } | null;
	behavior: { state: string; label: string; actionId: string | null; terminal: Record<string, unknown> | null };
	limits: { modelRequests: number; toolCalls: number; writes: number; durationMs: number };
	usage: { modelRequests: number; toolCalls: number; writes: number };
};

const statuses: Record<string, string> = { running: "推进中", waiting: "等待条件", verifying: "核验目标", blocked: "需要处理", paused: "已暂停", ready: "等待验收", completed: "目标已达成" };
const behaviors: Record<string, string> = { deciding: "选择下一步", observing: "读取现场", planned: "计划中", preparing: "原生预检中", waiting: "等待中", executing: "执行中", submitting: "等待提交回执", reconciling: "核销原动作", verified: "原动作已核对", failed: "原动作已失败", idle: "当前无在途动作" };
const actions: Record<string, string> = { handcraft: "手工制造", build: "建设设施", move: "移动", "select-research": "科研入队", "new-game": "创建世界", save: "正常保存" };
const problems: Record<string, string> = {
	GAME_GOAL_NO_PROGRESS: "连续决策没有观察到进展，请核对缺口或调整目标。",
	GAME_GOAL_REPEATED_FAILURE: "相同操作连续失败，已停止后续调度。",
	GAME_GOAL_DECISION_ENDED: "本轮已停止，目标和原动作记录已保存。",
	GAME_MODEL_REQUEST_LIMIT: "模型请求额度已用完。",
	GAME_MCP_SESSION_STOPPED: "本轮时间或执行额度已结束。",
};

type Props = { goal: GameGoal; connected: boolean; canConfirm: boolean; canContinue: boolean; onConfirm: () => void; onPause: () => void; onContinue: () => void };

export function GameGoalPanel({ goal, connected, canConfirm, canContinue, onConfirm, onPause, onContinue }: Props) {
	const measurement = goal.verification;
	const resumable = !goal.active && goal.status !== "completed" && goal.deadlineAt > Date.now() && goal.usage.modelRequests < goal.limits.modelRequests && goal.usage.toolCalls < goal.limits.toolCalls && goal.usage.writes < goal.limits.writes;
	let rateText = "产率待测量";
	if (measurement?.latestRate !== null && measurement?.latestRate !== undefined) rateText = `最近实测 ${measurement.latestRate}/分钟 · 连续覆盖 ${Math.floor(measurement.seconds)}/${goal.objective.windowSeconds} 游戏秒`;
	if (measurement?.stale || !connected) rateText = "观测已过期，等待重新核验";
	if (goal.status === "completed" && measurement?.state === "verified") rateText = `已核验 ${Math.floor(measurement.seconds)} 游戏秒，窗口最低 ${measurement.minimumRate}/分钟`;
	return <section className="game-goal" aria-label="当前目标与行为">
		<div className="game-goal-heading"><h3>当前目标</h3><span role="status">{statuses[goal.status] ?? goal.status}</span></div>
		<p className="game-goal-title">{goal.title}</p>
		<dl>
			<dt>当前阶段</dt><dd>{goal.stage?.title ?? "观察现场，制定计划"}</dd>
			<dt>当前行为</dt><dd>{behaviors[goal.behavior.state] ?? goal.behavior.state}{goal.behavior.actionId ? ` · ${actions[goal.behavior.label] ?? goal.behavior.label}` : ""}</dd>
			{goal.reason && <><dt>行为原因</dt><dd>{goal.reason}</dd></>}
			{goal.nextStep && goal.status !== "completed" && <><dt>下一步</dt><dd>{goal.nextStep}</dd></>}
			{goal.wait && <><dt>等待条件</dt><dd>{goal.wait.reason}</dd></>}
			{goal.experience && <><dt>经验来源</dt><dd>Spherewright-Lab @{goal.experience.source.revision.slice(0, 8)} · 已载入 {goal.experience.lessonIds.length} 条</dd></>}
		</dl>
		{goal.activityProgress?.feedback && <p className="notice">{goal.activityProgress.feedback.message}</p>}
		{goal.objective.kind === "production" && <div className="game-goal-measurement" aria-label="产量验收">
			<b>持续产量验收</b>
			<p>目标 {goal.objective.minimumPerMinute}/分钟，持续 {goal.objective.windowSeconds} 游戏秒</p>
			<p>{rateText}</p>
			{measurement?.startTick !== null && measurement?.startTick !== undefined && <small>观测 tick {measurement.startTick}–{measurement.endTick} · {Math.floor(measurement.ageMs / 1000)} 秒前收到</small>}
		</div>}
		{goal.problem && <p className="notice">{problems[goal.problem] ?? "任务已停止推进，请结合原动作与验收记录核对。"}<small>{goal.problem}</small></p>}
		<p className="muted">已用模型请求 {goal.usage.modelRequests}/{goal.limits.modelRequests} · 游戏工具 {goal.usage.toolCalls}/{goal.limits.toolCalls} · 提交 {goal.usage.writes}/{goal.limits.writes}</p>
		<div className="actions">
			{canConfirm && <button className="accent" disabled={!connected} onClick={onConfirm}>核对并确认本次操作</button>}
			{goal.active && <button disabled={!connected} onClick={onPause}>暂停后续 / 请求接手</button>}
			{resumable && <button disabled={!connected || !canContinue} onClick={onContinue}>继续或调整此目标</button>}
		</div>
		<details className="game-goal-evidence"><summary>验收条件与原动作</summary>
			{goal.completionChecks.length ? <ul>{goal.completionChecks.map(check => {
				const observed = goal.observations.find(value => value.label === check.label);
				const status = !observed ? "待观察" : observed.passed ? "已满足" : observed.available ? "尚未满足" : "数据待核对";
				return <li key={check.label}><b>{check.label}</b> · {status}<small>{check.tool} · {check.path} {check.operator} {String(check.value)}{observed?.available ? ` · 实际 ${String(observed.actual)}` : ""}</small></li>;
			})}</ul> : <p>Agent 正在根据现场明确验收条件。</p>}
			{goal.behavior.terminal && <pre>{JSON.stringify(goal.behavior.terminal, null, 2)}</pre>}
			{goal.behavior.actionId && <small>原动作 {goal.behavior.actionId}</small>}
		</details>
	</section>;
}
