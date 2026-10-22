import React, { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DocumentLease } from "./document-state";
import { profileToken, type Profile } from "./providers";

type Root = { id: string; label: string; path: string; canWrite: boolean; canExecute: boolean; metadata: { branch: string | null; sha: string | null; submodule: boolean; dirtyCount: number; protectedCount: number; changes: { path: string; code: string }[] } };
type TaskReference = { id: string; taskId: string; rootId: string; path: string; revision: string; sha256: string; label: string };
type Task = { id: string; rootId: string; prompt: string; response?: string; kind: string; state: string; error?: string; result?: unknown; events?: { sequence: number; kind: string; value: { text?: string; stream?: string } }[]; changes?: { id: string; path: string; state: string; afterHash: string; beforeHash: string | null }[]; references?: TaskReference[] };
type State = { roots: Root[]; tasks: Task[]; activeTask: string | null; executionBlocked: boolean; observationOnly?: boolean };
type Document = { rootId: string; path: string; sha256: string | null; text: string; diskText: string };
type HistoryView = { kind: "change" | "reference"; taskId: string; rootId: string; path: string; text: string; label: string; revision?: string | null; beforeHash?: string | null; afterHash?: string; state?: string };
type Navigation = { panel: "editor" | "output"; sequence: number };
const wb = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.workbench<T>(action, args);
type ContextValue = State & { rootId: string; root?: Root; taskId: string; document: Document | null; history: HistoryView | null; navigation: Navigation | null; notice: string; selectRoot: (id: string) => void; selectTask: (id: string) => void; showTask: (id: string) => void; showChange: (taskId: string, changeId: string) => Promise<void>; showReference: (taskId: string, referenceId: string) => Promise<void>; closeHistory: () => void; refresh: () => Promise<void>; open: (path: string) => Promise<void>; setDocument: (value: Document | null, expected?: Document) => void; report: (error: unknown) => void };
const Context = createContext<ContextValue>(null!);
const useWorkbench = () => useContext(Context);
export const useWorkbenchNavigation = () => useWorkbench().navigation;
const labels: Record<string, string> = { queued: "等待", running: "进行中", cancelling: "正在停止", succeeded: "完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };
const changeLabels: Record<string, string> = { applied: "已写入", reverted: "已撤回", failed: "失败", unknown: "待核对" };
function taskText(task: Task) {
	if (task.response || task.error) return task.response || task.error;
	if (["queued", "running", "cancelling"].includes(task.state)) return "任务进行中，等待输出。";
	if (task.state !== "succeeded") return labels[task.state] ?? task.state;
	if (task.kind === "edit") return "文件已保存。可查看代码差异，或在检查输出中撤回此次修改。";
	if (task.kind === "revert") return "文件修改已撤回。";
	if (task.kind === "check") return "检查已完成，详细结果见检查输出。";
	return "任务已完成。";
}
export function WorkbenchProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<State>({ roots: [], tasks: [], activeTask: null, executionBlocked: false });
	const [rootId, setRootId] = useState(""), [taskId, setTaskId] = useState(""), [document, setDocumentState] = useState<Document | null>(null), [notice, setNotice] = useState("");
	const [history, setHistory] = useState<HistoryView | null>(null), [navigation, setNavigation] = useState<Navigation | null>(null);
	const hydrated = useRef(false), currentDocument = useRef(document);
	const documentLease = useRef(new DocumentLease());
	currentDocument.current = document;
	const report = (error: unknown) => setNotice(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "操作未完成");
	async function refresh() { setState(await wb<State>("state")); }
	function navigate(panel: Navigation["panel"]) { setNavigation(value => ({ panel, sequence: (value?.sequence ?? 0) + 1 })); }
	function showTask(id: string) { setTaskId(id); navigate("output"); }
	function closeHistory() { documentLease.current.changed(); setHistory(null); }
	async function showChange(sourceTaskId: string, changeId: string) {
		const applied = await documentLease.current.load(() => wb<HistoryView & { baseRevision: string | null }>("change-diff", { taskId: sourceTaskId, changeId }), value => { setHistory({ ...value, kind: "change", label: "任务原始差异", revision: value.baseRevision }); navigate("editor"); });
		if (!applied) setNotice("读取期间文档已变化，保留当前草稿。");
	}
	async function showReference(sourceTaskId: string, referenceId: string) {
		const applied = await documentLease.current.load(() => wb<{ taskId: string; rootId: string; path: string; revision: string; fullText: string; label: string; sha256: string }>("read-reference", { taskId: sourceTaskId, referenceId }), value => { setHistory({ ...value, kind: "reference", text: value.fullText, afterHash: value.sha256 }); navigate("editor"); });
		if (!applied) setNotice("读取期间文档已变化，保留当前草稿。");
	}
	function setDocument(value: Document | null, expected?: Document) {
		if (expected && currentDocument.current !== expected) { setNotice("文件已保存，当前打开的文档保持原样。"); return; }
		documentLease.current.changed(); currentDocument.current = value;
		if (!expected) setHistory(null);
		setDocumentState(value);
		void wb("ui-save", { key: "editor", value }).catch(report);
	}
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
		void (async () => {
			const [state, selection, editor] = await Promise.all([wb<State>("state"), wb<{ rootId?: string; taskId?: string } | null>("ui-get", { key: "selection" }), wb<Document | null>("ui-get", { key: "editor" })]);
			if (disposed) return;
			setState(state); setRootId(state.roots.some((root) => root.id === selection?.rootId) ? selection!.rootId! : state.roots[0]?.id ?? "");
			setTaskId(state.tasks.some((task) => task.id === selection?.taskId) ? selection!.taskId! : state.tasks[0]?.id ?? "");
			if (editor && state.roots.some((root) => root.id === editor.rootId)) setDocumentState(editor);
			hydrated.current = true;
		})().catch(report);
		const unsubscribe = window.deck.onEvent((event) => {
			if (event.type !== "workbench") return;
			if (event.kind === "started" && event.taskId) setTaskId(event.taskId);
			if (!timer) timer = setTimeout(() => { timer = undefined; if (!disposed) void refresh().catch(report); }, 250);
		});
		return () => { disposed = true; unsubscribe(); clearTimeout(timer); };
	}, []);
	useEffect(() => { if (hydrated.current) void wb("ui-save", { key: "selection", value: { rootId, taskId } }).catch(report); }, [rootId, taskId]);
	async function open(path: string) {
		const previous = currentDocument.current;
		if (previous && previous.text !== previous.diskText) { setNotice("当前文件有未保存修改，请先保存或放弃修改。"); return; }
		const applied = await documentLease.current.load(() => wb<{ fullText: string; sha256: string }>("read", { rootId, path }), (value) => setDocument({ rootId, path, sha256: value.sha256, text: value.fullText, diskText: value.fullText }));
		setNotice(applied ? "" : "读取期间文档已发生变化，保留当前草稿。");
	}
	return <Context.Provider value={{ ...state, rootId, root: state.roots.find((root) => root.id === rootId), taskId, document, history, navigation, notice, selectRoot: setRootId, selectTask: setTaskId, showTask, showChange, showReference, closeHistory, refresh, open, setDocument, report }}>{children}</Context.Provider>;
}
export function FilesPanel() {
	const c = useWorkbench(), [directory, setDirectory] = useState(""), [entries, setEntries] = useState<{ path: string; name: string; directory: boolean; protected: boolean }[]>([]), [truncated, setTruncated] = useState(false);
	useEffect(() => { setDirectory(""); }, [c.rootId]);
	useEffect(() => {
		let current = true;
		if (!c.rootId) { setEntries([]); return; }
		void wb<{ entries: typeof entries; truncated: boolean }>("list", { rootId: c.rootId, directory }).then((value) => { if (current) { setEntries(value.entries); setTruncated(value.truncated); } }).catch(c.report);
		return () => { current = false; };
	}, [c.rootId, directory, c.activeTask]);
	async function grants(canWrite: boolean, canExecute: boolean) { await wb("grants", { rootId: c.rootId, canWrite, canExecute }); await c.refresh(); }
	return <div className="panel files-panel">
		<div className="eyebrow">DEVELOPMENT WORKSPACE</div>
		<div className="actions"><button disabled={c.observationOnly} onClick={() => void window.deck.addWorkspace().then(c.refresh).catch(c.report)}>添加仓库</button><button disabled={!c.rootId} onClick={() => void wb("refresh", { rootId: c.rootId }).then(c.refresh).catch(c.report)}>刷新</button></div>
		<select aria-label="开发仓库" value={c.rootId} onChange={(event) => c.selectRoot(event.target.value)}><option value="">选择仓库</option>{c.roots.map((root) => <option key={root.id} value={root.id}>{root.label}</option>)}</select>
		{c.root && <>
			<p className="repository-path">{c.root.path}</p><p>{c.root.metadata.branch ?? "固定提交"} · {c.root.metadata.sha?.slice(0, 8) ?? "尚无提交"}<br />{c.root.metadata.dirtyCount} 处改动 · {c.root.metadata.protectedCount} 个路径受保护</p>
			<div className="permissions"><label><input type="checkbox" checked={c.root.canWrite} disabled={Boolean(c.activeTask) || c.root.metadata.submodule || c.observationOnly} onChange={(event) => void grants(event.target.checked, c.root!.canExecute).catch(c.report)} />允许编辑</label><label><input type="checkbox" checked={c.root.canExecute} disabled={Boolean(c.activeTask) || c.root.metadata.submodule || c.observationOnly} onChange={(event) => void grants(c.root!.canWrite, event.target.checked).catch(c.report)} />允许构建与测试</label></div>
			{c.root.metadata.submodule && <p>固定依赖只读。请在独立源码仓中开发。</p>}
			<div className="file-location"><button disabled={!directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>↑</button><span>{directory || "/"}</span></div>
			<div className="file-tree">{entries.map((entry) => <button key={entry.path} title={entry.path} onClick={() => entry.directory ? setDirectory(entry.path) : void c.open(entry.path).catch(c.report)}>{entry.directory ? "▸ " : "  "}{entry.name}{entry.protected ? " · 已有修改" : ""}</button>)}</div>{truncated && <p>当前目录仅显示前 300 项。</p>}
		</>}
		{c.notice && <p role="status" className="notice">{c.notice}</p>}
	</div>;
}
async function waitTask(id: string) {
	while (true) { const task = await wb<Task>("task", { taskId: id }); if (!["queued", "running", "cancelling"].includes(task.state)) return task; await new Promise((done) => setTimeout(done, 200)); }
}
export function EditorPanel() {
	const c = useWorkbench(), [diff, setDiff] = useState<string | null>(null), [newPath, setNewPath] = useState(""), [saving, setSaving] = useState(false);
	const doc = c.document, documentRoot = c.roots.find((root) => root.id === doc?.rootId), large = (doc?.text.length ?? 0) > 120000;
	useEffect(() => { setDiff(null); }, [doc?.rootId, doc?.path]);
	async function save() {
		if (!doc) return;
		setSaving(true);
		try {
		const task = await wb<Task>("save", { rootId: doc.rootId, path: doc.path, expectedSha256: doc.sha256, content: doc.text }); c.selectTask(task.id);
		const result = await waitTask(task.id);
		if (result.state !== "succeeded") throw new Error(result.error ?? "保存未完成");
		const value = await wb<{ fullText: string; sha256: string }>("read", { rootId: doc.rootId, path: doc.path });
		// The button is disabled while saving, so text cannot change under this submitted editor snapshot.
		c.setDocument({ ...doc, text: value.fullText, diskText: value.fullText, sha256: value.sha256 }, doc); await c.refresh();
		} finally { setSaving(false); }
	}
	if (c.history) return <div className="editor-panel history-view" aria-label="历史任务视图"><div className="toolbar"><span className="editor-title">{c.history.label} · {c.roots.find(root => root.id === c.history!.rootId)?.label} / {c.history.path}</span><button onClick={c.closeHistory}>返回当前文件</button></div>
		<div className="statusline">只读 · 原任务 {c.history.taskId.slice(0, 8)}{c.history.revision ? ` · ${c.history.kind === "reference" ? "固定提交" : "起始提交"} ${c.history.revision}` : ""}{c.history.state ? ` · ${changeLabels[c.history.state] ?? c.history.state}` : ""}</div>
		<pre className={`code-diff ${c.history.kind === "reference" ? "history-document" : ""}`} aria-label={c.history.kind === "change" ? "原始任务差异" : "固定版本记录"}>{c.history.text || "此次保存未改变文本。"}</pre>
		<div className="statusline">来源哈希 {c.history.afterHash}{c.history.kind === "reference" ? " · 固定版本文件，引用本身不代表验收通过。" : " · 来自任务保存的前后内容，与当前 Git 差异分别保留。"}</div></div>;
	return <div className="editor-panel">
		<div className="toolbar"><span className="editor-title">{doc ? `${documentRoot?.label ?? "仓库"} / ${doc.path}${doc.text !== doc.diskText ? " ●" : ""}` : "选择一个文件"}</span>
			<button disabled={!doc || !documentRoot?.canWrite || Boolean(c.activeTask) || large || saving || c.observationOnly} onClick={() => void save().catch(c.report)}>保存</button>
			<button disabled={!doc || doc.sha256 === null} onClick={() => doc && void wb<{ text: string }>("diff", { rootId: doc.rootId, path: doc.path }).then((value) => setDiff(value.text || "当前文件没有 Git 差异。")).catch(c.report)}>查看差异</button>
			<button disabled={!doc} onClick={() => setDiff(null)}>编辑</button>
			<button disabled={!doc || Boolean(c.activeTask) || saving} onClick={() => { c.setDocument(null); setDiff(null); }}>关闭 / 放弃草稿</button>
		</div>
		{doc ? diff !== null ? <pre className="code-diff">{diff}</pre> : <textarea aria-label="代码编辑器" className="code-editor" spellCheck={false} readOnly={!documentRoot?.canWrite || Boolean(c.activeTask) || large || saving || c.observationOnly} value={doc.text} onChange={(event) => c.setDocument({ ...doc, text: event.target.value })} /> : <div className="editor-empty"><h2>代码工作区</h2><p>从左侧打开文件，或创建一个新文件。</p><input aria-label="新文件路径" placeholder="相对路径，例如 docs/note.md" value={newPath} onChange={(event) => setNewPath(event.target.value)} /><button disabled={!c.root?.canWrite || Boolean(c.activeTask) || !newPath || c.observationOnly} onClick={() => { c.setDocument({ rootId: c.rootId, path: newPath, sha256: null, text: "", diskText: "" }); setNewPath(""); }}>新建文件</button></div>}
		<div className="statusline">{large ? "文件较大，此编辑器只读；可使用 Agent 定向编辑。" : doc ? "草稿自动保存在本机；保存写入仓库并保留修改前内容。" : "每次保存都检查文件是否已被外部修改。"}</div>
	</div>;
}
export function DevelopmentPanel() {
	const c = useWorkbench(), [profiles, setProfiles] = useState<Profile[]>([]), [model, setModel] = useState(""), [prompt, setPrompt] = useState("");
	const [task, setTask] = useState<Task | null>(null), [checks, setChecks] = useState<{ id: string; label: string }[]>([]), [checkId, setCheckId] = useState("");
	useEffect(() => {
		async function refreshProfiles() { setProfiles(await window.deck.profiles()); }
		void Promise.all([window.deck.profiles(), wb<{ prompt?: string; model?: string } | null>("ui-get", { key: "draft" })]).then(([items, draft]) => {
			setProfiles(items); setPrompt(draft?.prompt ?? "");
			const matches = items.filter((item) => item.providerId + "/" + item.modelId === draft?.model);
			setModel(items.some((item) => profileToken(item) === draft?.model) ? draft!.model! : matches.length === 1 ? profileToken(matches[0]) : "");
		}).catch(c.report);
		return window.deck.onEvent((event) => { if (event.type === "profiles-changed") void refreshProfiles().catch(c.report); });
	}, []);
	useEffect(() => { if (!c.rootId) return; void wb<typeof checks>("checks", { rootId: c.rootId }).then((items) => { setChecks(items); setCheckId(items[0]?.id ?? ""); }).catch(c.report); }, [c.rootId]);
	useEffect(() => {
		let current = true, running = false;
		async function refresh() { if (!c.taskId || running) return; running = true; try { const task = await wb<Task>("task", { taskId: c.taskId }); if (current) setTask(task); } catch (error) { c.report(error); } finally { running = false; } }
		setTask(null); void refresh();
		const timer = setInterval(() => void refresh(), 800);
		return () => { current = false; clearInterval(timer); };
	}, [c.taskId]);
	function draft(text: string, selectedModel = model) { setPrompt(text); setModel(selectedModel); void wb("ui-save", { key: "draft", value: { prompt: text, model: selectedModel } }).catch(c.report); }
	async function start() { const selected = profiles.find((profile) => profileToken(profile) === model); if (!selected) return; const task = await wb<Task>("agent", { rootId: c.rootId, prompt, providerId: selected.providerId, modelId: selected.modelId }); c.selectTask(task.id); await c.refresh(); }
	return <div className="panel development-panel">
		<div className="eyebrow">PI · DEVELOPMENT</div><h2>开发 Agent</h2><p>当前仓库：{c.root?.label ?? "未选择"}。每项任务最多 5 分钟。</p>
		<select aria-label="开发模型" value={model} disabled={Boolean(c.activeTask)} onChange={(event) => draft(prompt, event.target.value)}><option value="">选择模型</option>{profiles.map((profile) => <option key={profileToken(profile)} value={profileToken(profile)}>{profile.label ? `${profile.label} · ` : ""}{profile.modelId}</option>)}</select>
		<textarea aria-label="开发任务" className="task-input" maxLength={16000} placeholder="描述一个有限改动，或让 Agent 先检查代码…" value={prompt} onChange={(event) => draft(event.target.value)} />
		<div className="actions"><button className="accent" disabled={!c.rootId || !profiles.some((profile) => profileToken(profile) === model) || !prompt.trim() || Boolean(c.activeTask) || c.executionBlocked} onClick={() => void start().catch(c.report)}>开始任务</button><button disabled={!c.activeTask} onClick={() => void wb("cancel", { taskId: c.activeTask }).catch(c.report)}>停止任务</button></div>
		<div className="check-row"><select aria-label="仓库检查" value={checkId} onChange={(event) => setCheckId(event.target.value)}>{checks.map((check) => <option key={check.id} value={check.id}>{check.label}</option>)}</select><button disabled={!checkId || !c.root?.canExecute || Boolean(c.activeTask) || c.executionBlocked} onClick={() => void wb<Task>("check", { rootId: c.rootId, checkId }).then((task) => { c.selectTask(task.id); return c.refresh(); }).catch(c.report)}>运行检查</button></div>
		<p className="muted">构建和测试会运行该仓库代码。开发任务不持有游戏工具，模型费用未知。</p>
		{task && <><div className="task-heading">{labels[task.state] ?? task.state} · {c.roots.find((root) => root.id === task.rootId)?.label}<span>{task.id.slice(0, 8)}</span></div><pre>{taskText(task)}</pre></>}
		{c.notice && <p className="notice">{c.notice}</p>}
	</div>;
}
export function TasksPanel() {
	const c = useWorkbench();
	return <div className="panel tasks-panel"><div className="eyebrow">PERSISTENT TASKS</div><p>选择任务打开原日志；代码原始差异和固定版本记录在任务内保留。重启应用不会自动重跑。</p>{c.tasks.map((task) => <button className={c.taskId === task.id ? "task-row selected" : "task-row"} key={task.id} onClick={() => c.showTask(task.id)}><span>{labels[task.state] ?? task.state}</span><strong>{task.prompt || task.kind}</strong><small>{c.roots.find((root) => root.id === task.rootId)?.label} · {task.id.slice(0, 8)}</small></button>)}</div>;
}
function TaskReferences({ task }: { task: Task }) {
	const c = useWorkbench(), [rootId, setRootId] = useState(""), [path, setPath] = useState(""), [label, setLabel] = useState("Lab 验收记录"), [attaching, setAttaching] = useState(false), [message, setMessage] = useState("");
	const root = c.roots.find(value => value.id === rootId);
	async function attach() {
		if (!root?.metadata.sha) return;
		setAttaching(true); setMessage("");
		try { await wb("attach-reference", { taskId: task.id, rootId, path, revision: root.metadata.sha, label }); setMessage("记录已关联到原任务，内容固定在所示提交。"); }
		catch (error) { c.report(error); }
		finally { setAttaching(false); await c.refresh().catch(c.report); }
	}
	return <div className="task-references">{task.references?.map(reference => <div className="statusline" key={reference.id}><button onClick={() => void c.showReference(task.id, reference.id).catch(c.report)}>打开记录 · {reference.label}</button><span>{c.roots.find(value => value.id === reference.rootId)?.label} / {reference.path} · {reference.revision.slice(0, 8)}</span></div>)}
		<details className="reference-form"><summary>关联验收记录</summary><p>从已添加的仓库选择文件，固定到该仓库提交中的内容。未提交修改不包含在引用内，关联记录不代表验收通过。</p>
			<select aria-label="记录所在仓库" value={rootId} disabled={attaching} onChange={event => setRootId(event.target.value)}><option value="">选择记录仓库</option>{c.roots.filter(value => value.metadata.sha).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select>
			<input aria-label="记录文件路径" maxLength={2048} placeholder="例如 scenarios/example/README.md" value={path} disabled={attaching} onChange={event => setPath(event.target.value)} />
			<input aria-label="记录名称" maxLength={80} value={label} disabled={attaching} onChange={event => setLabel(event.target.value)} />
			{root?.metadata.sha && <p className="muted">固定提交 {root.metadata.sha}</p>}
			<button disabled={!root?.metadata.sha || !path || !label.trim() || attaching || Boolean(c.activeTask) || c.executionBlocked || ["queued", "running", "cancelling"].includes(task.state)} onClick={() => void attach()}>关联到此任务</button>{message && <p role="status">{message}</p>}
		</details></div>;
}
export function OutputPanel() {
	const c = useWorkbench(), [task, setTask] = useState<Task | null>(null);
	useEffect(() => {
		let current = true, loading = false;
		async function refresh() { if (!c.taskId || loading) return; loading = true; try { const value = await wb<Task>("task", { taskId: c.taskId }); if (current) setTask(value); } catch (error) { c.report(error); } finally { loading = false; } }
		setTask(null); void refresh(); const timer = setInterval(() => void refresh(), 800);
		return () => { current = false; clearInterval(timer); };
	}, [c.taskId]);
	const result = task?.result && typeof task.result === "object" ? task.result as Record<string, unknown> : null;
	const output = task?.events?.filter((event) => event.kind === "command-output").map((event) => event.value.text).join("");
	return <div className="output-panel"><div className="statusline">{task ? `${task.id.slice(0, 8)} · ${labels[task.state] ?? task.state}` : "选择一项任务查看日志"}{typeof result?.exitCode === "number" ? ` · 退出码 ${result.exitCode}` : ""}</div><pre>{output || (task ? taskText(task) : "尚未选择任务。")}</pre>{task?.changes?.map((change) => <div className="statusline" key={change.id}>{change.path} · {changeLabels[change.state] ?? change.state}<button disabled={!["applied", "reverted"].includes(change.state)} onClick={() => void c.showChange(task.id, change.id).catch(c.report)}>打开原始差异</button><button disabled={c.observationOnly || Boolean(c.activeTask) || change.state !== "applied" || !c.roots.find((root) => root.id === task.rootId)?.canWrite} onClick={() => void wb<Task>("revert", { sourceTaskId: task.id, changeId: change.id }).then((next) => { c.selectTask(next.id); return c.refresh(); }).catch(c.report)}>撤回此文件修改</button></div>)}{task && <TaskReferences key={task.id} task={task} />}{result && <details className="receipt"><summary>详细回执</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}{c.notice && <p className="notice">{c.notice}</p>}</div>;
}

export const persistedLayout = { load: () => wb<Record<string, unknown> | null>("ui-get", { key: "layout" }), save: (value: unknown) => wb("ui-save", { key: "layout", value }) };
