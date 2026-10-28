import React, { useEffect, useRef, useState } from "react";
import { RecordingControls } from "./recording";

type Recording = { id: string; state: string; startedAt: string; stoppedAt: string | null; bytes: number; chunks: number; capture: { width: number; height: number; frameRate: number }; build: { sourceRevision: string | null; piCommit: string | null }; reason: string | null; sha256: string | null };
type VideoState = { available: boolean; activeId: string | null; error: string | null; limits: { recordings: number; recordingBytes: number }; recordings: Recording[] };
type Playback = { grant: string; url: string; mediaSha256: string; recording: Recording; complete: boolean; readOnly: true; executionAuthority: false };
type JournalPoint = { sequence: number; elapsedMs: number; domain: string; kind: string; task: string | null; state: string; tool: string | null };
type VideoBookmark = { id: string; timeMs: number; tag: string; mediaSha256: string; relation: { sequence: number } | null; link: { status: string; event: JournalPoint | null } };
type VideoContext = { recording: Recording; bookmarks: VideoBookmark[]; limits: { perRecording: number }; timeline: { status: string; mediaSha256: string | null; uncertaintyMs: number | null; events: { event: JournalPoint; fromMs: number; toMs: number; timeMs: number }[] }; journal: { status: string; total: number; offset: number; nextOffset: number | null; events: JournalPoint[] } };
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.video<T>(action, args);
const states: Record<string, string> = { complete: "已完成", interrupted: "录制中断", recording: "正在录制" };
const size = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
const tags: Record<string, string> = { checkpoint: "进度节点", attention: "需要关注", issue: "发现问题", verified: "已核验" };
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")}.${Math.floor(ms % 1000).toString().padStart(3, "0")}`;
const pointLabel = (point: JournalPoint) => `#${point.sequence} · 日记 ${clock(point.elapsedMs)} · ${point.domain}/${point.kind}${point.task ? ` · ${point.task}` : ""}${point.tool ? ` · ${point.tool}` : ""}`;
const timelineMessages: Record<string, string> = { none: "这段录像没有同步记录，仍可手动关联。", pending: "同步依据尚未完成。", unsupported: "这段录像的时间依据不足，仍可手动关联。", changed: "对应日记内容与录制时不符，自动关联已停止。", missing: "对应日记或所需事件缺失，自动关联暂不可用。", unavailable: "对应日记暂不可用。", coarse: "时间范围过宽，暂不自动关联。" };

export function VideosPanel() {
	const [state, setState] = useState<VideoState | null>(null), [selected, setSelected] = useState(""), [playback, setPlayback] = useState<Playback | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	const [context, setContext] = useState<VideoContext | null>(null), [contextBusy, setContextBusy] = useState(false), [bookmarkBusy, setBookmarkBusy] = useState(false), [seeking, setSeeking] = useState(false), [tag, setTag] = useState("checkpoint"), [related, setRelated] = useState(""), [frame, setFrame] = useState({ ready: false, paused: true, timeMs: 0 });
	const alive = useRef(true), refreshing = useRef(false), generation = useRef(0), contextVersion = useRef(0), lease = useRef<Playback | null>(null), video = useRef<HTMLVideoElement | null>(null);
	async function refresh() {
		if (!alive.current || refreshing.current) return; refreshing.current = true;
		try { const value = await call<VideoState>("snapshot"); if (!alive.current) return; setState(value); setSelected(previous => value.recordings.some(row => row.id === previous) ? previous : value.recordings[0]?.id ?? ""); }
		catch { if (alive.current) setNotice("本地录像暂不可用，原文件会保留。"); }
		finally { refreshing.current = false; }
	}
	function release() {
		const current = lease.current; lease.current = null;
		if (video.current) { video.current.pause(); video.current.removeAttribute("src"); video.current.load(); }
		if (current) void call("close", { grant: current.grant }).catch(() => { if (alive.current) setNotice("播放关闭尚未确认，请重新打开工作台后再试。"); });
	}
	function closePlayback() { generation.current++; release(); setPlayback(null); setBusy(false); setBookmarkBusy(false); setSeeking(false); setFrame({ ready: false, paused: true, timeMs: 0 }); }
	async function loadContext(id: string, offset = 0) {
		const expected = ++contextVersion.current; setRelated("");
		if (!id) { setContext(null); setContextBusy(false); return; } setContextBusy(true);
		try { const value = await call<VideoContext>("context", { id, offset }); if (alive.current && expected === contextVersion.current) setContext(value); }
		catch { if (alive.current && expected === contextVersion.current) { setContext(null); setNotice("录像书签暂不可用，原文件和记录会保留。"); } }
		finally { if (alive.current && expected === contextVersion.current) setContextBusy(false); }
	}
	useEffect(() => { setContext(null); void loadContext(selected); }, [selected]);
	useEffect(() => {
		alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 2000), unsubscribe = window.deck.onEvent(event => { if (event.type === "video-changed") void refresh(); });
		const hidden = () => { if (document.visibilityState !== "visible") video.current?.pause(); }; document.addEventListener("visibilitychange", hidden);
		return () => { alive.current = false; generation.current++; contextVersion.current++; clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", hidden); release(); };
	}, []);
	async function openPlayback() {
		const expected = ++generation.current; release(); setPlayback(null); setFrame({ ready: false, paused: true, timeMs: 0 }); setBusy(true); setNotice("");
		try {
			const opened = await call<Playback>("open", { id: selected });
			if (!alive.current || expected !== generation.current) { await call("close", { grant: opened.grant }); return; }
			lease.current = opened; setPlayback(opened);
		} catch { if (alive.current && expected === generation.current) setNotice("无法打开这条录像。请检查归档状态，或关闭播放后重新打开。"); }
		finally { if (alive.current && expected === generation.current) setBusy(false); }
	}
	function observeFrame() { const element = video.current; if (element) setFrame({ ready: element.readyState >= 2 && !element.error && Number.isFinite(element.currentTime), paused: element.paused, timeMs: Math.floor(element.currentTime * 1000) }); }
	async function addBookmark() {
		const current = lease.current, element = video.current, expected = generation.current;
		if (!current || !element || !element.paused || element.readyState < 2 || !Number.isFinite(element.currentTime) || element.error || bookmarkBusy) return;
		const timeMs = Math.floor(element.currentTime * 1000), eventSequence = related ? Number(related) : null; setBookmarkBusy(true); setNotice("");
		try {
			await call("bookmark", { grant: current.grant, timeMs, tag, eventSequence });
			if (alive.current && expected === generation.current) { await loadContext(current.recording.id, context?.journal.offset); setNotice(`已保存视频 ${clock(timeMs)} 的书签${eventSequence ? `，手动关联日记 #${eventSequence}` : ""}。`); }
		} catch { if (alive.current && expected === generation.current) setNotice("书签未保存。请重新打开播放，检查存储状态或书签上限后再试。"); }
		finally { if (alive.current && expected === generation.current) setBookmarkBusy(false); }
	}
	async function seekPosition(timeMs: number, mediaSha256: string | null) {
		const current = lease.current, element = video.current, expected = generation.current;
		if (!current || !element || current.recording.id !== selected || current.mediaSha256 !== mediaSha256) { setNotice("请先打开与时间记录一致的录像。"); return; }
		const target = timeMs / 1000; element.pause(); setSeeking(true); setNotice("");
		try {
			if (element.readyState < 2 || Math.abs(element.currentTime - target) > 0.02) await new Promise<void>((resolve, reject) => {
				const cleanup = () => { clearTimeout(timer); element.removeEventListener("seeked", done); element.removeEventListener("error", failed); };
				const done = () => { cleanup(); if (element.readyState >= 2 && Math.abs(element.currentTime - target) <= 0.1) resolve(); else reject(); };
				const failed = () => { cleanup(); reject(); }, timer = setTimeout(failed, 4000);
				element.addEventListener("seeked", done); element.addEventListener("error", failed); try { element.currentTime = target; } catch { failed(); }
			});
			if (alive.current && expected === generation.current) { observeFrame(); setNotice(`已定位视频 ${clock(timeMs)}。`); }
		} catch { if (alive.current && expected === generation.current) setNotice("无法定位到该画面，录像可能不完整或此位置尚不可用。"); }
		finally { if (alive.current && expected === generation.current) setSeeking(false); }
	}
	const row = state?.recordings.find(row => row.id === selected);
	const canBookmark = Boolean(playback && playback.recording.id === selected && frame.ready && frame.paused && context && !contextBusy && !bookmarkBusy && !seeking && !busy && state?.available && context.bookmarks.length < context.limits.perRecording);
	return <div className="panel videos-panel" data-video-mode="archive">
		<RecordingControls />
		<div className="eyebrow">LOCAL VIDEO ARCHIVE</div><h2>本地录像 / 只读播放</h2>
		<p className="muted">浏览已经归档的录像。播放不会运行 Agent 或执行游戏操作。</p>
		{state && !state.available && <p className="notice">录像归档暂不可用，原文件会保留。</p>}{notice && <p className="notice" role="status">{notice}</p>}
		<label>本地录像<select aria-label="本地录像" value={selected} disabled={busy || bookmarkBusy} onChange={event => { closePlayback(); setSelected(event.target.value); setNotice(""); }}><option value="">选择录像</option>{state?.recordings.map(recording => <option key={recording.id} value={recording.id}>{new Date(recording.startedAt).toLocaleString()} · {states[recording.state] ?? recording.state} · {size(recording.bytes)}</option>)}</select></label>
		{!state?.recordings.length && <p className="muted">暂无本地录像。</p>}
		<div className="actions"><button disabled={busy || !state?.available || !row || row.state === "recording" || row.bytes < 4} onClick={() => void openPlayback()}>打开播放</button><button disabled={!playback && !busy} onClick={closePlayback}>关闭播放</button></div>
		{row && <>
			<p>{states[row.state] ?? row.state} · {size(row.bytes)} · {row.chunks} 个媒体片段</p>
			{row.state === "interrupted" && <p className="notice">这条录像中途停止；已保留的片段可能无法完整播放。</p>}
			<p className="muted">编码参数：{row.capture.width} × {row.capture.height} · {row.capture.frameRate} 帧/秒。实际播放时长以播放器为准。</p>
			<p className="muted">构建声明：{row.build.sourceRevision?.slice(0, 12) ?? "源码模式，未声明固定候选"} · Pi {row.build.piCommit?.slice(0, 12) ?? "未声明"}</p>
		</>}
		{playback && <video key={playback.grant} ref={video} controls muted preload="metadata" src={playback.url} aria-label="本地录像播放器" onLoadedData={observeFrame} onTimeUpdate={observeFrame} onPause={observeFrame} onPlay={observeFrame} onSeeked={observeFrame} onError={() => { setFrame({ ready: false, paused: true, timeMs: 0 }); setNotice("播放已停止或链接已失效，请重新打开录像。"); }} />}
		{row && context && <section className="video-timeline" aria-label="录像自动事件时间线">
			<h3>自动事件时间线</h3>
			{context.timeline.status === "bounded" ? <><p className="muted">事件自动关联到视频时间范围，范围宽度不超过 {context.timeline.uncertaintyMs} 毫秒。点击定位范围中点；播放不会执行任务。</p>
				{context.timeline.events.map(marker => <div key={marker.event.sequence}><button data-timeline-sequence={marker.event.sequence} aria-current={frame.timeMs >= marker.fromMs && frame.timeMs <= marker.toMs ? "true" : undefined} disabled={busy || seeking || !playback || playback.recording.id !== selected || playback.mediaSha256 !== context.timeline.mediaSha256} onClick={() => void seekPosition(marker.timeMs, context.timeline.mediaSha256)}>{pointLabel(marker.event)} · 视频 {clock(marker.fromMs)}–{clock(marker.toMs)}</button></div>)}
				{!context.timeline.events.length && <p className="muted">本页没有完整落在已记录画面范围内的事件。</p>}
			</> : <p className="muted">{timelineMessages[context.timeline.status] ?? "自动关联暂不可用。"}</p>}
		</section>}
		{row && <section className="video-annotations" aria-label="录像书签与事件关联">
			<h3>画面书签 / 手动关联</h3><p className="muted">暂停在要保留的画面后添加书签。可关联录制开始时绑定的运行日记；视频时间与日记时间分别计算，关联由你选择。</p>
			{playback && <p>当前视频位置：{clock(frame.timeMs)}{frame.paused ? " · 已暂停" : " · 播放中"}</p>}
			<label>书签标记<select aria-label="录像书签标记" value={tag} disabled={bookmarkBusy} onChange={event => setTag(event.target.value)}>{Object.entries(tags).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
			<label>关联日记事件<select aria-label="录像关联日记事件" value={related} disabled={bookmarkBusy || contextBusy || context?.journal.status !== "available"} onChange={event => setRelated(event.target.value)}><option value="">只标记视频位置</option>{context?.journal.events.map(event => <option key={event.sequence} value={event.sequence}>{pointLabel(event)}</option>)}</select></label>
			<div className="actions"><button disabled={!canBookmark} onClick={() => void addBookmark()}>添加画面书签</button><button disabled={contextBusy || bookmarkBusy} onClick={() => void loadContext(selected, context?.journal.offset)}>刷新关联事件</button></div>
			{context?.journal.status === "available" ? <p className="muted">日记事件 {context.journal.events.length ? context.journal.offset + 1 : 0}–{context.journal.offset + context.journal.events.length} / {context.journal.total}。<button disabled={contextBusy || bookmarkBusy || context.journal.offset === 0} onClick={() => void loadContext(selected, Math.max(0, context.journal.offset - 128))}>上一页事件</button> <button disabled={contextBusy || bookmarkBusy || context.journal.nextOffset === null} onClick={() => void loadContext(selected, context.journal.nextOffset ?? 0)}>下一页事件</button></p> : <p className="muted">{context?.journal.status === "none" ? "录制开始时没有运行日记；仍可添加画面书签。" : "对应日记暂不可用；已有书签和录像仍保留。"}</p>}
			<div className="video-bookmarks">{context?.bookmarks.map(bookmark => <div key={bookmark.id} data-bookmark-id={bookmark.id}>
				<button disabled={busy || seeking || !playback || playback.recording.id !== selected || playback.mediaSha256 !== bookmark.mediaSha256} onClick={() => void seekPosition(bookmark.timeMs, bookmark.mediaSha256)}>视频 {clock(bookmark.timeMs)} · {tags[bookmark.tag]}</button>
				{bookmark.link.event ? <p className="muted" data-event-sequence={bookmark.link.event.sequence}>手动关联：{pointLabel(bookmark.link.event)}</p> : bookmark.relation && <p className="notice">关联的日记事件{bookmark.link.status === "changed" ? "内容已变化" : "暂不可核对"}，不显示为已匹配。</p>}
			</div>)}</div>
			{context && <p className="muted">本片书签 {context.bookmarks.length} / {context.limits.perRecording}；书签与回放只用于浏览。</p>}
		</section>}
		<p className="muted">本地最多保留 {state?.limits.recordings ?? 32} 条，每条上限 {size(state?.limits.recordingBytes ?? 134217728)}；到限不自动删除历史。</p>
	</div>;
}
