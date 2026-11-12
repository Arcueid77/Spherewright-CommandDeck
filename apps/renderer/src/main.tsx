import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	DockviewReact,
	type DockviewReadyEvent,
	type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./style.css";
import { WorkbenchProvider, FilesPanel, EditorPanel, DevelopmentPanel, TasksPanel, OutputPanel, persistedLayout, useWorkbenchNavigation, useDevelopmentActiveTask, type Workspace } from "./workbench";
import { ProviderSettings, type Profile } from "./providers";
import { BridgeProvider, ConnectionPanel, ResearchPanel, MechaPanel, ProductionPanel, PowerPanel, LogisticsPanel, useBridge } from "./bridge";
import { GameTasksProvider, GameTasksPanel, GameTaskSummary, useGameTasks } from "./game-tasks";
import { DiagnosticDialog, type DiagnosticOptions, type DiagnosticPreview, type DiagnosticSave } from "./diagnostics";
import { JournalPanel } from "./journal";
import { AgentGatewayPanel } from "./agent-gateway";
import { VideosPanel } from "./videos";
import { RecordingIndicator } from "./recording";
import { UsageSummaryPanel } from "./usage-summary";
import { checkPopoutLayout, configurePopouts, PopoutActions, popoutPage } from "./popouts";

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
	recording?: { phase: string; bytes: number };
	power?: PowerState;
	type: string;
	text?: string;
	tool?: string;
	busy?: boolean;
	result?: ProbeResult;
	taskId?: string;
	kind?: string;
};
type UiSnapshot = {
	power: PowerState;
	layoutMode: "m0" | "development";
	busy: boolean;
	runtimeAvailable: boolean;
	probeText: string;
	lastProbeResult: ProbeResult | null;
	events: RuntimeEvent[];
};
type PowerState = { phase: "ready" | "suspended" | "checking" | "blocked"; generation: number; draining: boolean; error: string | null; canRetry: boolean };
declare global {
	interface Window {
		deck: {
			status(): Promise<NativeState>;
			focusUi(): Promise<unknown>;
			snapshot(): Promise<UiSnapshot>;
			resumeSystem(): Promise<PowerState>;
			journal<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			modelUsage<T = unknown>(): Promise<T>;
			gateway<T = unknown>(action: string): Promise<T>;
			video<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			recording<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			profiles(): Promise<Profile[]>;
			manageProfiles<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			bridge<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			chooseBridge(): Promise<unknown>;
			game<T = unknown>(action: string, args?: Record<string, unknown>): Promise<T>;
			confirmResearch(taskId: string): Promise<unknown>;
			diagnosticPreview(options: DiagnosticOptions): Promise<DiagnosticPreview>;
			saveDiagnosticPreview(id: string): Promise<DiagnosticSave>;
			discardDiagnosticPreview(id: string): Promise<unknown>;
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
	const [runtimeAvailable, setRuntimeAvailable] = useState(false);
	const [output, setOutput] = useState(
		"等待验证。工具仅有 deck_echo，不连接游戏。",
	);
	useEffect(() => {
		void window.deck.snapshot().then((snapshot) => {
			setBusy(snapshot.busy);
			setRuntimeAvailable(snapshot.runtimeAvailable);
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
			if (event.type === "runtime-stopped") setRuntimeAvailable(false);
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
			{!runtimeAvailable && <p className="notice">运行时已停止或尚未就绪。原结果保留，请重新打开工作台后继续。</p>}
			<label>CC Switch / Pi provider</label>
			<select
				value={model}
				onChange={(e) => {
					setModel(e.target.value);
					localStorage.setItem("deck-profile", e.target.value);
				}}
				disabled={busy || !runtimeAvailable}
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
				<button disabled={busy || !runtimeAvailable} onClick={() => void probe("offline")}>
					离线工具验证
				</button>
				<button
					className="accent"
					disabled={busy || !model || !runtimeAvailable}
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
						!node.closest<HTMLElement>("[data-workspace]")?.hidden &&
						props.api.isVisible &&
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
		window.addEventListener("deck-workspace", update);
		document.addEventListener("visibilitychange", update);
		update();
		return () => {
			stateSubscription();
			layout.dispose();
			visibility.dispose();
			observer.disconnect();
			window.removeEventListener("resize", update);
			window.removeEventListener("deck-overlay", update);
			window.removeEventListener("deck-workspace", update);
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
							"窗口连接已建立；游戏任务请在“游戏 Agent”面板单独发起。",
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
				<span>本页 M0 探针的游戏工具</span>
				<strong>不开放</strong>
			</div>
			<div className="metric">
				<span>本页探针工具</span>
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
	journal: JournalPanel,
	"model-usage": UsageSummaryPanel,
	"agent-gateway": AgentGatewayPanel,
	videos: VideosPanel,
	files: FilesPanel, editor: EditorPanel, development: DevelopmentPanel, tasks: TasksPanel, output: OutputPanel,
	bridge: ConnectionPanel, research: ResearchPanel, mecha: MechaPanel, production: ProductionPanel, power: PowerPanel, logistics: LogisticsPanel,
	"game-agent": GameTasksPanel, "game-summary": GameTaskSummary,
};

type DockApi = DockviewReadyEvent["api"];
const workspaceNames: Record<Workspace, string> = { game: "游戏", observation: "观测", development: "开发" };
const panelTitles: Record<string, string> = {
	game: "游戏 / 原生视口", editor: "代码 / 差异", files: "工作区", development: "开发 Agent",
	output: "检查输出", tasks: "任务记录", events: "运行事件", bridge: "连接详情", research: "科研",
	production: "生产", power: "供电", logistics: "物流", mecha: "机甲", "game-summary": "当前游戏任务",
	journal: "运行日记", videos: "录像", "model-usage": "用量汇总", "agent-gateway": "外部 Agent",
	agent: "M0 连接验证", evidence: "能力与证据",
};
function addPanel(api: DockApi, id: string) {
	const existing = api.getPanel(id);
	if (existing) { existing.api.setActive(); return; }
	const reference = api.getPanel("output") ?? api.getPanel("editor") ?? api.getPanel("game") ?? api.panels[0];
	const bottom = ["output", "tasks", "events", "journal", "videos", "model-usage"].includes(id);
	api.addPanel({
		id, component: id, title: panelTitles[id],
		...(reference ? { position: { referencePanel: reference.id, direction: bottom && !api.getPanel("output") ? "below" as const : "within" as const } } : {}),
		...(bottom ? { initialHeight: 240 } : {}),
	});
}
function buildGameLayout(api: DockApi) {
	api.addPanel({ id: "game", component: "game", title: panelTitles.game });
}
function buildObservationLayout(api: DockApi) {
	api.addPanel({ id: "bridge", component: "bridge", title: panelTitles.bridge });
}
function buildDevelopmentLayout(api: DockApi) {
	api.addPanel({ id: "editor", component: "editor", title: panelTitles.editor });
	api.addPanel({ id: "files", component: "files", title: panelTitles.files, position: { referencePanel: "editor", direction: "left" }, initialWidth: 264 });
	api.addPanel({ id: "development", component: "development", title: panelTitles.development, position: { referencePanel: "editor", direction: "right" }, initialWidth: 392 });
}
const builders = { game: buildGameLayout, observation: buildObservationLayout, development: buildDevelopmentLayout };

function App() {
	const bridge = useBridge().state;
	const game = useGameTasks().state;
	const activeDevelopmentTask = useDevelopmentActiveTask();
	const observationOnly = Boolean(bridge.observationPolicy);
	const [power, setPower] = useState<PowerState | null>(null);
	const [workspace, setWorkspace] = useState<Workspace | null>(null);
	const [visited, setVisited] = useState<Workspace[]>([]);
	const [settings, setSettings] = useState(false);
	const [diagnostics, setDiagnostics] = useState(false);
	const [confirmation, setConfirmation] = useState(false);
	const [menu, setMenu] = useState<"panels" | "layout" | "more" | null>(null);
	const [layoutReady, setLayoutReady] = useState<Partial<Record<Workspace, boolean>>>({});
	const [layoutNotice, setLayoutNotice] = useState("");
	const dock = useRef<Partial<Record<Workspace, DockApi>>>({});
	const menuArea = useRef<HTMLDivElement>(null);
	const navigation = useWorkbenchNavigation();
	const blocked = settings || confirmation || diagnostics;
	const ready = workspace !== null && layoutReady[workspace] === true;

	useEffect(() => {
		let active = true, notified = false;
		void window.deck.snapshot().then(value => { if (active && !notified) setPower(value.power); }).catch(() => {});
		const unsubscribe = window.deck.onEvent(event => { if (event.type === "system-power" && event.power) { notified = true; setPower(event.power); } });
		void Promise.all([
			window.deck.workbench<Workspace | null>("ui-get", { key: "workspace" }),
			...(["game", "observation", "development"] as const).map(value => persistedLayout.load(value)),
		]).then(([saved, ...layouts]) => {
			if (!active) return;
			const selected = saved && Object.hasOwn(workspaceNames, saved) ? saved : observationOnly ? "observation" : "game";
			setWorkspace(selected);
			setVisited((["game", "observation", "development"] as const).filter((value, index) => value === selected || (layouts[index]?.popoutGroups as unknown[] | undefined)?.length));
		}).catch(() => { if (active) { setWorkspace("game"); setVisited(["game"]); setLayoutNotice("布局读取未完成，暂用默认显示。"); } });
		return () => { active = false; unsubscribe(); };
	}, []);

	function switchWorkspace(value: Workspace) {
		setMenu(null);
		setVisited(old => old.includes(value) ? old : [...old, value]);
		setWorkspace(value);
		void window.deck.workbench("ui-save", { key: "workspace", value }).catch(() => setLayoutNotice("工作区选择未能保存。"));
	}
	useEffect(() => { window.dispatchEvent(new Event("deck-workspace")); }, [workspace, layoutReady]);
	useEffect(() => {
		const close = (event: PointerEvent) => { if (!menuArea.current?.contains(event.target as Node)) setMenu(null); };
		const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
		document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
		return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
	}, []);
	useEffect(() => window.deck.onEvent(event => { if (event.type === "game-confirmation-state") setConfirmation(event.busy === true); if (event.type === "open-game-agent") switchWorkspace("game"); }), []);
	useEffect(() => {
		if (settings || confirmation || diagnostics || menu) document.body.dataset.deckOverlay = settings ? "settings" : diagnostics ? "diagnostics" : confirmation ? "confirmation" : "menu";
		else delete document.body.dataset.deckOverlay;
		window.dispatchEvent(new Event("deck-overlay"));
	}, [settings, confirmation, diagnostics, menu]);
	useEffect(() => {
		if (!navigation || !layoutReady.development) return;
		const api = dock.current.development;
		if (api) addPanel(api, navigation.panel);
	}, [navigation, layoutReady.development]);
	useEffect(() => {
		if (activeDevelopmentTask && layoutReady.development && dock.current.development) addPanel(dock.current.development, "output");
	}, [activeDevelopmentTask, layoutReady.development]);

	async function initialize(value: Workspace, event: DockviewReadyEvent) {
		const api = event.api;
		dock.current[value] = api;
		const popouts = configurePopouts(api);
		let restored = false;
		try {
			const saved = await persistedLayout.load(value);
			if (saved) {
				api.fromJSON(checkPopoutLayout(saved as unknown as Parameters<typeof api.fromJSON>[0]));
				await api.popoutRestorationPromise;
				restored = true;
			}
		} catch { api.clear(); setLayoutNotice("保存的布局暂时无法恢复，原记录已保留。可从布局菜单恢复默认显示。"); }
		if (!restored) builders[value](api);
		api.onDidLayoutChange(() => {
			if (popouts.canSave()) void persistedLayout.save(value, api.toJSON()).catch(() => setLayoutNotice("布局未能保存，请检查本机存储。"));
		});
		if (value === "development" && activeDevelopmentTask) addPanel(api, "output");
		setLayoutReady(old => ({ ...old, [value]: true }));
	}
	function openPanel(id: string) {
		setMenu(null);
		if (workspace && dock.current[workspace]) addPanel(dock.current[workspace]!, id);
	}
	async function resetLayout() {
		setMenu(null);
		if (!workspace) return;
		const api = dock.current[workspace];
		if (!api) return;
		for (const popout of api.getPopouts()) popout.window.close();
		api.clear();
		builders[workspace](api);
		await persistedLayout.save(workspace, api.toJSON()).catch(() => setLayoutNotice("默认布局未能保存。"));
	}
	const connected = bridge.observation?.connected === true;
	const connectionText = power && power.phase !== "ready" ? "连接待检查" : bridge.error ? "连接需要处理" : connected ? "MCP 已连接" : "游戏未连接";
	const panels = workspace === "development"
		? ["files", "editor", "development", "output", "tasks", "game-summary", "production", "power", "logistics", "events"]
		: workspace === "observation"
			? ["research", "production", "power", "logistics", "mecha", "bridge", "events"]
			: ["bridge", "production", "power", "logistics", "output", "tasks", "events"];
	return <div className="app">
		<header className="app-header" inert={blocked} aria-busy={!ready}>
			<div className="brand">CommandDeck</div>
			<nav className="workspace-navigation" aria-label="工作区">
				{(Object.keys(workspaceNames) as Workspace[]).map(value => <button key={value} data-workspace-button={value} aria-current={workspace === value ? "page" : undefined} onClick={() => switchWorkspace(value)}>{workspaceNames[value]}</button>)}
			</nav>
			<button className={"global-connection" + (connected ? " connected" : "")} onClick={() => switchWorkspace("observation")}><span className={connected ? "dot live" : "dot"} />{connectionText}</button>
			<div className="header-menus" ref={menuArea}>
				{(["panels", "layout", "more"] as const).map(value => <button key={value} data-menu={value} disabled={!ready} aria-haspopup="menu" aria-expanded={menu === value} onClick={() => setMenu(menu === value ? null : value)}>{value === "panels" ? "＋ 面板" : value === "layout" ? "布局" : "更多"}</button>)}
				{menu && <div className="header-menu" role="menu" aria-label={menu === "panels" ? "添加面板" : menu === "layout" ? "布局" : "更多"}>
					{menu === "panels" && panels.map(id => <button key={id} role="menuitem" data-add-panel={id} onClick={() => openPanel(id)}>{panelTitles[id]}</button>)}
					{menu === "layout" && <>
						<button role="menuitem" onClick={() => void resetLayout()}>恢复当前工作区默认布局</button>
						<button role="menuitem" onClick={() => { setMenu(null); for (const api of Object.values(dock.current)) for (const popout of api?.getPopouts() ?? []) popout.window.close(); }}>收回全部浮窗</button>
					</>}
					{menu === "more" && <>
						<div className="menu-group-label">设置</div>
						<button role="menuitem" disabled={observationOnly} onClick={() => { setMenu(null); setSettings(true); }}>模型设置</button>
						<div className="menu-group-label">工具</div>
						<button role="menuitem" onClick={() => { setMenu(null); setDiagnostics(true); }}>诊断报告</button>
						<button role="menuitem" onClick={() => openPanel("model-usage")}>用量汇总</button>
						<button role="menuitem" disabled={observationOnly} onClick={() => openPanel("agent")}>M0 连接验证</button>
						<button role="menuitem" onClick={() => openPanel("evidence")}>能力与证据</button>
						<div className="menu-group-label">历史与媒体</div>
						<button role="menuitem" onClick={() => openPanel("journal")}>运行日记</button>
						<button role="menuitem" onClick={() => openPanel("videos")}>录像</button>
						<div className="menu-group-label">集成</div>
						<button role="menuitem" disabled={observationOnly} onClick={() => openPanel("agent-gateway")}>外部 Agent</button>
					</>}
				</div>}
			</div>
		</header>
		{power && power.phase !== "ready" && <div className="power-notice" role="status" data-system-power={power.phase}>
			<span>{power.phase === "suspended" ? "系统暂停中，新的执行已关闭。" : power.phase === "checking" ? "正在检查唤醒后的连接，执行保持暂停。" : "唤醒检查未完成，执行保持暂停。"} 原任务和回执保留，不会自动重做。</span>
			{power.canRetry && <button onClick={() => void window.deck.resumeSystem().catch(() => {})}>重新检查连接</button>}
		</div>}
		<div className="workspace" inert={blocked}>
			{visited.map(value => <section className={"workspace-surface workspace-" + value} key={value} data-workspace={value} aria-label={workspaceNames[value] + "工作区"} hidden={value !== workspace}>
				<div className="workspace-dock">
					<DockviewReact className="dockview-theme-abyss" dndStrategy="pointer" components={components} popoutUrl={popoutPage} rightHeaderActionsComponent={PopoutActions} onReady={event => void initialize(value, event)} />
				</div>
				{value === "game" && <aside className="current-game-task" aria-label="当前游戏任务"><GameTasksPanel /></aside>}
			</section>)}
		</div>
		<footer className="app-statusbar" role="status">
			<span>{layoutNotice || (workspace === "game" ? game.busy ? "游戏任务进行中" : game.unresolved.length ? "原动作待核销" : "游戏任务就绪" : workspace === "development" ? activeDevelopmentTask ? "开发任务进行中" : "开发工作区就绪" : observationOnly ? "限时只读观测" : "只读观测")}</span>
			<RecordingIndicator />
		</footer>
		{settings && <ProviderSettings close={() => setSettings(false)} />}
		{diagnostics && <DiagnosticDialog close={() => setDiagnostics(false)} />}
	</div>;
}
// Pointer events here belong to the workbench; the native viewport hole bypasses the renderer.
document.addEventListener(
	"pointerdown",
	() => {
		void window.deck.focusUi().catch(() => {});
	},
	{ capture: true },
);
createRoot(document.getElementById("root")!).render(<WorkbenchProvider><BridgeProvider><GameTasksProvider><App /></GameTasksProvider></BridgeProvider></WorkbenchProvider>);
