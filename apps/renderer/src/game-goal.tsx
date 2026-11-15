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
	verification: { state: string; stale: boolean; seconds: number; latestRate: number | null; minimumRate: number | null; ageMs: number; startTick: number | null; endTick: number | null; samples?: number; evidenceKind?: string; maximumObservedGapTicks?: number } | null;
	productionAverage?: { state: string; observedAt: number; seconds: number; ratePerMinute?: number } | null;
	behavior: { state: string; label: string; actionId: string | null; terminal: Record<string, unknown> | null };
	limits: { modelRequests: number; toolCalls: number; writes: number; durationMs: number };
	usage: { modelRequests: number; toolCalls: number; writes: number };
	transport?: { workUsed: number; workLimit: number; reconciliationUsed: number; reconciliationLimit: number };
	supplyPlan?: { state: string; observedAt: number; capturedAtGameTick?: number; plannedRatePerMinute?: number; machineCount?: number; machineWorkPowerWatts?: number; power?: { capacityWatts: number; requiredWatts: number; servedWatts: number } | null; remainingChecks?: string[] };
};

const statuses: Record<string, string> = { running: "执行中", waiting: "等待条件", verifying: "核验目标", blocked: "需要处理", paused: "已暂停", ready: "等待验收", completed: "目标已达成" };
const behaviors: Record<string, string> = { deciding: "选择下一步", observing: "读取现场", planned: "计划中", preparing: "原生预检中", waiting: "等待中", executing: "执行中", submitting: "等待提交回执", reconciling: "核销原动作", verified: "原动作已核对", failed: "原动作已失败", idle: "当前无在途动作" };
const actions: Record<string, string> = { handcraft: "手工制造", build: "建设设施", move: "移动", "select-research": "科研入队", "new-game": "创建世界", save: "正常保存" };
const problems: Record<string, string> = {
	GAME_GOAL_NO_PROGRESS: "连续决策没有观察到进展，请核对缺口或调整目标。",
	GAME_GOAL_REPEATED_FAILURE: "相同操作连续失败，已停止后续调度。",
	GAME_GOAL_DECISION_ENDED: "本轮已停止，目标和原动作记录已保存。",
	GAME_MODEL_STOPPED: "Agent 已停止，原目标和回执仍可查看。",
	GAME_MODEL_REQUEST_LIMIT: "模型请求额度已用完。",
	GAME_MCP_SESSION_STOPPED: "本轮时间或执行额度已结束。",
};


export function canContinueGoal(goal: GameGoal) {
	return !goal.active && goal.status !== "completed" && goal.deadlineAt > Date.now()
		&& goal.usage.modelRequests < goal.limits.modelRequests
		&& goal.usage.toolCalls < goal.limits.toolCalls
		&& goal.usage.writes < goal.limits.writes;
}

export type WorldProductionReading = {
	connected: boolean; state: string; ageMs: number | null; windowSeconds: number | null;
	rate: number | null; itemName: string | null; planetName: string | null; matchingPlanet: boolean;
};

export function GameGoalPanel({ goal, connected, worldProduction }: { goal: GameGoal; connected: boolean; worldProduction: WorldProductionReading | null }) {
	const measurement = goal.verification;
	let rateText = "产率待测量";
	if (measurement?.latestRate !== null && measurement?.latestRate !== undefined) rateText = "最近实测 " + measurement.latestRate + "/分钟";
	if (measurement?.stale || !connected) rateText = "观测已过期，等待重新核验";
	if (goal.status === "completed" && measurement?.state === "verified") rateText = measurement.evidenceKind === "sampled-native-10s" ? "采样达标，已采窗口最低 " + measurement.minimumRate + "/分钟" : "历史验收已记录，采样间隔未记录";
	return <section className="game-goal" aria-label="当前目标与行为">
		<div className="game-goal-heading"><h2>当前目标</h2><span className="task-status" role="status">Agent · {statuses[goal.status] ?? "状态待核对"}</span></div>
		<p className="game-goal-title">{goal.title}</p>
		<dl className="game-goal-next">
			<dt>当前阶段</dt><dd>{goal.stage?.title ?? "观察现场，制定计划"}</dd>
			<dt>下一步</dt><dd>{goal.status === "completed" ? "目标已达成，可查看验收记录。" : !goal.active && !canContinueGoal(goal) ? "本轮已结束，可基于原目标开启新一轮。" : goal.nextStep ?? goal.wait?.reason ?? (goal.active ? "等待本轮现场反馈" : "继续或调整目标")}</dd>
		</dl>
		{goal.objective.kind === "production" && <div className="game-goal-measurement" aria-label="原任务产量验收">
			<b>原任务产量采样</b>
			<p>{rateText} · 目标 {goal.objective.minimumPerMinute}/分钟</p>
			<p>采样覆盖 {Math.min(Math.floor(measurement?.seconds ?? 0), goal.objective.windowSeconds ?? 0)}/{goal.objective.windowSeconds} 游戏秒</p>
			<progress max={goal.objective.windowSeconds} value={Math.min(measurement?.seconds ?? 0, goal.objective.windowSeconds ?? 0)} aria-label="产量验收窗口进度" />
			<small>每次为 10 游戏秒窗口；未采样的窗口未逐一核验。</small>
			<p>完整 60 秒平均：{goal.productionAverage?.state === "ready" && goal.productionAverage.ratePerMinute !== undefined ? `${goal.productionAverage.ratePerMinute}/分钟${Date.now() - goal.productionAverage.observedAt > 15000 ? " · 历史读数" : ""}` : "等待无缺口、不重叠的完整窗口"}</p>
		</div>}
		{goal.objective.kind === "production" && <div className="game-goal-measurement" aria-label="当前世界独立观测">
			<b>当前世界 · 独立只读观测</b>
			{!worldProduction?.connected ? <p>观测连接未就绪。</p> : worldProduction.state !== "observed" ? <p>观测数据暂不可用或已过期。</p> : !worldProduction.matchingPlanet ? <p>观测数据未包含目标星球。</p> : worldProduction.rate === null ? <p>当前观测未包含目标产物或生产窗口尚未就绪。</p> : <p>{worldProduction.planetName ?? "观测星球"} · {worldProduction.itemName ?? "目标产物"} {worldProduction.rate}/分钟 · {worldProduction.windowSeconds ?? "—"} 游戏秒窗口{worldProduction.ageMs !== null ? ` · ${Math.floor(worldProduction.ageMs / 1000)} 秒前` : ""}</p>}
			<small>观测连接独立于原任务，不自动修改任务或验收结果。</small>
		</div>}
		{["observed", "stale"].includes(goal.supplyPlan?.state ?? "") && goal.supplyPlan && <div className="game-goal-measurement" aria-label="供给规划草案">
			<b>供给规划 · 理论草案{goal.supplyPlan.state === "stale" || Date.now() - goal.supplyPlan.observedAt > 15000 ? " · 需刷新" : ""}</b>
			<p>按 {goal.supplyPlan.plannedRatePerMinute}/分钟估算 · {goal.supplyPlan.machineCount} 台机器 · 机器工作功率 {goal.supplyPlan.machineWorkPowerWatts === undefined ? "未提供" : (goal.supplyPlan.machineWorkPowerWatts / 1000000).toFixed(2) + " MW"}</p>
			{goal.supplyPlan.power && <p>观测电网容量 {(goal.supplyPlan.power.capacityWatts / 1000000).toFixed(2)} MW · 需求 {(goal.supplyPlan.power.requiredWatts / 1000000).toFixed(2)} MW</p>}
			<small>草案按目标的 120% 计算；位置、物流、供料及实际产量仍需现场核对。</small>
		</div>}
		{goal.problem && <p className="notice">{problems[goal.problem] ?? "任务已停止推进，请核对原动作与验收记录。"}</p>}
		{goal.behavior.terminal?.failureKind === "mecha_power_starved" && <p className="notice">原采集因机甲缺能停止，已核对部分产物。补充燃料后需重新预检，原动作不会重做。</p>}
		<details className="game-goal-evidence"><summary>验收与原动作</summary>
			<p className="full-goal-title">{goal.title}</p>
			<dl>
				<dt>当前行为</dt><dd>{behaviors[goal.behavior.state] ?? "行为待核对"}{goal.behavior.actionId ? " · " + (actions[goal.behavior.label] ?? "原生操作") : ""}</dd>
				{goal.reason && <><dt>行为原因</dt><dd>{goal.reason}</dd></>}
				{goal.nextStep && <><dt>完整下一步</dt><dd>{goal.nextStep}</dd></>}
				{goal.wait && <><dt>等待条件</dt><dd>{goal.wait.reason}</dd></>}
				{goal.experience && <><dt>经验来源</dt><dd>Spherewright-Lab @{goal.experience.source.revision.slice(0, 8)} · 已载入 {goal.experience.lessonIds.length} 条</dd></>}
			</dl>
			{goal.activityProgress?.feedback && <p>{goal.activityProgress.feedback.message}</p>}
			{goal.supplyPlan?.remainingChecks?.length ? <p>规划待核对：{goal.supplyPlan.remainingChecks.join("；")}</p> : null}
			<p>已用模型请求 {goal.usage.modelRequests}/{goal.limits.modelRequests} · 游戏工具 {goal.usage.toolCalls}/{goal.limits.toolCalls} · 提交 {goal.usage.writes}/{goal.limits.writes}</p>
			{goal.transport && <p>本轮游戏服务请求 {goal.transport.workUsed}/{goal.transport.workLimit} · 原动作核销读取 {goal.transport.reconciliationUsed}/{goal.transport.reconciliationLimit}</p>}
			<p className="data-scope">本目标时限 {new Date(goal.deadlineAt).toLocaleString()}</p>
			{measurement && <p>采样覆盖 {Math.floor(measurement.seconds)} 游戏秒 · {measurement.samples ?? 0} 次采样 · 已采窗口最低 {measurement.minimumRate ?? "待测量"}/分钟 · 最大采样间隔 {measurement.maximumObservedGapTicks === undefined ? "未知" : (measurement.maximumObservedGapTicks / 60).toFixed(1) + " 游戏秒"}</p>}
			{measurement?.startTick !== null && measurement?.startTick !== undefined && <p className="data-scope">观测 tick {measurement.startTick}–{measurement.endTick} · {Math.floor(measurement.ageMs / 1000)} 秒前收到</p>}
			{goal.completionChecks.length ? <ul>{goal.completionChecks.map(check => {
				const observed = goal.observations.find(value => value.label === check.label);
				const status = !observed ? "待观察" : observed.passed ? "已满足" : observed.available ? "尚未满足" : "数据待核对";
				return <li key={check.label}><b>{check.label}</b> · {status}<small>{check.tool} · {check.path} {check.operator} {String(check.value)}{observed?.available ? " · 实际 " + String(observed.actual) : ""}</small></li>;
			})}</ul> : <p>Agent 正在根据现场明确验收条件。</p>}
			{goal.behavior.terminal && <pre>{JSON.stringify(goal.behavior.terminal, null, 2)}</pre>}
			{goal.behavior.actionId && <small>原动作 {goal.behavior.actionId}</small>}
			{goal.problem && <code>{goal.problem}</code>}
		</details>
	</section>;
}
