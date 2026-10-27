import React, { useEffect, useRef, useState } from "react";
import { RecordingControls } from "./recording";

type Recording = { id: string; state: string; startedAt: string; stoppedAt: string | null; bytes: number; chunks: number; capture: { width: number; height: number; frameRate: number }; build: { sourceRevision: string | null; piCommit: string | null }; reason: string | null; sha256: string | null };
type VideoState = { available: boolean; activeId: string | null; error: string | null; limits: { recordings: number; recordingBytes: number }; recordings: Recording[] };
type Playback = { grant: string; url: string; recording: Recording; complete: boolean; readOnly: true; executionAuthority: false };
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.video<T>(action, args);
const states: Record<string, string> = { complete: "已完成", interrupted: "录制中断", recording: "正在录制" };
const size = (bytes: number) => bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;

export function VideosPanel() {
	const [state, setState] = useState<VideoState | null>(null), [selected, setSelected] = useState(""), [playback, setPlayback] = useState<Playback | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
	const alive = useRef(true), refreshing = useRef(false), generation = useRef(0), lease = useRef<Playback | null>(null), video = useRef<HTMLVideoElement | null>(null);
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
	function closePlayback() { generation.current++; release(); setPlayback(null); setBusy(false); }
	useEffect(() => {
		alive.current = true; void refresh(); const timer = setInterval(() => void refresh(), 2000), unsubscribe = window.deck.onEvent(event => { if (event.type === "video-changed") void refresh(); });
		const hidden = () => { if (document.visibilityState !== "visible") video.current?.pause(); }; document.addEventListener("visibilitychange", hidden);
		return () => { alive.current = false; generation.current++; clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", hidden); release(); };
	}, []);
	async function openPlayback() {
		const expected = ++generation.current; release(); setPlayback(null); setBusy(true); setNotice("");
		try {
			const opened = await call<Playback>("open", { id: selected });
			if (!alive.current || expected !== generation.current) { await call("close", { grant: opened.grant }); return; }
			lease.current = opened; setPlayback(opened);
		} catch { if (alive.current && expected === generation.current) setNotice("无法打开这条录像。请检查归档状态，或关闭播放后重新打开。"); }
		finally { if (alive.current && expected === generation.current) setBusy(false); }
	}
	const row = state?.recordings.find(row => row.id === selected);
	return <div className="panel videos-panel" data-video-mode="archive">
		<RecordingControls />
		<div className="eyebrow">LOCAL VIDEO ARCHIVE</div><h2>本地录像 / 只读播放</h2>
		<p className="muted">浏览已经归档的录像。播放不会运行 Agent 或执行游戏操作。</p>
		{state && !state.available && <p className="notice">录像归档暂不可用，原文件会保留。</p>}{notice && <p className="notice" role="status">{notice}</p>}
		<label>本地录像<select aria-label="本地录像" value={selected} disabled={busy} onChange={event => { closePlayback(); setSelected(event.target.value); setNotice(""); }}><option value="">选择录像</option>{state?.recordings.map(recording => <option key={recording.id} value={recording.id}>{new Date(recording.startedAt).toLocaleString()} · {states[recording.state] ?? recording.state} · {size(recording.bytes)}</option>)}</select></label>
		{!state?.recordings.length && <p className="muted">暂无本地录像。</p>}
		<div className="actions"><button disabled={busy || !state?.available || !row || row.state === "recording" || row.bytes < 4} onClick={() => void openPlayback()}>打开播放</button><button disabled={!playback && !busy} onClick={closePlayback}>关闭播放</button></div>
		{row && <>
			<p>{states[row.state] ?? row.state} · {size(row.bytes)} · {row.chunks} 个媒体片段</p>
			{row.state === "interrupted" && <p className="notice">这条录像中途停止；已保留的片段可能无法完整播放。</p>}
			<p className="muted">编码参数：{row.capture.width} × {row.capture.height} · {row.capture.frameRate} 帧/秒。实际播放时长以播放器为准。</p>
			<p className="muted">构建声明：{row.build.sourceRevision?.slice(0, 12) ?? "源码模式，未声明固定候选"} · Pi {row.build.piCommit?.slice(0, 12) ?? "未声明"}</p>
		</>}
		{playback && <video key={playback.grant} ref={video} controls muted preload="metadata" src={playback.url} aria-label="本地录像播放器" onError={() => setNotice("播放已停止或链接已失效，请重新打开录像。")} />}
		<p className="muted">本地最多保留 {state?.limits.recordings ?? 32} 条，每条上限 {size(state?.limits.recordingBytes ?? 134217728)}；到限不自动删除历史。</p>
	</div>;
}
