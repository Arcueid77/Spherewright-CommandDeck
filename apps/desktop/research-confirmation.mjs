import { normalizeResearchBudget, researchCountLimit } from "./research-preview.mjs";

// Runs in the trusted UI main process. Renderer arguments supply only taskId.
export async function confirmResearchFromUi({ taskId, request, showDialog, hideViewport, overlay }) {
	const challenge = await request("game-confirmation", { taskId });
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
