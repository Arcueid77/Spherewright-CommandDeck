import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { recordingClient } from "./recording-client";

const labels: Record<string, string> = { idle: "未录制", preparing: "正在准备", armed: "已准备，等待预览", acquiring: "正在取得画面", preview: "预览中", starting: "正在开始录制", recording: "正在录制", finishing: "正在保存", stopping: "正在停止捕获" };
export function RecordingControls() {
	const state = useSyncExternalStore(recordingClient.subscribe, recordingClient.getSnapshot), [profile, setProfile] = useState("720p15"), [origin, setOrigin] = useState<{ x: number; y: number } | null>(null), video = useRef<HTMLVideoElement | null>(null);
	useEffect(() => { const element = video.current; if (!element) return; element.srcObject = state.preview; if (state.preview) void element.play().catch(() => {}); return () => { element.pause(); element.srcObject = null; }; }, [state.preview]);
	return <section className="recording-controls" data-recording-phase={state.phase}>
		<h3>录制选定游戏窗口</h3><p>{labels[state.phase] ?? "录制状态不可用"}</p>
		<p className="muted">仅捕获选定游戏窗口，不含聊天和开发面板。无音频；在预览上拖动可遮挡区域，遮挡会在编码前应用。窗口变化、锁屏或隐藏界面会停止录制。</p>
		<label>编码配置<select aria-label="录像编码配置" disabled={state.busy || state.phase !== "idle"} value={profile} onChange={event => setProfile(event.target.value)}><option value="720p15">最高 720p / 15 帧</option><option value="1080p30">最高 1080p / 30 帧</option></select></label>
		<div className="actions"><button disabled={state.busy || state.phase !== "idle"} onClick={() => void recordingClient.prepare(profile)}>准备选定窗口</button><button disabled={state.busy || state.phase !== "armed"} onClick={() => void recordingClient.preview()}>预览选定窗口</button><button disabled={state.busy || state.phase !== "preview" || !state.preview} onClick={() => void recordingClient.start()}>开始录制</button><button disabled={state.busy || state.phase !== "recording"} onClick={() => void recordingClient.stop()}>停止并保存</button><button disabled={!state.permit} onClick={() => void recordingClient.cancel()}>关闭捕获</button></div>
		{state.notice && <p className="notice" role="status">{state.notice}</p>}
		{state.preview && state.size && <>
			<div className="recording-preview" style={{ aspectRatio: `${state.size.width} / ${state.size.height}` }} onPointerDown={event => { if (state.phase !== "preview" || state.busy || state.masks.length >= 8) return; event.currentTarget.setPointerCapture(event.pointerId); const box = event.currentTarget.getBoundingClientRect(); setOrigin({ x: Math.max(0, Math.min(10000, Math.round((event.clientX - box.left) / box.width * 10000))), y: Math.max(0, Math.min(10000, Math.round((event.clientY - box.top) / box.height * 10000))) }); }} onPointerUp={event => { if (!origin) return; const box = event.currentTarget.getBoundingClientRect(), x = Math.max(0, Math.min(10000, Math.round((event.clientX - box.left) / box.width * 10000))), y = Math.max(0, Math.min(10000, Math.round((event.clientY - box.top) / box.height * 10000))); setOrigin(null); if (state.phase !== "preview" || state.busy) return; const mask = { x: Math.min(origin.x, x), y: Math.min(origin.y, y), width: Math.abs(origin.x - x), height: Math.abs(origin.y - y) }; if (mask.width && mask.height) void recordingClient.masks([...state.masks, mask]); }} onPointerCancel={() => setOrigin(null)}>
				<video ref={video} muted playsInline aria-label="遮挡后的录像预览" />
			</div>
			<p className="muted">{state.size.width} × {state.size.height} · {state.masks.length}/8 个遮挡 · 已处理 {state.drawnFrames} 帧。仅遮挡已框选区域；游戏内其余内容仍会录入。</p>
			<button disabled={state.busy || state.phase !== "preview" || !state.masks.length} onClick={() => void recordingClient.masks([])}>清除遮挡</button>
		</>}
		{state.phase === "recording" && <p>已接受 {(state.bytes / 1048576).toFixed(2)} MiB · {state.chunks} 个媒体片段</p>}
	</section>;
}
