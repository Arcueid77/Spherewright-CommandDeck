import { normalizeResearchBudget, researchCountLimit } from "./research-preview.mjs";

// Runs in the trusted UI main process. Renderer arguments supply only taskId.
export async function confirmResearchFromUi({ taskId, request, showDialog, hideViewport, overlay }) {
	const challenge = await request("game-confirmation", { taskId });
	if (challenge.kind === "mcp-run") {
		try {
			overlay(true); await hideViewport();
			const scope = challenge.context.loaded ? "当前 Spherewright 受管世界" : "当前主菜单；只可在另次确认的新世界中继续";
			const answer = await showDialog({ type: "question", title: challenge.syntheticOnly ? "合成验收 · NO DSP · 授权本轮自主执行" : "授权本轮自主执行", message: challenge.goal, detail: `${challenge.syntheticOnly ? "仅连接替身，不操作 DSP。\n\n" : ""}${scope}\n\n允许的原生操作类型：${challenge.allowedFamilies.join("、")}\n最多${challenge.limits.modelRequests}次模型请求、${challenge.limits.toolCalls}次工具调用、${challenge.limits.writes}次提交，最长${Math.round(challenge.limits.durationMs / 60000)}分钟（包含本次授权等待）。\n\n这些类型内的普通操作${challenge.allowedFamilies.includes("save") ? "及当前受管世界的正常保存" : ""}会连续执行，不逐次询问。新建世界仍需另次核对精确预检；读档、导入、恢复、解除隔离没有获得授权。\n\n程序限制世界、操作类型、次数和时间，目标由 Agent 根据现场解释。结果不明立即停写。玩家输入尚未互斥；接手按钮只停止后续提交，已受理操作继续核销。重开不恢复本轮授权。`, buttons: ["取消", "授权并开始"], defaultId: 0, cancelId: 0, noLink: true });
			if (answer.response !== 1) { await request("game", { action: "stop" }); return { cancelled: true }; }
			return await request("game-confirmed", { nonce: challenge.nonce });
		} finally { overlay(false); }
	}
	if (challenge.kind === "mcp") {
		try {
			overlay(true); await hideViewport();
			const answer = await showDialog({ type: "question", title: challenge.syntheticOnly ? "合成验收 · NO DSP · 确认原生操作" : "确认 Spherewright 原生操作", message: challenge.tool, detail: `${challenge.syntheticOnly ? "仅连接替身，不操作 DSP。\n\n" : ""}本次剩余提交额度：${challenge.remainingWrites}\n预检到期：${challenge.expiresAt}\n\n以下为原生预检及其精确请求。确认只允许这一次提交：\n${JSON.stringify(challenge.preview, null, 2)}\n\n玩家输入尚未互斥。取消或关闭窗口会停止本次提交；已受理动作仍需核销。`, buttons: ["取消", "确认本次操作"], defaultId: 0, cancelId: 0, noLink: true });
			if (answer.response !== 1) { await request("game", { action: "stop" }); return { cancelled: true }; }
			return await request("game-confirmed", { nonce: challenge.nonce });
		} finally { overlay(false); }
	}
	const budget = normalizeResearchBudget(challenge.researchBudget), requirements = budget.length ? budget.map((item) => `${item.name || "物品"} #${item.itemId} × ${item.count === researchCountLimit ? "≥" : ""}${item.count}`).join("\n") : "无材料需求";
	try {
		overlay(true); await hideViewport();
		const answer = await showDialog({ type: "question", title: challenge.syntheticOnly ? "合成验收 · NO DSP · 确认研究入队" : "确认一次研究入队", message: `将 ${challenge.techName || "科技"} #${challenge.techId} 加入科研队列？`, detail: `${challenge.syntheticOnly ? "本次仅连接替身，不操作 DSP。\n\n" : ""}当前 Spherewright 自有世界 · 星球 #${challenge.planetId}\n\n本级科研总需求，后续按游戏正常规则消耗；本次仅入队：\n${requirements}\n\n只追加指定科技，保留其他队列顺序，最多提交一次。本次成功判据仅为队列变化及读回。\n\n游戏输入尚未与 Agent 互斥，请在操作期间避免同时改变科研队列。预检过期会拒绝执行。`, buttons: ["取消", "确认入队"], defaultId: 0, cancelId: 0, noLink: true });
		if (answer.response !== 1) return { cancelled: true };
		return await request("game-confirmed", { nonce: challenge.nonce });
	} finally { overlay(false); }
}

// Called only by the trusted UI main process after its actual Start gesture.
// No model turn begins while the host is preparing this authorization.
export async function startAutonomousGameFromUi({ args, request, confirm, timeoutMs = 45000 }) {
	let state = await request("game", args), taskId = state.currentTaskId;
	const deadline = performance.now() + timeoutMs;
	while (state.busy) {
		if (taskId && state.currentTaskId && taskId !== state.currentTaskId) throw new Error("GAME_AUTHORIZATION_TASK_CHANGED");
		taskId ??= state.currentTaskId;
		if (state.mcp?.awaitingAuthorization && state.currentTaskId) return confirm(state.currentTaskId);
		if (performance.now() >= deadline) { await request("game", { action: "stop" }); throw new Error("GAME_AUTHORIZATION_SETUP_TIMEOUT"); }
		await new Promise(resolve => setTimeout(resolve, 50)); state = await request("game", { action: "snapshot" });
	}
	return state;
}
