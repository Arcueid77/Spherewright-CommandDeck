import React, { useEffect, useRef, useState } from "react";

type Recording = { id: string; state: string; startedAt: string; stoppedAt: string | null; events: number; reason: string | null; build: { sourceRevision: string | null; piCommit: string | null } };
type Point = { sequence: number; elapsedMs: number; domain: string; kind: string; task: string | null; facts: { state: string; tool: string | null; code: string | null; busy: boolean | null; available: boolean | null; count: number | null; requests: number | null; executed: number | null; exitCode: number | null } };
type Archive = { recording: Recording; events: Point[]; bookmarks: { id: string; sequence: number; tag: string; createdAt: string }[]; readOnly: boolean; executionAuthority: false };
type JournalState = { available: boolean; error: string | null; activeId: string | null; scope: string; limits: { recordings: number; events: number; bookmarks: number }; recordings: Recording[] };
const domains: Record<string, string> = { recording: "事件记录", development: "开发任务", game: "游戏任务", bridge: "连接观察", probe: "模型探针", system: "系统" };
const kinds: Record<string, string> = { start: "开始记录", stop: "结束记录", limit: "记录已达上限", task: "任务状态", tool: "工具状态", assistant: "模型回应已省略", usage: "模型用量事件", "command-output": "命令输出已省略", "check-result": "检查结果", change: "文件变更事件", reference: "验收引用", error: "错误", stage: "执行阶段", state: "状态", result: "结果", power: "暂停 / 唤醒", "runtime-stopped": "运行时停止", "ui-health": "窗口响应", "ui-recovered": "界面恢复", "native-state": "原生窗口" };
const tags: Record<string, string> = { checkpoint: "进度节点", attention: "需要关注", issue: "发现问题", verified: "已核验" };
const status: Record<string, string> = { recording: "正在记录", stopped: "已停止", interrupted: "记录中断", user_stopped: "手动停止", application_exit: "应用退出", event_limit: "达到事件上限", application_interrupted: "上次退出未完成，结束时间未确认", storage_unconfirmed: "记录写入未确认", unknown: "未提供", running: "进行中", completed: "完成", succeeded: "成功", failed: "失败", cancelled: "已停止", accepted: "已受理", blocked: "受阻", awaiting_approval: "等待确认", preparing: "预检中", planning: "规划中", observing: "观察中", reconciling: "核销中", advised: "建议完成", ready: "可用", suspended: "系统暂停", checking: "唤醒检查", connected: "已连接", disconnected: "未连接" };
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.journal<T>(action, args);
export function JournalPanel() {
	const [state, setState] = useState<JournalState | null>(null), [selected, setSelected] = useState(""), [archive, setArchive] = useState<Archive | null>(null), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [tag, setTag] = useState("checkpoint"), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	const selection = useRef(""), generation = useRef(0), refreshing = useRef(false), alive = useRef(true);
	async function refresh() {
		if (refreshing.current || !alive.current) return; refreshing.current = true;
		const expected = generation.current;
		try {
			const value = await call<JournalState>("snapshot"); if (!alive.current || generation.current !== expected) return; setState(value);
			const id = selection.current || value.activeId || value.recordings[0]?.id || "";
			if (!id) { setArchive(null); return; }
			const data = await call<Archive>("read", { id }); if (!alive.current || generation.current !== expected) return;
			selection.current = id; setSelected(id); setArchive(data); setIndex(previous => Math.min(previous, Math.max(0, data.events.length - 1)));
		} catch { if (alive.current && generation.current === expected) setNotice("本地记录暂不可用，原文件会保留。"); }
		finally { refreshing.current = false; }
	}
	useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 1000), unsubscribe = window.deck.onEvent(event => { if (event.type === "journal-changed") void refresh(); }); return () => { alive.current = false; generation.current++; clearInterval(timer); unsubscribe(); }; }, []);
	useEffect(() => { if (!playing) return; const timer = setInterval(() => setIndex(previous => { const last = Math.max(0, (archive?.events.length ?? 0) - 1); if (previous >= last) { setPlaying(false); return previous; } return previous + 1; }), 400); return () => clearInterval(timer); }, [playing, archive?.events.length]);
	async function action(kind: string) {
		if (busy) return; setBusy(true); setNotice(""); setPlaying(false); generation.current++;
		try {
			if (kind === "start") { const value = await call<JournalState>("start"); selection.current = value.activeId ?? ""; setSelected(selection.current); setIndex(0); }
			else if (kind === "stop") await call("stop", { id: state?.activeId });
			else if (archive?.events[index]) await call("bookmark", { id: selected, sequence: archive.events[index].sequence, tag });
		} catch { setNotice("操作未完成。请检查记录状态、存储空间或记录数量上限。"); }
		finally { setBusy(false); generation.current++; await refresh(); }
	}
	const event = archive?.events[index], live = Boolean(state?.activeId && state.activeId === selected && !archive?.readOnly);
	return <div className="panel journal-panel" data-journal-mode={live ? "live" : "replay"}>
		<div className="eyebrow">LOCAL EVENT JOURNAL</div><h2>运行日记 / 事件回放</h2>
		<p className="muted">仅记录结构化主机事件，不含画面、聊天正文、命令参数、源码、路径或原始身份。回放只浏览本地数据。</p>
		<div className="actions"><button disabled={busy || !state?.available || Boolean(state.activeId)} onClick={() => void action("start")}>开始事件记录</button><button disabled={busy || !state?.activeId || !state.available} onClick={() => void action("stop")}>停止事件记录</button></div>
		{!state?.available && <p className="notice">事件记录不可用；任务与游戏执行仍由原工作台管理。</p>}{notice && <p className="notice">{notice}</p>}
		<label>本地记录<select aria-label="本地事件记录" value={selected} onChange={event => { generation.current++; selection.current = event.target.value; setSelected(event.target.value); setIndex(0); setPlaying(false); void refresh(); }}><option value="">选择记录</option>{state?.recordings.map(row => <option key={row.id} value={row.id}>{new Date(row.startedAt).toLocaleString()} · {status[row.state] ?? row.state} · {row.events} 事件</option>)}</select></label>
		{archive && <>
			<p>{status[archive.recording.state] ?? archive.recording.state} · {archive.events.length} 事件{archive.recording.reason && ` · ${status[archive.recording.reason] ?? archive.recording.reason}`}</p>
			<p className="muted">构建声明：{archive.recording.build.sourceRevision?.slice(0, 12) ?? "源码模式，未声明固定候选"} · Pi {archive.recording.build.piCommit?.slice(0, 12) ?? "未声明"}</p>
			<div className="actions"><button disabled={!event || index === 0} onClick={() => { setPlaying(false); setIndex(value => Math.max(0, value - 1)); }}>上一事件</button><button disabled={!event} onClick={() => setPlaying(value => !value)}>{playing ? "暂停浏览" : "连续浏览"}</button><button disabled={!event || index >= archive.events.length - 1} onClick={() => { setPlaying(false); setIndex(value => Math.min(archive.events.length - 1, value + 1)); }}>下一事件</button></div>
			<input aria-label="事件位置" type="range" min={0} max={Math.max(0, archive.events.length - 1)} value={index} disabled={!event} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} />
			{event && <div className="journal-event" data-event-sequence={event.sequence}><b>#{event.sequence} · +{(event.elapsedMs / 1000).toFixed(2)}s · {domains[event.domain]} / {kinds[event.kind]}</b><p>{event.task && `${event.task} · `}{status[event.facts.state] ?? event.facts.state}{event.facts.tool && ` · ${event.facts.tool}`}</p><dl>{Object.entries(event.facts).filter(([key, value]) => !["state", "tool"].includes(key) && value !== null).map(([key, value]) => <React.Fragment key={key}><dt>{({ code: "状态码", busy: "忙碌", available: "可用", count: "数量", requests: "模型 / 观察请求", executed: "已执行工具", exitCode: "退出码" } as Record<string, string>)[key]}</dt><dd>{String(value)}</dd></React.Fragment>)}</dl></div>}
			<div className="actions"><select aria-label="书签分类" value={tag} onChange={event => setTag(event.target.value)}>{Object.entries(tags).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select><button disabled={!live || busy || !event || !state?.available} onClick={() => void action("bookmark")}>添加事件书签</button></div>
			<div className="journal-bookmarks">{archive.bookmarks.map(bookmark => <button key={bookmark.id} onClick={() => { setPlaying(false); setIndex(archive.events.findIndex(event => event.sequence === bookmark.sequence)); }}>#{bookmark.sequence} · {tags[bookmark.tag]}</button>)}</div>
		</>}
		<p className="muted">每条记录最多 {state?.limits.events ?? 4096} 个事件、{state?.limits.bookmarks ?? 128} 个书签；本地保留上限 {state?.limits.recordings ?? 64} 条。到限会停止记录并明确标记，不自动删除历史。这些事件不构成游戏动作回执。</p>
	</div>;
}
