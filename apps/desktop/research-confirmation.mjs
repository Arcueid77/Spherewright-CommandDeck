import { normalizeResearchBudget, researchCountLimit } from "./research-preview.mjs";

// Runs in the trusted UI main process. Renderer arguments supply only taskId.
export async function confirmResearchFromUi({ taskId, request, showDialog, hideViewport, overlay }) {
	const challenge = await request("game-confirmation", { taskId });
	const budget = normalizeResearchBudget(challenge.researchBudget), requirements = budget.length ? budget.map((item) => `${item.name || "物品"} #${item.itemId} × ${item.count === researchCountLimit ? "≥" : ""}${item.count}`).join("\n") : "无材料需求";
	try {
		overlay(true); await hideViewport();
		const answer = await showDialog({ type: "question", title: challenge.syntheticOnly ? "合成验收 · NO DSP · 确认研究入队" : "确认一次研究入队", message: `将 ${challenge.techName || "科技"} #${challenge.techId} 加入科研队列？`, detail: `${challenge.syntheticOnly ? "本次仅连接替身，不操作 DSP。\n\n" : ""}当前 Spherewright 自有世界 · 星球 #${challenge.planetId}\n\n本级科研总需求，后续按游戏正常规则消耗；本次仅入队：\n${requirements}\n\n只追加指定科技，保留其他队列顺序，最多提交一次。本次成功判据仅为队列变化及读回。\n\n游戏输入尚未与 Agent 互斥，请在操作期间避免同时改变科研队列。预检过期会拒绝执行。`, buttons: ["取消", "确认入队"], defaultId: 0, cancelId: 0, noLink: true });
		if (answer.response !== 1) return { cancelled: true };
		return await request("game-confirmed", { nonce: challenge.nonce });
	} finally { overlay(false); }
}
