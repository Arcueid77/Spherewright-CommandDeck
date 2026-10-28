import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, realpathSync, openSync, closeSync, readFileSync, writeSync, fsyncSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { journalLimits, bookmarkTags, JournalProjector, journalFacts, validateJournalPoint } from "./journal-format.mjs";
import { journalPrefixHash } from "./journal-evidence.mjs";

const iso = () => new Date().toISOString();
const idValid = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const build = value => ({ sourceRevision: /^[a-f0-9]{40}$/.test(value?.sourceRevision ?? "") ? value.sourceRevision : null, piCommit: /^[a-f0-9]{40}$/.test(value?.piCommit ?? "") ? value.piCommit : null });
const point = kind => ({ domain: "recording", kind, task: null, facts: journalFacts({}) });
function physical(directory, file) {
	if (realpathSync(directory).toLowerCase() !== resolve(directory).toLowerCase() || lstatSync(directory).isSymbolicLink()) throw new Error("JOURNAL_PATH_UNSAFE");
	for (const path of [file, file + "-wal", file + "-shm", file + ".presence"]) { try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("JOURNAL_PATH_UNSAFE"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
}
export class EventJournal {
	constructor(directory, { now = () => performance.now(), utc = iso, limits = journalLimits, notify = () => {} } = {}) {
		this.now = now; this.utc = utc; this.limits = limits; this.notify = notify; this.active = null; this.error = null; this.closed = false;
		mkdirSync(directory, { recursive: true, mode: 0o700 }); const file = join(directory, "events.sqlite"), marker = file + ".presence", markerBytes = "commanddeck-event-journal-v1\n"; physical(directory, file);
		if (existsSync(marker) && (lstatSync(marker).size !== Buffer.byteLength(markerBytes) || readFileSync(marker, "utf8") !== markerBytes)) throw new Error("JOURNAL_EVIDENCE_INVALID");
		if (!existsSync(file) && [marker, file + "-wal", file + "-shm"].some(path => existsSync(path)) || existsSync(file) && lstatSync(file).size === 0) throw new Error("JOURNAL_EVIDENCE_MISSING");
		let created = false;
		try { const descriptor = openSync(file, "wx", 0o600); closeSync(descriptor); created = true; } catch (error) { if (error.code !== "EEXIST") throw error; }
		this.db = new DatabaseSync(file);
		try {
			const version = this.db.prepare("PRAGMA user_version").get().user_version, tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
			if (version > 1) throw new Error("JOURNAL_SCHEMA_TOO_NEW");
			if (![0, 1].includes(version) || version === 0 && (!created || tables.length) || version === 1 && JSON.stringify(tables) !== JSON.stringify(["bookmarks", "recorded_events", "recordings"])) throw new Error("JOURNAL_SCHEMA_UNKNOWN");
			if (version === 1) for (const query of ["SELECT id,state,started_at,stopped_at,event_count,byte_count,reason,build FROM recordings LIMIT 0", "SELECT recording_id,sequence,elapsed_ms,value FROM recorded_events LIMIT 0", "SELECT id,recording_id,sequence,tag,created_at FROM bookmarks LIMIT 0"]) this.db.prepare(query).all();
			const descriptor = openSync(file, "r+"); closeSync(descriptor); physical(directory, file);
			this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
			if (version === 0) this.transaction(() => this.db.exec(`CREATE TABLE recordings(id TEXT PRIMARY KEY,state TEXT NOT NULL,started_at TEXT NOT NULL,stopped_at TEXT,event_count INTEGER NOT NULL DEFAULT 0,byte_count INTEGER NOT NULL DEFAULT 0,reason TEXT,build TEXT NOT NULL);
				CREATE UNIQUE INDEX one_recording ON recordings((1)) WHERE state='recording';
				CREATE TABLE recorded_events(recording_id TEXT NOT NULL REFERENCES recordings(id),sequence INTEGER NOT NULL,elapsed_ms INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(recording_id,sequence));
				CREATE TABLE bookmarks(id TEXT PRIMARY KEY,recording_id TEXT NOT NULL,sequence INTEGER NOT NULL,tag TEXT NOT NULL,created_at TEXT NOT NULL,FOREIGN KEY(recording_id,sequence) REFERENCES recorded_events(recording_id,sequence)); PRAGMA user_version=1;`));
			this.db.prepare("UPDATE recordings SET state='interrupted',reason='application_interrupted' WHERE state='recording'").run();
			if (!existsSync(marker)) { const descriptor = openSync(marker, "wx", 0o600); try { writeSync(descriptor, markerBytes); fsyncSync(descriptor); } finally { closeSync(descriptor); } }
		} catch (error) { this.db.close(); throw error; }
	}
	transaction(action) { this.db.exec("BEGIN IMMEDIATE"); try { const result = action(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
	requireWriter() { if (this.closed || this.error) throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); try { this.list(); } catch { this.fail(); throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); } }
	fail() { if (this.error) return; this.error = "JOURNAL_STORAGE_UNAVAILABLE"; this.active = null; this.notify(); }
	list() { return this.db.prepare("SELECT id,state,started_at,stopped_at,event_count,byte_count,reason,build FROM recordings ORDER BY started_at DESC,id DESC LIMIT ?").all(this.limits.recordings).map(row => {
		const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
		if (!idValid(row.id) || !["recording", "stopped", "interrupted"].includes(row.state) || !date(row.started_at) || row.stopped_at !== null && !date(row.stopped_at) || ![null, "user_stopped", "application_exit", "event_limit", "application_interrupted"].includes(row.reason) || !Number.isSafeInteger(row.event_count) || row.event_count < 0 || row.event_count > this.limits.events || !Number.isSafeInteger(row.byte_count) || row.byte_count < 0 || row.byte_count > this.limits.eventBytes * this.limits.events) throw new Error("JOURNAL_RECORD_INVALID");
		return { id: row.id, state: this.error && row.state === "recording" ? "interrupted" : row.state, startedAt: row.started_at, stoppedAt: row.stopped_at, events: row.event_count, bytes: row.byte_count, reason: this.error && row.state === "recording" ? "storage_unconfirmed" : row.reason, build: build(JSON.parse(row.build)) };
	}); }
	snapshot() { let recordings = []; try { recordings = this.list(); } catch { this.fail(); } return { available: !this.closed && !this.error, error: this.error, activeId: this.active?.id ?? null, scope: "host-events-v1", limits: this.limits, recordings }; }
	start(metadata) {
		this.requireWriter(); if (this.active) throw new Error("JOURNAL_ALREADY_RECORDING");
		if (this.db.prepare("SELECT count(*) AS count FROM recordings").get().count >= this.limits.recordings) throw new Error("JOURNAL_RECORDING_LIMIT");
		const id = randomUUID();
		try { this.db.prepare("INSERT INTO recordings(id,state,started_at,build) VALUES(?,'recording',?,?)").run(id, this.utc(), JSON.stringify(build(metadata))); }
		catch { this.fail(); throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); }
		this.active = { id, started: this.now(), lastElapsed: 0, projector: new JournalProjector(), last: null }; this.append(point("start")); this.notify(); return this.snapshot();
	}
	capture(event, context) { if (!this.active || this.error || this.closed) return; const value = this.active.projector.project(event, context); if (value) this.append(value); }
	append(value) {
		if (!this.active || this.error || this.closed) return;
		const encoded = JSON.stringify(validateJournalPoint(value)); if (Buffer.byteLength(encoded) > this.limits.eventBytes) throw new Error("JOURNAL_EVENT_LIMIT");
		if (encoded === this.active.last) return;
		const id = this.active.id, row = this.db.prepare("SELECT event_count FROM recordings WHERE id=?").get(id);
		if (row.event_count >= this.limits.events - 1 && value.kind !== "stop" && value.kind !== "limit") { this.stop("event_limit"); return; }
		const elapsed = Math.max(this.active.lastElapsed, Math.floor(Math.max(0, this.now() - this.active.started)));
		try { this.transaction(() => { this.db.prepare("INSERT INTO recorded_events(recording_id,sequence,elapsed_ms,value) VALUES(?,?,?,?)").run(id, row.event_count + 1, elapsed, encoded); this.db.prepare("UPDATE recordings SET event_count=event_count+1,byte_count=byte_count+? WHERE id=?").run(Buffer.byteLength(encoded), id); }); }
		catch { this.fail(); return; }
		this.active.last = encoded; this.active.lastElapsed = elapsed; this.notify();
	}
	stop(reason = "user_stopped") {
		this.requireWriter(); if (!this.active) throw new Error("JOURNAL_NOT_RECORDING");
		if (!["user_stopped", "application_exit", "event_limit"].includes(reason)) throw new Error("JOURNAL_REASON_INVALID");
		this.append(point(reason === "event_limit" ? "limit" : "stop")); if (!this.active) throw new Error("JOURNAL_STORAGE_UNAVAILABLE");
		try { this.db.prepare("UPDATE recordings SET state='stopped',stopped_at=?,reason=? WHERE id=?").run(this.utc(), reason, this.active.id); }
		catch { this.fail(); throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); }
		this.active = null; this.notify(); return this.snapshot();
	}
	bookmark(id, sequence, tag) {
		this.requireWriter(); if (!this.active || id !== this.active.id || !idValid(id) || !Number.isSafeInteger(sequence) || sequence < 1 || !bookmarkTags.includes(tag)) throw new Error("JOURNAL_BOOKMARK_INVALID");
		if (this.db.prepare("SELECT 1 FROM bookmarks WHERE recording_id=? AND sequence=? AND tag=?").get(id, sequence, tag)) return this.read(id);
		if (this.db.prepare("SELECT count(*) AS count FROM bookmarks WHERE recording_id=?").get(id).count >= this.limits.bookmarks) throw new Error("JOURNAL_BOOKMARK_LIMIT");
		if (!this.db.prepare("SELECT 1 FROM recorded_events WHERE recording_id=? AND sequence=?").get(id, sequence)) throw new Error("JOURNAL_EVENT_NOT_FOUND");
		try { this.db.prepare("INSERT INTO bookmarks(id,recording_id,sequence,tag,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), id, sequence, tag, this.utc()); }
		catch { this.fail(); throw new Error("JOURNAL_STORAGE_UNAVAILABLE"); }
		this.notify(); return this.read(id);
	}
	sampleClock(id, priorCount = 0) {
		if (this.closed || this.error || this.active?.id !== id) return null;
		try {
			const { events } = this.read(id), elapsedMs = Math.max(this.active.lastElapsed, Math.floor(Math.max(0, this.now() - this.active.started)));
			return { journalId: id, elapsedMs, eventCount: events.length, prefixSha256: journalPrefixHash(id, events), priorCount, priorSha256: journalPrefixHash(id, events, priorCount) };
		} catch { this.fail(); return null; }
	}
	read(id) {
		if (!idValid(id)) throw new Error("JOURNAL_RECORDING_INVALID");
		const recording = this.list().find(row => row.id === id); if (!recording) throw new Error("JOURNAL_RECORDING_NOT_FOUND");
		const events = this.db.prepare("SELECT sequence,elapsed_ms,value FROM recorded_events WHERE recording_id=? ORDER BY sequence LIMIT ?").all(id, this.limits.events + 1);
		if (events.length !== recording.events || events.length > this.limits.events) throw new Error("JOURNAL_RECORD_INVALID");
		let last = 0;
		const values = events.map((row, index) => { if (row.sequence !== index + 1 || !Number.isSafeInteger(row.elapsed_ms) || row.elapsed_ms < last || Buffer.byteLength(row.value) > this.limits.eventBytes) throw new Error("JOURNAL_RECORD_INVALID"); last = row.elapsed_ms; return { sequence: row.sequence, elapsedMs: row.elapsed_ms, ...validateJournalPoint(JSON.parse(row.value)) }; });
		const bookmarks = this.db.prepare("SELECT id,sequence,tag,created_at FROM bookmarks WHERE recording_id=? ORDER BY sequence,id LIMIT ?").all(id, this.limits.bookmarks + 1);
		if (bookmarks.length > this.limits.bookmarks || bookmarks.some(row => !idValid(row.id) || !bookmarkTags.includes(row.tag) || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence > values.length)) throw new Error("JOURNAL_RECORD_INVALID");
		return { recording, events: values, bookmarks: bookmarks.map(row => ({ id: row.id, sequence: row.sequence, tag: row.tag, createdAt: row.created_at })), readOnly: recording.state !== "recording" || this.active?.id !== id, executionAuthority: false };
	}
	close() { if (this.closed) return; this.closed = true; this.db.close(); }
}
