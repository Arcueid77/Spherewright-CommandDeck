import React, { useEffect, useState } from "react";

type State = { enabled: boolean; busy: boolean; generation: number; reads: number; rejected: number; activeConnections: number; readOnly: boolean; cachedOnly: boolean; transport: string };
export function AgentGatewayPanel() {
	const [state, setState] = useState<State | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	useEffect(() => {
		let stopped = false, pending = false;
		const refresh = async () => { if (pending || stopped) return; pending = true; try { const value = await window.deck.gateway<State>("snapshot"); if (!stopped) setState(value); } catch { if (!stopped) setNotice("暂时无法读取网关状态。"); } finally { pending = false; } };
		void refresh(); const timer = setInterval(() => void refresh(), 1000); return () => { stopped = true; clearInterval(timer); };
	}, []);
	async function act(action: "start" | "stop" | "copy") {
		setBusy(true); setNotice("");
		try {
			await window.deck.gateway(action);
			setState(await window.deck.gateway<State>("snapshot"));
			if (action === "copy") setNotice("MCP 连接配置已复制。配置含本次临时凭据，只交给信任的本机 Agent。");
		} catch { setNotice("操作未完成，请检查当前网关或系统暂停状态后重试。"); }
		finally { setBusy(false); }
	}
	return <div className="panel" aria-label="外部 Agent 只读网关">
		<div className="eyebrow">EXTERNAL AGENT</div><h2>只读接入</h2>
		<p>让本机外部 Agent 通过 MCP 读取 Deck 已取得的科研、生产、电力与物流数据。数据保留时间、覆盖范围和过期标记；接入不会额外轮询游戏。</p>
		<p>不提供游戏写入、存档操作、文件读取、命令或模型调用。目录路径、存档身份、会话凭据和模型密钥不在共享数据中。</p>
		<p data-gateway-enabled={state?.enabled === true}>{!state ? "正在读取状态" : state.enabled ? "只读网关已开启" : "只读网关已关闭"} · 已读取 {state?.reads ?? 0} 次 · 已拒绝 {state?.rejected ?? 0} 次</p>
		<div className="actions">
			<button disabled={!state || state.enabled || state.busy || busy} onClick={() => void act("start")}>开启只读网关</button>
			<button disabled={!state?.enabled || state.busy || busy} onClick={() => void act("copy")}>复制 MCP 配置</button>
			<button disabled={!state || !state.enabled && !state.busy || busy} onClick={() => void act("stop")}>关闭网关</button>
		</div>
		<p className="muted">开启后复制配置到外部 Agent 的 MCP 设置。只在本次 Deck 运行期间有效；关闭网关、系统暂停或退出 Deck 后失效，需要重新开启并复制新配置。界面重载不会自动停用已开启的网关。</p>
		{notice && <p role="status">{notice}</p>}
	</div>;
}
