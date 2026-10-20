import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	DockviewReact,
	type DockviewReadyEvent,
	type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./style.css";
import { WorkbenchProvider, FilesPanel, EditorPanel, DevelopmentPanel, TasksPanel, OutputPanel, persistedLayout } from "./workbench";
import { ProviderSettings, type Profile } from "./providers";

type Target = { id: string; pid: number; kind: string; title: string };
type NativeState = {
	attached: boolean;
	active?: boolean;
	fault?: string | null;
	kind?: string;
	targetPid?: number;
	nativeParentMatches: boolean;
	gameCalls: number;
};
type ProbeResult = {
	mode: string;
	executed: number;
	active: string[];
	callable: string[];
	gameCalls: number;
	sourceCommit: string;
	text?: string;
};
type RuntimeEvent = {
	type: string;
	text?: string;
	tool?: string;
	busy?: boolean;
	result?: ProbeResult;
	taskId?: string;
	kind?: string;
};
type UiSnapshot = {
	layoutMode: "m0" | "development";
	busy: boolean;
	probeText: string;
	lastProbeResult: ProbeResult | null;
	events: RuntimeEvent[];
};
declare global {
	interface Window {
		deck: {
			status(): Promise<NativeState>;
			focusUi(): Promise<unknown>;
			snapshot(): Promise<UiSnapshot>;
			profiles(): Promise<Profile[]>;
			manageProfiles<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			targets(): Promise<Target[]>;
			attach(id: string): Promise<NativeState>;
			detach(): Promise<unknown>;
			startFixture(): Promise<unknown>;
			viewport(rect: {
				x: number;
				y: number;
				width: number;
				height: number;
				visible: boolean;
			}): Promise<unknown>;
			probe(config: {
				mode: string;
				providerId?: string;
				modelId?: string;
			}): Promise<ProbeResult>;
			abort(): Promise<unknown>;
			workbench<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			addWorkspace(): Promise<{ cancelled?: boolean }>;
			onEvent(callback: (event: RuntimeEvent) => void): () => void;
		};
	}
}

function AgentPanel() {
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [model, setModel] = useState("");
	const [busy, setBusy] = useState(false);
	const [output, setOutput] = useState(
		"等待验证。工具仅有 deck_echo，不连接游戏。",
	);
	useEffect(() => {
		void window.deck.snapshot().then((snapshot) => {
			setBusy(snapshot.busy);
			if (snapshot.lastProbeResult)
				setOutput(
					snapshot.probeText +
						"\n\n" +
						JSON.stringify(snapshot.lastProbeResult, null, 2),
				);
			else if (snapshot.probeText) setOutput(snapshot.probeText);
		});
		void window.deck.profiles().then((items) => {
			items = items.filter((profile) => profile.source !== "protected");
			setProfiles(items);
			let saved: Partial<Profile> = {};
			try {
				saved = JSON.parse(localStorage.getItem("deck-profile") ?? "{}");
			} catch {}
			const preferred = items.find(
				(p) => p.providerId === saved.providerId && p.modelId === saved.modelId,
			);
			if (preferred) setModel(JSON.stringify(preferred));
		});
		return window.deck.onEvent((event) => {
			if (event.type === "probe-state") {
				setBusy(event.busy === true);
				return;
			}
			if (event.type === "probe-result" && event.result) {
				setOutput(
					(text) => text + "\n\n" + JSON.stringify(event.result, null, 2),
				);
				return;
			}
			if (event.text) setOutput((text) => text + event.text);
			else if (event.tool)
				setOutput((text) => `${text}\n${event.type}: ${event.tool}\n`);
		});
	}, []);
	async function probe(mode: string) {
		setBusy(true);
		setOutput(
			mode === "live"
				? "使用所选 Pi 配置进行有限模型验证…\n"
				: "运行本地假服务，零外部模型请求…\n",
		);
		try {
			const result = await window.deck.probe({
				mode,
				...(mode === "live" && model ? (JSON.parse(model) as Profile) : {}),
			});
			const snapshot = await window.deck.snapshot();
			setOutput(`${snapshot.probeText}\n\n${JSON.stringify(result, null, 2)}`);
		} catch {
			setOutput((text) => `${text}\n验证失败或已取消；没有调用游戏。`);
		} finally {
			setBusy(false);
		}
	}
	return (
		<div className="panel agent">
			<div className="eyebrow">PI SOURCE FORK · M0</div>
			<h2>Agent 连接实验</h2>
			<p>保留原生 Pi 会话，明确装配工具与资源。</p>
			<label>CC Switch / Pi provider</label>
			<select
				value={model}
				onChange={(e) => {
					setModel(e.target.value);
					localStorage.setItem("deck-profile", e.target.value);
				}}
				disabled={busy}
			>
				<option value="">选择 provider / model</option>
				{profiles.map((profile) => (
					<option
						key={profile.providerId + profile.modelId}
						value={JSON.stringify(profile)}
					>
						{profile.modelId} · {profile.api}
					</option>
				))}
			</select>
			<div className="actions">
				<button disabled={busy} onClick={() => void probe("offline")}>
					离线工具验证
				</button>
				<button
					className="accent"
					disabled={busy || !model}
					onClick={() => void probe("live")}
				>
					真实模型验证
				</button>
				<button disabled={!busy} onClick={() => void window.deck.abort()}>
					停止模型轮次
				</button>
			</div>
			<pre>{output}</pre>
			<div className="footnote">本连接验证仅允许 deck_echo；开发工具位于独立的开发 Agent 面板。</div>
		</div>
	);
}
function GamePanel(props: IDockviewPanelProps) {
	const area = useRef<HTMLDivElement>(null);
	const [targets, setTargets] = useState<Target[]>([]);
	const [selected, setSelected] = useState("");
	const [state, setState] = useState<NativeState>();
	const [notice, setNotice] = useState(
		"刷新可发现显式启用的游戏窗口适配器，也可启动宿主替身。",
	);
	async function refresh() {
		const items = await window.deck.targets();
		setTargets(items);
		if (!items.some((item) => item.id === selected))
			setSelected(items[0]?.id ?? "");
		setState(await window.deck.status());
	}
	useEffect(() => {
		void refresh();
		const node = area.current;
		if (!node) return;
		const update = () => {
			const rect = node.getBoundingClientRect();
			void window.deck
				.viewport({
					x: Math.max(0, rect.x),
					y: Math.max(0, rect.y),
					width: Math.max(1, rect.width),
					height: Math.max(1, rect.height),
					visible:
						!document.body.dataset.deckOverlay &&
						rect.width > 1 &&
						rect.height > 1 &&
						document.visibilityState === "visible",
				})
				.catch(() => {});
		};
		const layout = props.containerApi.onDidLayoutChange(() =>
			requestAnimationFrame(update),
		);
		const visibility = props.api.onDidVisibilityChange(() =>
			requestAnimationFrame(update),
		);
		const stateSubscription = window.deck.onEvent((event) => {
			if (event.type === "native-state") void refresh();
		});
		const observer = new ResizeObserver(update);
		observer.observe(node);
		window.addEventListener("resize", update);
		window.addEventListener("deck-overlay", update);
		document.addEventListener("visibilitychange", update);
		update();
		return () => {
			stateSubscription();
			layout.dispose();
			visibility.dispose();
			observer.disconnect();
			window.removeEventListener("resize", update);
			window.removeEventListener("deck-overlay", update);
			document.removeEventListener("visibilitychange", update);
			void window.deck.viewport({
				x: 0,
				y: 0,
				width: 1,
				height: 1,
				visible: false,
			});
		};
	}, []);
	async function act(action: () => Promise<unknown>, message: string) {
		try {
			await action();
			setNotice(message);
			await refresh();
		} catch {
			setNotice("操作未通过。请确认窗口状态；未做游戏输入或存档操作。");
		}
	}
	return (
		<div className="game-panel">
			<div className="toolbar">
				<select
					value={selected}
					onChange={(e) => setSelected(e.target.value)}
					disabled={state?.attached}
				>
					{targets.map((target) => (
						<option key={target.id} value={target.id}>
							{target.kind === "dsp" ? "DSP" : "替身"} · {target.title} · PID{" "}
							{target.pid}
						</option>
					))}
				</select>
				<button onClick={() => void refresh()}>刷新窗口</button>
				<button
					className="accent"
					disabled={!selected || state?.attached}
					onClick={() =>
						void act(
							() => window.deck.attach(selected),
							"Deck UI 已嵌入选定宿主；Agent 游戏动作接口尚未接入。",
						)
					}
				>
					嵌入
				</button>
				<button
					disabled={!state?.attached && !state?.active && !state?.fault}
					onClick={() =>
						void act(() => window.deck.detach(), "窗口已正常脱离。")
					}
				>
					还原窗口
				</button>
				<button
					onClick={() =>
						void act(
							() => window.deck.startFixture(),
							"宿主替身已启动，可选择并嵌入。",
						)
					}
				>
					启动宿主替身
				</button>
			</div>
			<div className="viewport" ref={area}>
				{!state?.attached && (
					<div className="viewport-empty">
						<div className="orbit" />
						<div className="eyebrow">NATIVE GAME VIEWPORT</div>
						<h1>原生游戏视口</h1>
						<p>选择已启用窗口适配器的游戏，或使用宿主替身</p>
						<span>M0 开发中 · 真实游戏交互仍待验收</span>
					</div>
				)}
			</div>
			<div className="statusline">
				<span className={state?.nativeParentMatches ? "dot live" : "dot"} />
				{notice}
			</div>
		</div>
	);
}
function EvidencePanel() {
	return (
		<div className="panel">
			<div className="eyebrow">CAPABILITY BOUNDARY</div>
			<h2>M0 验证范围</h2>
			<div className="metric">
				<span>游戏动作接口</span>
				<strong>未接入</strong>
			</div>
			<div className="metric">
				<span>允许的 Agent 工具</span>
				<strong>deck_echo</strong>
			</div>
			<div className="metric">
				<span>Pi 源码基线</span>
				<strong>71023ae</strong>
			</div>
			<h3>分别记录证明</h3>
			<ul>
				<li>本地 fork 构建与真实加载来源</li>
				<li>active / callable 工具集合</li>
				<li>流式参数、取消与会话重开</li>
				<li>原生 parent、尺寸与正常脱离</li>
				<li>真实玩家输入与宿主异常</li>
			</ul>
			<p className="muted">
				离线通过、源码存在和窗口挂接，均不等于实机验收通过。
			</p>
		</div>
	);
}
function EventPanel() {
	const [events, setEvents] = useState<string[]>([
		"工作台就绪 · 未自动发送模型请求或启动游戏",
	]);
	useEffect(
		() =>
			window.deck.onEvent((event) => {
				if (event.type !== "text")
					setEvents((old) => [
						...old.slice(-39),
						`${new Date().toLocaleTimeString()}  ${event.text ?? `${event.type} ${event.tool ?? ""}`}`,
					]);
			}),
		[],
	);
	return (
		<div className="eventlog">
			{events.map((event, index) => (
				<div key={index}>{event}</div>
			))}
		</div>
	);
}
const components = {
	agent: AgentPanel,
	game: GamePanel,
	evidence: EvidencePanel,
	events: EventPanel,
	files: FilesPanel, editor: EditorPanel, development: DevelopmentPanel, tasks: TasksPanel, output: OutputPanel,
};
async function ready(event: DockviewReadyEvent) {
	const api = event.api;
	const snapshot = await window.deck.snapshot();
	if (snapshot.layoutMode === "development") {
		let restored = false;
		try { const saved = await persistedLayout.load(); if (saved) { api.fromJSON(saved as unknown as Parameters<typeof api.fromJSON>[0]); restored = true; } } catch { api.clear(); }
		if (!restored) {
			api.addPanel({ id: "editor", component: "editor", title: "代码 / 差异" });
			api.addPanel({ id: "game", component: "game", title: "游戏 / 原生视口", position: { referencePanel: "editor", direction: "within" }, inactive: true });
			api.addPanel({ id: "files", component: "files", title: "工作区", position: { referencePanel: "editor", direction: "left" }, initialWidth: 280 });
			api.addPanel({ id: "development", component: "development", title: "开发 Agent", position: { referencePanel: "editor", direction: "right" }, initialWidth: 370 });
			api.addPanel({ id: "agent", component: "agent", title: "M0 连接验证", position: { referencePanel: "development", direction: "within" }, inactive: true });
			api.addPanel({ id: "evidence", component: "evidence", title: "能力与证据", position: { referencePanel: "development", direction: "within" }, inactive: true });
			api.addPanel({ id: "output", component: "output", title: "检查输出", position: { referencePanel: "editor", direction: "below" }, initialHeight: 230 });
			api.addPanel({ id: "tasks", component: "tasks", title: "任务记录", position: { referencePanel: "output", direction: "within" }, inactive: true });
			api.addPanel({ id: "events", component: "events", title: "运行事件", position: { referencePanel: "output", direction: "within" }, inactive: true });
		}
		api.onDidLayoutChange(() => { void persistedLayout.save(api.toJSON()).catch(() => {}); });
		return;
	}
	api.addPanel({ id: "game", component: "game", title: "游戏 / 原生视口" });
	api.addPanel({
		id: "agent",
		component: "agent",
		title: "Agent / Pi",
		position: { referencePanel: "game", direction: "left" },
		initialWidth: 350,
	});
	api.addPanel({
		id: "evidence",
		component: "evidence",
		title: "能力与证据",
		position: { referencePanel: "game", direction: "right" },
		initialWidth: 280,
	});
	api.addPanel({
		id: "events",
		component: "events",
		title: "运行事件",
		position: { referencePanel: "game", direction: "below" },
		initialHeight: 160,
	});
}
function App() {
	const [settings, setSettings] = useState(false);
	useEffect(() => { if (settings) document.body.dataset.deckOverlay = "settings"; else delete document.body.dataset.deckOverlay; window.dispatchEvent(new Event("deck-overlay")); }, [settings]);
	return (
		<div className="app">
			<header inert={settings}>
				<div className="brand">
					SPHEREWRIGHT <b>COMMANDDECK</b>
				</div>
				<div className="tag">M1 · 开发工作台</div>
				<button onClick={() => void persistedLayout.save(null).then(() => window.location.reload())}>恢复默认布局</button>
				<button onClick={() => setSettings(true)}>模型设置</button>
				<div className="header-note">游戏动作未接入 · 中央点击暂缓</div>
			</header>
			<div className="workspace" inert={settings}>
				<DockviewReact
					className="dockview-theme-abyss"
					components={components}
					onReady={ready}
				/>
			</div>
			{settings && <ProviderSettings close={() => setSettings(false)} />}
		</div>
	);
}
// Pointer events here belong to the workbench; the native viewport hole bypasses the renderer.
document.addEventListener(
	"pointerdown",
	() => {
		void window.deck.focusUi().catch(() => {});
	},
	{ capture: true },
);
createRoot(document.getElementById("root")!).render(<WorkbenchProvider><App /></WorkbenchProvider>);
