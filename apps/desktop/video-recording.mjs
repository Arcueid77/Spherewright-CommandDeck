import { randomUUID } from "node:crypto";
import { recordingMasks, recordingProfiles, recordingSize } from "./recording-options.mjs";

const code = error => /^(?:VIDEO|WINDOW)_[A-Z_]{1,80}$/.test(error?.message ?? "") ? error.message : "VIDEO_CAPTURE_UNAVAILABLE";
const sameSource = (a, b) => ["version", "sourceId", "windowBinding", "width", "height", "layoutRevision", "gamePid", "gameStartedTicks", "kind", "targetId"].every(key => a?.[key] === b?.[key]);
// Owns capture admission and encoded-byte persistence, never game/model work.
// UI document/process loss revokes admission immediately; cleanup acknowledgement
// or a confirmed document/process replacement is required before another source.
export class VideoRecording {
	constructor({ getArchive, getBuild, getJournalId = () => null, getSource, isCurrent, isLocked, notify = () => {}, now = () => performance.now() }) {
		Object.assign(this, { getArchive, getBuild, getJournalId, getSource, isCurrent, isLocked, notify, now });
		this.state = null; this.error = null; this.disposed = false; this.tail = Promise.resolve(); this.pending = 0; this.checking = false;
		this.timer = setInterval(() => void this.check(), 1000); this.timer.unref?.();
	}
	snapshot() { const state = this.state; return { phase: state?.phase ?? "idle", error: state?.error ?? this.error, permit: state?.permit ?? null, recordingId: state?.recordingId ?? null, profile: state?.profile ?? "720p15", masks: state?.masks ?? [], size: state?.size ?? null, cleanupPending: Boolean(state?.cancelled && !state.cleaned), bytes: state?.bytes ?? 0, chunks: state?.chunks ?? 0 }; }
	emit() { try { this.notify(this.snapshot()); } catch {} }
	assertCurrent(owner, generation) { if (this.disposed || !this.isCurrent(owner, generation)) throw new Error("VIDEO_UI_CHANGED"); if (this.isLocked()) throw new Error("VIDEO_DESKTOP_UNAVAILABLE"); }
	match(owner, generation, permit, phases) {
		this.assertCurrent(owner, generation); const state = this.state;
		if (!state || state.owner !== owner || state.generation !== generation || state.permit !== permit || state.cancelled || !phases.includes(state.phase)) throw new Error("VIDEO_CAPTURE_CHANGED"); return state;
	}
	async verify(state) {
		this.assertCurrent(state.owner, state.generation); const source = await this.getSource(); this.assertCurrent(state.owner, state.generation);
		if (this.state !== state || state.cancelled || !sameSource(state.source, source)) throw new Error("VIDEO_WINDOW_CHANGED"); return source;
	}
	queue(operation) { const result = this.tail.then(operation); this.tail = result.catch(() => {}); return result; }
	async prepare(owner, generation, options) {
		this.assertCurrent(owner, generation); if (this.state || this.pending) throw new Error("VIDEO_CAPTURE_BUSY");
		if (!options || Object.keys(options).sort().join(",") !== "masks,profile" || typeof options.profile !== "string" || !Object.hasOwn(recordingProfiles, options.profile)) throw new Error("VIDEO_CAPTURE_OPTIONS_INVALID");
		const archive = this.getArchive(); if (!archive || !archive.snapshot().available) throw new Error("VIDEO_ARCHIVE_UNAVAILABLE");
		const state = { owner, generation, permit: randomUUID(), phase: "preparing", profile: options.profile, masks: recordingMasks(options.masks), deadline: this.now() + 15000, bytes: 0, chunks: 0, cleaned: true, cancelled: false };
		this.state = state; this.error = null; this.emit();
		try {
			state.source = await this.getSource(); this.assertCurrent(owner, generation); if (this.state !== state || state.cancelled) throw new Error("VIDEO_UI_CHANGED");
			state.phase = "armed"; this.emit(); return { permit: state.permit, profile: { ...recordingProfiles[state.profile] }, expiresInMs: Math.max(0, state.deadline - this.now()) };
		} catch (error) { await this.interrupt(code(error), "window_changed", state, true); throw error; }
	}
	async authorize(owner, generation, permit) {
		const state = this.match(owner, generation, permit, ["armed"]);
		if (this.now() >= state.deadline) { await this.interrupt("VIDEO_PREVIEW_EXPIRED", "ui_lost", state, true); throw new Error("VIDEO_PREVIEW_EXPIRED"); }
		state.phase = "acquiring"; state.cleaned = false; state.deadline = this.now() + 15000;
		try { const source = await this.verify(state); this.emit(); return { id: source.sourceId, name: "选定游戏视口" }; }
		catch (error) { await this.interrupt(code(error), "window_changed", state, true); throw error; }
	}
	async ready(owner, generation, permit, track) {
		const state = this.match(owner, generation, permit, ["acquiring"]);
		if (!track || Object.keys(track).sort().join(",") !== "audioTracks,displaySurface,frameRate,height,videoTracks,width" || track.audioTracks !== 0 || track.videoTracks !== 1 || track.displaySurface !== "window" || !Number.isFinite(track.frameRate) || track.frameRate <= 0 || track.frameRate > recordingProfiles[state.profile].frameRate + 0.01) throw new Error("VIDEO_TRACK_INVALID");
		const size = recordingSize(track.width, track.height, state.profile);
		if (Math.abs(track.width / track.height / (state.source.width / state.source.height) - 1) > 0.02) throw new Error("VIDEO_TRACK_GEOMETRY_CHANGED");
		await this.verify(state); state.size = size; state.phase = "preview"; state.deadline = this.now() + 60000; this.emit(); return this.snapshot();
	}
	setMasks(owner, generation, permit, masks) { const state = this.match(owner, generation, permit, ["preview"]); state.masks = recordingMasks(masks); this.emit(); return this.snapshot(); }
	async start(owner, generation, permit) {
		const state = this.match(owner, generation, permit, ["preview"]); state.phase = "starting"; this.emit();
		try {
			await this.verify(state);
			return await this.queue(async () => {
				if (state.cancelled || this.state !== state) throw new Error("VIDEO_CAPTURE_CHANGED");
				const archive = this.getArchive(), build = this.getBuild(), result = await archive.start({ ...state.size, sourceRevision: build?.sourceRevision, piCommit: build?.piCommit, journalId: this.getJournalId() });
				state.recordingId = result.activeId;
				if (state.cancelled || this.state !== state) throw new Error("VIDEO_CAPTURE_CHANGED");
				state.phase = "recording"; this.emit(); return this.snapshot();
			});
		} catch (error) { await this.interrupt(code(error), "ui_lost", state); throw error; }
	}
	append(owner, generation, permit, sequence, bytes) {
		const state = this.match(owner, generation, permit, ["recording"]);
		if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 2097152 || !Number.isSafeInteger(sequence) || sequence < 1) throw new Error("VIDEO_CHUNK_INVALID");
		if (this.pending >= 2) throw new Error("VIDEO_ARCHIVE_BACKPRESSURE"); this.pending++; const copy = Buffer.from(bytes);
		const result = this.queue(async () => {
			this.match(owner, generation, permit, ["recording"]); const receipt = await this.getArchive().append(state.recordingId, sequence, copy);
			state.bytes = receipt.bytes; state.chunks = receipt.sequence; this.emit(); return receipt;
		}).catch(async error => { void this.interrupt(code(error), "ui_lost", state); throw error; }).finally(() => { this.pending--; }); return result;
	}
	async finish(owner, generation, permit) {
		const state = this.match(owner, generation, permit, ["recording"]); if (this.pending) throw new Error("VIDEO_CHUNKS_PENDING"); state.phase = "finishing"; this.emit();
		try {
			await this.verify(state);
			await this.queue(async () => { if (state.cancelled || this.state !== state) throw new Error("VIDEO_CAPTURE_CHANGED"); await this.getArchive().finish(state.recordingId); });
			state.phase = "stopping"; state.cancelled = true; state.stopDeadline = this.now() + 5000; state.storageClosed = true; this.emit(); this.release(state); return this.snapshot();
		} catch (error) { await this.interrupt(code(error), "ui_lost", state); throw error; }
	}
	release(state) { if (this.state === state && state.cancelled && state.cleaned && state.storageClosed) { this.error = state.error ?? null; this.state = null; this.emit(); } }
	interrupt(error = "VIDEO_CAPTURE_STOPPED", reason = "ui_lost", state = this.state, confirmedGone = false) {
		if (!state || this.state !== state) return Promise.resolve(this.snapshot());
		state.cancelled = true; state.cleaned ||= confirmedGone; state.error ??= error; state.phase = "stopping"; state.stopDeadline ??= this.now() + 5000; this.emit();
		if (state.closing) { this.release(state); return state.closing; }
		state.closing = this.queue(async () => {
			try { if (state.recordingId && this.getArchive()?.active?.id === state.recordingId) await this.getArchive().interrupt(reason); state.storageClosed = true; }
			catch { state.error = "VIDEO_ARCHIVE_CLOSE_UNCONFIRMED"; }
			this.release(state); this.emit(); return this.snapshot();
		}); return state.closing;
	}
	cancel(owner, generation, permit) {
		const state = this.state; if (!state || state.owner !== owner || state.generation !== generation || state.permit !== permit) return Promise.resolve(this.snapshot());
		return this.interrupt("VIDEO_CAPTURE_STOPPED", "ui_lost", state);
	}
	closed(owner, generation, permit) { const state = this.state; if (state?.owner === owner && state.generation === generation && state.permit === permit) { state.cleaned = true; if (!state.cancelled) void this.interrupt("VIDEO_CAPTURE_STOPPED", "ui_lost", state); else this.release(state); } return this.snapshot(); }
	invalidate(owner, reason = "ui_lost", confirmedGone = false) { if (this.state?.owner !== owner) return Promise.resolve(); return this.interrupt("VIDEO_UI_CHANGED", reason, this.state, confirmedGone); }
	documentReady(owner, generation) { const state = this.state; if (state?.owner === owner && state.generation < generation) { state.cleaned = true; this.release(state); } }
	async check() {
		const state = this.state; if (!state || this.checking || this.disposed) return;
		if (state.cancelled) { if (!state.cleaned && this.now() >= state.stopDeadline && state.error !== "VIDEO_CAPTURE_CLEANUP_UNCONFIRMED") { state.error = "VIDEO_CAPTURE_CLEANUP_UNCONFIRMED"; this.emit(); } return; }
		if (!this.isCurrent(state.owner, state.generation) || this.isLocked()) { void this.interrupt("VIDEO_DESKTOP_UNAVAILABLE", "power_interrupted", state); return; }
		if (["preparing", "armed", "acquiring", "preview"].includes(state.phase) && this.now() >= state.deadline) { void this.interrupt("VIDEO_PREVIEW_EXPIRED", "ui_lost", state); return; }
		if (!["preview", "recording"].includes(state.phase)) return;
		this.checking = true; try { await this.verify(state); } catch (error) { await this.interrupt(code(error), "window_changed", state); } finally { this.checking = false; }
	}
	async dispose() { this.disposed = true; clearInterval(this.timer); await this.interrupt("VIDEO_APPLICATION_EXIT", "application_exit"); await this.tail; }
}
