import { recordingProfiles, type RecordingMask } from "../../desktop/recording-options.mjs";
import { paintMaskedVideo } from "../../desktop/video-frame.mjs";

export type RecordingState = { phase: string; error: string | null; permit: string | null; recordingId: string | null; profile: string; masks: RecordingMask[]; size: { width: number; height: number; frameRate: number } | null; cleanupPending: boolean; bytes: number; chunks: number };
type ClientState = RecordingState & { busy: boolean; notice: string; preview: MediaStream | null; drawnFrames: number };
type Runtime = { permit: string; input: MediaStream; output: MediaStream; encoderOutput?: MediaStream; video: HTMLVideoElement; canvas: HTMLCanvasElement; timer: ReturnType<typeof setInterval>; masks: RecordingMask[]; render: () => void; drawn: number; closed: boolean; stopping: boolean; recorder?: MediaRecorder; stopped?: Promise<void>; sink: Promise<void>; pending: number; sequence: number };
const call = <T,>(action: string, args: Record<string, unknown> = {}) => window.deck.recording<T>(action, args);
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> { let timer: ReturnType<typeof setTimeout>; return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("VIDEO_OPERATION_TIMEOUT")), ms); })]).finally(() => clearTimeout(timer)); }
function message(error: unknown) {
	const code = error instanceof Error ? error.message.match(/\b(?:VIDEO|WINDOW)_[A-Z_]+\b/)?.[0] : "";
	return ({ VIDEO_DESKTOP_UNAVAILABLE: "Windows 桌面不可用，请解锁后重新准备。", WINDOW_CAPTURE_UNSUPPORTED: "当前窗口适配器不支持录像来源，请更新适配器后重新准备。", WINDOW_CAPTURE_SELECTION_REQUIRED: "请先嵌入一个明确选定的游戏窗口。", VIDEO_PREVIEW_EXPIRED: "预览已到期，请重新准备窗口。", VIDEO_CAPTURE_CLEANUP_UNCONFIRMED: "上次捕获的清理尚未确认，请重新打开界面。", VIDEO_ARCHIVE_BACKPRESSURE: "媒体写入跟不上编码，已停止并保留接受的片段。", VIDEO_RECORDING_BYTE_LIMIT: "录像达到文件上限，已保留接受的片段。" } as Record<string, string>)[code ?? ""] ?? "录制操作未完成，已停止预览并保留接受的片段。";
}
class RecordingClient {
	private state: ClientState = { phase: "idle", error: null, permit: null, recordingId: null, profile: "720p15", masks: [], size: null, cleanupPending: false, bytes: 0, chunks: 0, busy: false, notice: "", preview: null, drawnFrames: 0 };
	private listeners = new Set<() => void>(); private runtime: Runtime | null = null; private acquiring: MediaStream | null = null; private operation = 0; private refreshing = false; private closing: Promise<void> | null = null;
	constructor() {
		window.deck.onEvent(event => { if (event.type === "recording-changed") void this.refresh(); });
		document.addEventListener("visibilitychange", () => { if (document.visibilityState !== "visible" && this.state.permit) void this.cancel("界面已隐藏，预览和录制已停止。"); });
		window.addEventListener("beforeunload", () => { this.cleanup(); });
		setInterval(() => { if (this.listeners.size || this.runtime || this.state.phase !== "idle") void this.refresh(); }, 1000);
	}
	getSnapshot = () => this.state;
	subscribe = (listener: () => void) => { this.listeners.add(listener); void this.refresh(); return () => { this.listeners.delete(listener); }; };
	private publish(value: Partial<ClientState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
	async refresh() {
		if (this.refreshing) return; this.refreshing = true;
		try {
			const state = await call<RecordingState>("snapshot"); this.publish({ ...state, drawnFrames: this.runtime?.drawn ?? this.state.drawnFrames });
			if (this.runtime && !this.runtime.stopping && (state.phase === "stopping" || state.permit !== this.runtime.permit)) void this.cancel(state.error ? message(new Error(state.error)) : "预览已停止。");
		} catch { this.publish({ notice: "录制状态暂不可用。" }); }
		finally { this.refreshing = false; }
	}
	private cleanup() {
		for (const track of this.acquiring?.getTracks() ?? []) track.stop(); this.acquiring = null;
		const runtime = this.runtime; this.runtime = null;
		if (runtime) { runtime.closed = true; clearInterval(runtime.timer); if (runtime.recorder?.state === "recording") runtime.recorder.stop(); runtime.video.pause(); runtime.video.srcObject = null; for (const track of [...runtime.input.getTracks(), ...runtime.output.getTracks(), ...runtime.encoderOutput?.getTracks() ?? []]) track.stop(); }
		this.publish({ preview: null });
	}
	async cancel(notice = "预览已关闭。") {
		if (this.closing) return this.closing; const permit = this.runtime?.permit ?? this.state.permit; this.operation++; this.cleanup(); this.publish({ busy: false, notice });
		this.closing = (async () => { try { if (permit) { await call("cancel", { permit }); await call("closed", { permit }); } } catch {} await this.refresh(); })().finally(() => { this.closing = null; }); return this.closing;
	}
	async prepare(profile: string) {
		const ticket = ++this.operation; this.publish({ busy: true, notice: "" });
		try { const prepared = await call<{ permit: string }>("prepare", { profile, masks: [] }); if (ticket !== this.operation) { await call("cancel", { permit: prepared.permit }); return; } await this.refresh(); }
		catch (error) { if (ticket === this.operation) this.publish({ notice: message(error) }); }
		finally { if (ticket === this.operation) this.publish({ busy: false }); }
	}
	async preview() {
		const permit = this.state.permit; if (!permit || this.state.phase !== "armed") return; const ticket = ++this.operation; this.publish({ busy: true, notice: "" }); let input: MediaStream | null = null;
		try {
			// The browser call is made directly from the preview click, before any await.
			const profile = recordingProfiles[this.state.profile]; input = await navigator.mediaDevices.getDisplayMedia({ video: { width: { max: profile.maxWidth }, height: { max: profile.maxHeight }, frameRate: { max: profile.frameRate } }, audio: false });
			if (ticket !== this.operation) throw new Error("VIDEO_UI_CHANGED"); this.acquiring = input;
			const video = document.createElement("video"); video.muted = true; video.playsInline = true; video.srcObject = input; await bounded(video.play(), 7000);
			const deadline = performance.now() + 7000; while (video.readyState < 2 || !video.videoWidth) { if (performance.now() >= deadline || ticket !== this.operation) throw new Error("VIDEO_FRAME_UNAVAILABLE"); await wait(25); }
			const settings = input.getVideoTracks()[0]?.getSettings(), ready = await call<RecordingState>("ready", { permit, track: { videoTracks: input.getVideoTracks().length, audioTracks: input.getAudioTracks().length, displaySurface: settings?.displaySurface, width: video.videoWidth, height: video.videoHeight, frameRate: settings?.frameRate ?? 0 } });
			if (ticket !== this.operation || !ready.size) throw new Error("VIDEO_UI_CHANGED");
			const canvas = document.createElement("canvas"), composition = document.createElement("canvas"); canvas.width = composition.width = ready.size.width; canvas.height = composition.height = ready.size.height;
			const context = composition.getContext("2d", { alpha: false }), committed = canvas.getContext("2d", { alpha: false }); if (!context || !committed) throw new Error("VIDEO_FRAME_UNAVAILABLE");
			const draw = (masks: RecordingMask[]) => { paintMaskedVideo(context, video, canvas.width, canvas.height, masks); committed.drawImage(composition, 0, 0); };
			draw(ready.masks); const output = canvas.captureStream(ready.size.frameRate);
			const runtime: Runtime = { permit, input, output, video, canvas, masks: ready.masks, render: () => { draw(runtime.masks); runtime.drawn++; }, drawn: 1, closed: false, stopping: false, timer: setInterval(() => {}, 100000), sink: Promise.resolve(), pending: 0, sequence: 0 }; clearInterval(runtime.timer);
			runtime.timer = setInterval(() => { if (runtime.closed) return; try { runtime.render(); } catch (error) { void this.cancel(message(error)); } }, 1000 / ready.size.frameRate);
			this.acquiring = null; this.runtime = runtime;
			for (const track of input.getTracks()) { track.addEventListener("ended", () => { if (!runtime.closed) void this.cancel("窗口捕获已结束。"); }); track.addEventListener("mute", () => { if (!runtime.closed) void this.cancel("窗口捕获暂不可用，已停止录制。"); }); }
			this.publish({ ...ready, preview: output, drawnFrames: 1 });
		} catch (error) { for (const track of input?.getTracks() ?? []) track.stop(); if (ticket === this.operation) await this.cancel(message(error)); }
		finally { if (ticket === this.operation) this.publish({ busy: false }); }
	}
	async masks(masks: RecordingMask[]) {
		const runtime = this.runtime; if (!runtime || this.state.phase !== "preview" || this.state.busy) return; const ticket = ++this.operation; this.publish({ busy: true });
		try { const state = await call<RecordingState>("set-masks", { permit: runtime.permit, masks }); if (ticket === this.operation && !runtime.closed) { runtime.masks = state.masks; runtime.render(); this.publish(state); } }
		catch (error) { if (ticket === this.operation) await this.cancel(message(error)); }
		finally { if (ticket === this.operation) this.publish({ busy: false }); }
	}
	async start() {
		const runtime = this.runtime; if (!runtime || this.state.phase !== "preview" || this.state.busy) return; const ticket = ++this.operation; this.publish({ busy: true, notice: "" });
		try {
			const state = await call<RecordingState>("start", { permit: runtime.permit }); if (ticket !== this.operation || runtime.closed) return; this.publish(state);
			runtime.render(); runtime.encoderOutput = runtime.canvas.captureStream(recordingProfiles[this.state.profile].frameRate);
			const recorder = new MediaRecorder(runtime.encoderOutput, { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: recordingProfiles[this.state.profile].bitsPerSecond }); runtime.recorder = recorder;
			runtime.stopped = new Promise<void>((resolve, reject) => { recorder.onstop = () => resolve(); recorder.onerror = () => reject(new Error("VIDEO_ENCODER_FAILED")); }); void runtime.stopped.catch(() => { if (!runtime.closed) void this.cancel("编码器已停止，接受的片段会保留。"); });
			recorder.ondataavailable = event => {
				if (runtime.closed || !event.data.size) return;
				if (event.data.size > 2097152 || runtime.pending >= 2) { void this.cancel("媒体写入跟不上编码，已停止并保留接受的片段。"); return; }
				runtime.pending++; const sequence = ++runtime.sequence;
				runtime.sink = runtime.sink.then(async () => { const bytes = new Uint8Array(await event.data.arrayBuffer()); if (!runtime.closed) await call("append", { permit: runtime.permit, sequence, bytes }); }).catch(error => { if (!runtime.closed) void this.cancel(message(error)); }).finally(() => { runtime.pending--; });
			}; recorder.start(250);
		} catch (error) { if (ticket === this.operation) await this.cancel(message(error)); }
		finally { if (ticket === this.operation) this.publish({ busy: false }); }
	}
	async stop() {
		const runtime = this.runtime; if (!runtime?.recorder || this.state.busy) return; const ticket = ++this.operation; runtime.stopping = true; this.publish({ busy: true, notice: "正在保存录像。" });
		try {
			if (runtime.recorder.state === "recording") runtime.recorder.stop(); await bounded(runtime.stopped!, 7000); await bounded(runtime.sink, 12000);
			if (ticket !== this.operation || runtime.closed) throw new Error("VIDEO_CAPTURE_CHANGED"); await call("finish", { permit: runtime.permit }); this.cleanup(); await call("closed", { permit: runtime.permit }); this.publish({ notice: "录像已保存。" }); await this.refresh();
		} catch (error) { if (ticket === this.operation) await this.cancel(message(error)); }
		finally { if (ticket === this.operation) this.publish({ busy: false }); }
	}
}
export const recordingClient = new RecordingClient();
