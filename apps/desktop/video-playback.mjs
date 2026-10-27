import { randomUUID } from "node:crypto";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const videoPlaybackChunkBytes = 65536;
export function videoByteRange(header, total) {
	if (!Number.isSafeInteger(total) || total < 1 || total > 134217728) throw new Error("VIDEO_RANGE_INVALID");
	if (header == null) return { start: 0, end: total - 1, length: total, status: 200 };
	if (typeof header !== "string" || header.length > 128) throw new Error("VIDEO_RANGE_INVALID");
	const match = /^bytes=(?:(\d{1,10})-(\d{0,10})|-(\d{1,10}))$/.exec(header); if (!match) throw new Error("VIDEO_RANGE_INVALID");
	const start = match[3] ? Math.max(0, total - Number(match[3])) : Number(match[1]), end = match[3] || !match[2] ? total - 1 : Math.min(total - 1, Number(match[2]));
	if (match[3] && Number(match[3]) === 0 || start >= total || end < start) throw new Error("VIDEO_RANGE_INVALID");
	return { start, end, length: end - start + 1, status: 206 };
}

// A playback grant is local media access, never a task/approval/capture grant.
export class VideoPlaybackSessions {
	#sessions = new Map(); #versions = new WeakMap(); #pending = new Set(); #closing = new Set(); #disposed = false; #failed = false;
	constructor({ getArchive, isCurrent, now = () => performance.now(), ttlMs = 300000 }) {
		if (typeof getArchive !== "function" || typeof isCurrent !== "function") throw new Error("TRUSTED_VIDEO_HOST_REQUIRED");
		this.getArchive = getArchive; this.isCurrent = isCurrent; this.now = now; this.ttlMs = ttlMs;
		this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref?.();
	}
	current(owner, generation) { return !this.#disposed && !this.#failed && owner && typeof owner === "object" && Number.isSafeInteger(generation) && generation > 0 && this.isCurrent(owner, generation); }
	scope(owner, generation) { if (!this.current(owner, generation)) throw new Error("VIDEO_UI_CHANGED"); }
	closeSession(state) {
		if (this.#sessions.get(state.grant) === state) this.#sessions.delete(state.grant);
		if (state.closing) return state.closing;
		const operation = Promise.resolve().then(() => state.reader.close()).catch(() => { this.#failed = true; throw new Error("VIDEO_READER_CLOSE_UNCONFIRMED"); });
		state.closing = operation; this.#closing.add(operation); void operation.finally(() => this.#closing.delete(operation)).catch(() => {}); return operation;
	}
	invalidate(owner) {
		if (!owner || typeof owner !== "object") return Promise.resolve();
		this.#versions.set(owner, (this.#versions.get(owner) ?? 0) + 1);
		return Promise.all([...this.#sessions.values()].filter(state => state.owner === owner).map(state => this.closeSession(state))).then(() => {});
	}
	open(owner, generation, id) {
		this.scope(owner, generation); if (!uuid(id)) throw new Error("VIDEO_RECORDING_INVALID"); if (this.#pending.size >= 2) throw new Error("VIDEO_PLAYBACK_BUSY");
		const prior = this.invalidate(owner), version = this.#versions.get(owner); const entry = { owner, promise: null };
		const operation = (async () => {
			let reader;
			try {
				await prior; this.scope(owner, generation); const archive = this.getArchive(); if (!archive || archive.closed || archive.error) throw new Error("VIDEO_ARCHIVE_UNAVAILABLE");
				reader = await archive.openReader(id); this.scope(owner, generation); if (this.#versions.get(owner) !== version) throw new Error("VIDEO_UI_CHANGED");
				if (reader.readOnly !== true || reader.executionAuthority !== false || reader.recording?.id !== id || !Number.isSafeInteger(reader.recording.bytes) || reader.recording.bytes < 4 || reader.recording.bytes > 134217728 || !/^[a-f0-9]{64}$/.test(reader.observedSha256 ?? "")) throw new Error("VIDEO_PLAYBACK_UNCONFIRMED");
				const grant = randomUUID(), state = { grant, owner, generation, reader, expires: this.now() + this.ttlMs, reads: 0 }; this.#sessions.set(grant, state);
				return { grant, recording: reader.recording, mediaSha256: reader.observedSha256, complete: reader.complete === true, readOnly: true, executionAuthority: false, expiresInMs: this.ttlMs };
			} catch (error) { await reader?.close().catch(() => { this.#failed = true; }); throw error; }
		})();
		entry.promise = operation; this.#pending.add(entry); void operation.finally(() => this.#pending.delete(entry)).catch(() => {}); return operation;
	}
	match(owner, generation, grant) {
		this.scope(owner, generation); const state = this.#sessions.get(grant);
		if (!state || state.owner !== owner || state.generation !== generation) throw new Error("VIDEO_PLAYBACK_CHANGED");
		if (this.now() >= state.expires) { void this.closeSession(state).catch(() => {}); throw new Error("VIDEO_PLAYBACK_EXPIRED"); } return state;
	}
	async read(owner, generation, grant, offset, length) {
		const state = this.match(owner, generation, grant); if (!Number.isSafeInteger(offset) || offset < 0 || offset >= state.reader.recording.bytes || !Number.isSafeInteger(length) || length < 1 || length > videoPlaybackChunkBytes) throw new Error("VIDEO_RANGE_INVALID");
		if (state.reads >= 2) throw new Error("VIDEO_PLAYBACK_BUSY"); state.reads++;
		try { const bytes = await state.reader.read(offset, length); if (this.match(owner, generation, grant) !== state) throw new Error("VIDEO_PLAYBACK_CHANGED"); if (!(bytes instanceof Uint8Array) || bytes.length !== Math.min(length, state.reader.recording.bytes - offset)) throw new Error("VIDEO_PLAYBACK_UNCONFIRMED"); state.expires = this.now() + this.ttlMs; return bytes; }
		finally { state.reads--; }
	}
	async close(owner, generation, grant) { const state = this.#sessions.get(grant); if (state?.owner === owner && state.generation === generation) await this.closeSession(state); return { closed: true }; }
	async annotate(owner, generation, grant, operation) {
		if (typeof operation !== "function") throw new Error("TRUSTED_VIDEO_HOST_REQUIRED");
		const state = this.match(owner, generation, grant);
		await this.read(owner, generation, grant, 0, 4);
		if (this.match(owner, generation, grant) !== state) throw new Error("VIDEO_PLAYBACK_CHANGED");
		return operation({ recording: state.reader.recording, mediaSha256: state.reader.observedSha256 }, () => this.match(owner, generation, grant) === state);
	}
	sweep() { for (const state of this.#sessions.values()) if (!this.current(state.owner, state.generation) || this.now() >= state.expires) void this.closeSession(state).catch(() => {}); }
	async drain() {
		this.#disposed = true; clearInterval(this.timer);
		for (const entry of this.#pending) this.#versions.set(entry.owner, (this.#versions.get(entry.owner) ?? 0) + 1);
		await Promise.allSettled([...this.#sessions.values()].map(state => this.closeSession(state)));
		await Promise.allSettled([...this.#pending].map(entry => entry.promise)); await Promise.allSettled([...this.#closing]);
		if (this.#failed) throw new Error("VIDEO_READER_CLOSE_UNCONFIRMED");
	}
}
