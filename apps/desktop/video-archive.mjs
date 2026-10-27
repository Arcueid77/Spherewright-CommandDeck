import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, lstatSync, realpathSync, existsSync, openSync, closeSync, readFileSync, writeSync, fsyncSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const videoArchiveLimits = Object.freeze({ recordings: 32, recordingBytes: 134217728, chunkBytes: 2097152, readBytes: 1048576 });
export const videoMime = "video/webm;codecs=vp8";
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const revision = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value) ? value : null;
const reasons = ["user_stopped", "application_exit", "application_interrupted", "ui_lost", "power_interrupted", "window_changed", "byte_limit", "no_data"];
const stamp = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
function regular(file) {
	const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync(file).toLowerCase() !== resolve(file).toLowerCase()) throw new Error("VIDEO_ARCHIVE_PATH_UNSAFE"); return info;
}

// Encoded media only. This store creates no capture permission, model/game
// request or execution authority. A trusted host still has to bind the source.
export class VideoArchive {
	constructor(directory, { limits = videoArchiveLimits, now = () => performance.now(), utc = () => new Date().toISOString(), notify = () => {} } = {}) {
		if (!limits || Object.keys(limits).sort().join(",") !== Object.keys(videoArchiveLimits).sort().join(",") || Object.keys(videoArchiveLimits).some(key => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > videoArchiveLimits[key]) || limits.recordingBytes < 4 || limits.chunkBytes < 4) throw new Error("VIDEO_LIMITS_INVALID");
		this.directory = resolve(directory); this.limits = limits; this.now = now; this.utc = utc; this.notify = notify;
		this.active = null; this.error = null; this.closed = false; this.closing = false; this.pending = 0; this.tail = Promise.resolve();
		mkdirSync(directory, { recursive: true, mode: 0o700 }); if (realpathSync(directory).toLowerCase() !== this.directory.toLowerCase() || lstatSync(directory).isSymbolicLink()) throw new Error("VIDEO_ARCHIVE_PATH_UNSAFE");
		this.directoryIdentity = lstatSync(directory); this.readers = new Set();
		const file = join(this.directory, "videos.sqlite"), marker = file + ".presence", markerText = "commanddeck-video-archive-v1\n";
		for (const path of [file, file + "-wal", file + "-shm", marker]) if (existsSync(path)) regular(path);
		if (existsSync(marker) && (regular(marker).size !== Buffer.byteLength(markerText) || readFileSync(marker, "utf8") !== markerText)) throw new Error("VIDEO_ARCHIVE_EVIDENCE_INVALID");
		if (!existsSync(file) && readdirSync(directory).length || existsSync(file) && regular(file).size === 0) throw new Error("VIDEO_ARCHIVE_EVIDENCE_MISSING");
		let created = false; try { const fd = openSync(file, "wx", 0o600); closeSync(fd); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
		this.db = new DatabaseSync(file);
		try {
			const version = this.db.prepare("PRAGMA user_version").get().user_version, tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
			if (version > 1) throw new Error("VIDEO_ARCHIVE_SCHEMA_TOO_NEW");
			if (![0, 1].includes(version) || version === 0 && (!created || tables.length) || version === 1 && JSON.stringify(tables) !== '["recordings"]') throw new Error("VIDEO_ARCHIVE_SCHEMA_UNKNOWN");
			if (version === 1) try { this.db.prepare("SELECT id,state,started_at,stopped_at,bytes,chunks,elapsed_ms,mime,width,height,frame_rate,source_revision,pi_commit,journal_id,reason,sha256 FROM recordings LIMIT 0").all(); } catch { throw new Error("VIDEO_ARCHIVE_SCHEMA_UNKNOWN"); }
			this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
			if (version === 0) this.db.exec("BEGIN IMMEDIATE; CREATE TABLE recordings(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at TEXT NOT NULL,stopped_at TEXT,bytes INTEGER NOT NULL,chunks INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,frame_rate INTEGER NOT NULL,source_revision TEXT,pi_commit TEXT,journal_id TEXT,reason TEXT,sha256 TEXT); CREATE UNIQUE INDEX one_recording ON recordings((1)) WHERE state='recording'; PRAGMA user_version=1; COMMIT;");
			const rows = this.rows();
			const allowed = new Set(["videos.sqlite", "videos.sqlite-wal", "videos.sqlite-shm", "videos.sqlite.presence", ...rows.map(row => row.id + ".webm")]);
			if (readdirSync(directory).some(name => !allowed.has(name))) throw new Error("VIDEO_ARCHIVE_EVIDENCE_INVALID");
			for (const row of rows) if (regular(this.path(row.id)).size !== row.bytes) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED");
			this.db.prepare("UPDATE recordings SET state='interrupted',reason='application_interrupted' WHERE state='recording'").run();
			if (!existsSync(marker)) { const fd = openSync(marker, "wx", 0o600); try { writeSync(fd, markerText); fsyncSync(fd); } finally { closeSync(fd); } }
		} catch (error) { this.db.close(); throw error; }
	}
	path(id) { if (!uuid(id)) throw new Error("VIDEO_RECORDING_INVALID"); return join(this.directory, id + ".webm"); }
	notice() { try { this.notify(); } catch {} }
	rows() {
		const rows = this.db.prepare("SELECT * FROM recordings ORDER BY started_at DESC,id DESC LIMIT ?").all(this.limits.recordings + 1);
		if (rows.length > this.limits.recordings) throw new Error("VIDEO_ARCHIVE_EVIDENCE_INVALID");
		for (const row of rows) if (!uuid(row.id) || !["recording", "complete", "interrupted"].includes(row.state) || !stamp(row.started_at) || row.stopped_at !== null && !stamp(row.stopped_at) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > this.limits.recordingBytes || !Number.isSafeInteger(row.chunks) || row.chunks < 0 || row.chunks > 1048576 || !Number.isSafeInteger(row.elapsed_ms) || row.elapsed_ms < 0 || row.mime !== videoMime || !Number.isInteger(row.width) || row.width < 1 || row.width > 1920 || !Number.isInteger(row.height) || row.height < 1 || row.height > 1080 || !Number.isInteger(row.frame_rate) || row.frame_rate < 1 || row.frame_rate > 30 || row.source_revision !== null && revision(row.source_revision) !== row.source_revision || row.pi_commit !== null && revision(row.pi_commit) !== row.pi_commit || row.journal_id !== null && !uuid(row.journal_id) || row.reason !== null && !reasons.includes(row.reason) || row.sha256 !== null && !/^[a-f0-9]{64}$/.test(row.sha256) || row.state === "complete" && (row.bytes < 4 || row.sha256 === null || row.stopped_at === null)) throw new Error("VIDEO_ARCHIVE_EVIDENCE_INVALID");
		return rows;
	}
	publicRow(row) { return { id: row.id, state: this.error && row.state === "recording" ? "interrupted" : row.state, startedAt: row.started_at, stoppedAt: row.stopped_at, bytes: row.bytes, chunks: row.chunks, elapsedMs: row.elapsed_ms, mime: row.mime, capture: { width: row.width, height: row.height, frameRate: row.frame_rate }, build: { sourceRevision: row.source_revision, piCommit: row.pi_commit }, journalId: row.journal_id, reason: this.error && row.state === "recording" ? "storage_unconfirmed" : row.reason, sha256: row.sha256, executionAuthority: false }; }
	snapshot() { let recordings = []; try { recordings = this.rows().map(row => this.publicRow(row)); } catch { this.error = "VIDEO_ARCHIVE_UNAVAILABLE"; } return { available: !this.closed && !this.closing && !this.error, error: this.error, activeId: this.error ? null : this.active?.id ?? null, limits: this.limits, recordings }; }
	assertDirectory() { const info = lstatSync(this.directory); if (info.isSymbolicLink() || info.ino !== this.directoryIdentity.ino || info.dev !== this.directoryIdentity.dev || realpathSync(this.directory).toLowerCase() !== this.directory.toLowerCase()) throw new Error("VIDEO_ARCHIVE_PATH_UNSAFE"); }
	assertWritable() { if (this.closed || this.error) throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); try { this.assertDirectory(); this.rows(); } catch { this.error = "VIDEO_ARCHIVE_UNAVAILABLE"; this.notice(); throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); } }
	queue(action) {
		if (this.closed || this.closing) return Promise.reject(new Error("VIDEO_ARCHIVE_UNAVAILABLE"));
		if (this.pending >= 3) return Promise.reject(new Error("VIDEO_ARCHIVE_BACKPRESSURE")); this.pending++;
		const operation = this.tail.then(action); this.tail = operation.catch(() => {}).finally(() => { this.pending--; }); return operation;
	}
	async fault() { this.error = "VIDEO_ARCHIVE_UNAVAILABLE"; const active = this.active; this.active = null; try { await active?.file.close(); } catch {} this.notice(); }
	elapsed() { return Math.max(this.active?.elapsed ?? 0, Math.floor(Math.max(0, this.now() - this.active.started))); }
	start(metadata) {
		return this.queue(async () => {
			this.assertWritable(); if (this.active) throw new Error("VIDEO_ALREADY_RECORDING");
			if (this.rows().length >= this.limits.recordings) throw new Error("VIDEO_RECORDING_LIMIT");
			if (!metadata || Object.keys(metadata).some(key => !["width", "height", "frameRate", "sourceRevision", "piCommit", "journalId"].includes(key)) || !Number.isInteger(metadata.width) || metadata.width < 1 || metadata.width > 1920 || !Number.isInteger(metadata.height) || metadata.height < 1 || metadata.height > 1080 || !Number.isInteger(metadata.frameRate) || metadata.frameRate < 1 || metadata.frameRate > 30 || metadata.journalId != null && !uuid(metadata.journalId)) throw new Error("VIDEO_METADATA_INVALID");
			const id = randomUUID(); let file;
			try { file = await open(this.path(id), "wx", 0o600); this.db.prepare("INSERT INTO recordings VALUES(?,'recording',?,NULL,0,0,0,?,?,?,?,?,?,?,NULL,NULL)").run(id, this.utc(), videoMime, metadata.width, metadata.height, metadata.frameRate, revision(metadata.sourceRevision), revision(metadata.piCommit), metadata.journalId ?? null); }
			catch { await file?.close().catch(() => {}); await this.fault(); throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); }
			this.active = { id, file, bytes: 0, chunks: 0, elapsed: 0, started: this.now(), hash: createHash("sha256"), last: null }; this.notice(); return this.snapshot();
		});
	}
	append(id, sequence, data) {
		if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > this.limits.chunkBytes) return Promise.reject(new Error("VIDEO_CHUNK_INVALID"));
		if (this.pending >= 3) return Promise.reject(new Error("VIDEO_ARCHIVE_BACKPRESSURE")); const bytes = Buffer.from(data);
		return this.queue(async () => {
			this.assertWritable(); const active = this.active; if (!active || active.id !== id) throw new Error("VIDEO_RECORDING_CHANGED");
			const hash = createHash("sha256").update(bytes).digest("hex");
			if (sequence === active.chunks && active.last?.hash === hash) return active.last.receipt;
			if (!Number.isSafeInteger(sequence) || sequence !== active.chunks + 1) throw new Error("VIDEO_CHUNK_SEQUENCE_CHANGED");
			if (!active.chunks && (bytes.length < 4 || bytes.subarray(0, 4).toString("hex") !== "1a45dfa3")) throw new Error("VIDEO_WEBM_HEADER_REQUIRED");
			if (active.bytes + bytes.length > this.limits.recordingBytes) { await this.interruptActive("byte_limit"); throw new Error("VIDEO_RECORDING_BYTE_LIMIT"); }
			let transaction = false;
			try {
				this.db.exec("BEGIN IMMEDIATE"); transaction = true;
				this.db.prepare("UPDATE recordings SET bytes=bytes WHERE id=? AND state='recording'").run(id);
				for (let offset = 0; offset < bytes.length;) { const written = await active.file.write(bytes, offset, bytes.length - offset, active.bytes + offset); if (!written.bytesWritten) throw new Error("VIDEO_WRITE_INCOMPLETE"); offset += written.bytesWritten; }
				await active.file.sync(); const elapsed = this.elapsed();
				this.db.prepare("UPDATE recordings SET bytes=?,chunks=?,elapsed_ms=? WHERE id=? AND state='recording'").run(active.bytes + bytes.length, sequence, elapsed, id); this.db.exec("COMMIT"); transaction = false;
				active.bytes += bytes.length; active.chunks = sequence; active.elapsed = elapsed; active.hash.update(bytes);
				const receipt = { id, sequence, bytes: active.bytes }; active.last = { hash, receipt }; this.notice(); return receipt;
			} catch { if (transaction) try { this.db.exec("ROLLBACK"); } catch {} await this.fault(); throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); }
		});
	}
	finish(id) {
		return this.queue(async () => {
			this.assertWritable(); if (!this.active || this.active.id !== id) throw new Error("VIDEO_RECORDING_CHANGED"); const active = this.active;
			if (!active.bytes) { await this.interruptActive("no_data"); return this.snapshot(); }
			try { await active.file.sync(); this.db.prepare("UPDATE recordings SET state='complete',stopped_at=?,elapsed_ms=?,reason='user_stopped',sha256=? WHERE id=? AND state='recording'").run(this.utc(), this.elapsed(), active.hash.digest("hex"), id); await active.file.close(); this.active = null; this.notice(); return this.snapshot(); }
			catch { await this.fault(); throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); }
		});
	}
	async interruptActive(reason) {
		const active = this.active; if (!active) return;
		try { await active.file.sync(); this.db.prepare("UPDATE recordings SET state='interrupted',stopped_at=?,elapsed_ms=?,reason=? WHERE id=? AND state='recording'").run(this.utc(), this.elapsed(), reason, active.id); await active.file.close(); this.active = null; this.notice(); }
		catch { await this.fault(); throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); }
	}
	interrupt(reason) { return this.queue(async () => { this.assertWritable(); if (!reasons.includes(reason) || ["user_stopped", "application_interrupted", "no_data"].includes(reason)) throw new Error("VIDEO_INTERRUPT_REASON_INVALID"); await this.interruptActive(reason); return this.snapshot(); }); }
	async openReader(id) {
		if (this.closed || this.closing) throw new Error("VIDEO_ARCHIVE_UNAVAILABLE"); await this.tail;
		if (this.closed || this.closing || this.readers.size >= 4) throw new Error("VIDEO_PLAYBACK_UNAVAILABLE"); this.assertDirectory();
		const row = this.rows().find(row => row.id === id); if (!row || row.state === "recording" || row.bytes < 4) throw new Error("VIDEO_PLAYBACK_UNAVAILABLE");
		const info = regular(this.path(id)); if (info.size !== row.bytes) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED");
		const file = await open(this.path(id), "r"), current = await file.stat();
		let closed = false, closing;
		const reader = { close: () => { closed = true; return closing ??= file.close().then(() => { this.readers.delete(reader); }, error => { closing = null; throw error; }); } }; this.readers.add(reader);
		try {
			if (!current.isFile() || current.nlink !== 1 || current.ino !== info.ino || current.dev !== info.dev || current.size !== info.size) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED");
			const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let offset = 0;
			while (offset < row.bytes) { if (this.closed || this.closing || closed) throw new Error("VIDEO_PLAYBACK_UNAVAILABLE"); const result = await file.read(buffer, 0, Math.min(buffer.length, row.bytes - offset), offset); if (!result.bytesRead) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED"); if (offset === 0 && buffer.subarray(0, 4).toString("hex") !== "1a45dfa3") throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED"); hash.update(buffer.subarray(0, result.bytesRead)); offset += result.bytesRead; }
			const digest = hash.digest("hex"); if (row.sha256 !== null && digest !== row.sha256) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED");
			const final = await file.stat(); if (final.size !== current.size || final.mtimeMs !== current.mtimeMs || final.ctimeMs !== current.ctimeMs) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED");
			if (this.closed || this.closing || closed) throw new Error("VIDEO_PLAYBACK_UNAVAILABLE");
			return { recording: this.publicRow(row), observedSha256: digest, complete: row.state === "complete", readOnly: true, executionAuthority: false,
				read: async (offset, length) => { if (closed || !Number.isSafeInteger(offset) || offset < 0 || offset >= row.bytes || !Number.isSafeInteger(length) || length < 1 || length > this.limits.readBytes) throw new Error("VIDEO_RANGE_INVALID"); const info = await file.stat(); if (info.size !== final.size || info.mtimeMs !== final.mtimeMs || info.ctimeMs !== final.ctimeMs || info.nlink !== 1) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED"); const bytes = Buffer.alloc(Math.min(length, row.bytes - offset)); const read = await file.read(bytes, 0, bytes.length, offset); if (read.bytesRead !== bytes.length) throw new Error("VIDEO_ARCHIVE_MEDIA_UNCONFIRMED"); return bytes; },
				close: reader.close };
		} catch (error) { await reader.close(); throw error; }
	}
	async close() { if (this.closed) return; this.closing = true; await this.tail; try { if (this.error) await this.fault(); else if (this.active) await this.interruptActive("application_exit"); await Promise.all([...this.readers].map(reader => reader.close())); } finally { this.closed = true; this.db.close(); } }
}
