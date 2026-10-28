import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const SCHEMA = 1;
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const terminal = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

// Owned by the utility runtime. Renderer state and Pi history are not execution receipts.
export class WorkbenchStore {
	constructor(file) {
		if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(file);
		try {
			const version = this.db.prepare("PRAGMA user_version").get().user_version;
			if (version > SCHEMA) throw new Error("WORKBENCH_SCHEMA_TOO_NEW");
			if (![0, SCHEMA].includes(version)) throw new Error("WORKBENCH_SCHEMA_UNKNOWN");
			const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
			if (version === 0 && tables.length) throw new Error("WORKBENCH_SCHEMA_UNKNOWN");
			if (version === SCHEMA) {
				if (JSON.stringify(tables.filter(name => !name.startsWith("sqlite_"))) !== JSON.stringify(["changes", "events", "invocations", "roots", "tasks", "ui_state"])) throw new Error("WORKBENCH_SCHEMA_UNKNOWN");
				for (const query of [
					"SELECT id,path_key,path,label,can_write,can_execute,metadata,enabled,created_at,updated_at FROM roots LIMIT 0",
					"SELECT id,root_id,kind,state,prompt,response,provider,model,session_file,parent_id,scope,created_at,started_at,finished_at,result,error FROM tasks LIMIT 0",
					"SELECT id,task_id,name,arguments,state,created_at,finished_at,result,error FROM invocations LIMIT 0",
					"SELECT id,task_id,root_id,path,before_text,before_hash,after_text,after_hash,state,created_at,finished_at FROM changes LIMIT 0",
					"SELECT sequence,task_id,kind,value,created_at FROM events LIMIT 0",
					"SELECT key,value FROM ui_state LIMIT 0",
				]) this.db.prepare(query).all();
			}
			// SQLite may silently fall back to read-only. A valid schema alone
			// cannot establish writable task storage; do not create probe records.
			if (file !== ":memory:") { const descriptor = openSync(file, "r+"); closeSync(descriptor); }
			this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
			if (file !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
			if (version === 0) this.transaction(() => {
				this.db.exec(`
					CREATE TABLE roots (
					 id TEXT PRIMARY KEY, path_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL,
					 label TEXT NOT NULL, can_write INTEGER NOT NULL, can_execute INTEGER NOT NULL,
					 metadata TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
					 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
					);
					CREATE TABLE tasks (
					 id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), kind TEXT NOT NULL,
					 state TEXT NOT NULL, prompt TEXT NOT NULL, response TEXT NOT NULL DEFAULT '',
					 provider TEXT, model TEXT, session_file TEXT, parent_id TEXT REFERENCES tasks(id), scope TEXT NOT NULL,
					 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
					 result TEXT, error TEXT
					);
					CREATE UNIQUE INDEX one_active_development_task ON tasks((1))
					 WHERE state IN ('queued','running','cancelling');
					CREATE TABLE invocations (
					 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
					 name TEXT NOT NULL, arguments TEXT NOT NULL, state TEXT NOT NULL,
					 created_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT
					);
					CREATE TABLE changes (
					 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
					 root_id TEXT NOT NULL REFERENCES roots(id), path TEXT NOT NULL,
					 before_text TEXT, before_hash TEXT, after_text TEXT NOT NULL, after_hash TEXT NOT NULL,
					 state TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT
					);
					CREATE TABLE events (
					 sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
					 kind TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL
					);
					CREATE INDEX task_events ON events(task_id,sequence);
					CREATE TABLE ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
					PRAGMA user_version=1;
				`);
			});
		} catch (error) { this.db.close(); throw error; }
	}
	transaction(action) {
		this.db.exec("BEGIN IMMEDIATE");
		try { const result = action(); this.db.exec("COMMIT"); return result; }
		catch (error) { this.db.exec("ROLLBACK"); throw error; }
	}
	close() { this.db.close(); }
	root(id) {
		const row = this.db.prepare("SELECT * FROM roots WHERE id=?").get(id);
		if (!row) throw new Error("WORKSPACE_ROOT_NOT_FOUND");
		return this.rootValue(row);
	}
	rootValue(row) {
		return { id: row.id, path: row.path, label: row.label, canWrite: Boolean(row.can_write), canExecute: Boolean(row.can_execute), enabled: Boolean(row.enabled), metadata: parse(row.metadata, {}), createdAt: row.created_at, updatedAt: row.updated_at };
	}
	roots() { return this.db.prepare("SELECT * FROM roots ORDER BY created_at,id").all().map((row) => this.rootValue(row)); }
	upsertRoot({ pathKey, path, label, canWrite, canExecute, metadata }) {
		const previous = this.db.prepare("SELECT id FROM roots WHERE path_key=?").get(pathKey);
		const id = previous?.id ?? randomUUID(), timestamp = now();
		this.db.prepare(`INSERT INTO roots(id,path_key,path,label,can_write,can_execute,metadata,created_at,updated_at)
			VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(path_key) DO UPDATE SET
			label=excluded.label,can_write=excluded.can_write,can_execute=excluded.can_execute,
			metadata=excluded.metadata,enabled=1,updated_at=excluded.updated_at`).run(id, pathKey, path, label, Number(canWrite), Number(canExecute), json(metadata), timestamp, timestamp);
		return this.root(id);
	}
	updateRootMetadata(id, metadata) {
		this.db.prepare("UPDATE roots SET metadata=?,updated_at=? WHERE id=?").run(json(metadata), now(), id);
		return this.root(id);
	}
	setRootGrants(id, { canWrite, canExecute, enabled = true }) {
		this.root(id);
		this.db.prepare("UPDATE roots SET can_write=?,can_execute=?,enabled=?,updated_at=? WHERE id=?").run(Number(canWrite), Number(canExecute), Number(enabled), now(), id);
		return this.root(id);
	}
	activeTask() {
		const row = this.db.prepare("SELECT id FROM tasks WHERE state IN ('queued','running','cancelling') LIMIT 1").get();
		return row ? this.task(row.id) : null;
	}
	createTask({ rootId, kind, prompt = "", provider, model, parentId, contextPlan }) {
		if (!["agent", "check", "edit", "revert"].includes(kind) || typeof prompt !== "string" || prompt.length > 16000) throw new Error("INVALID_DEVELOPMENT_TASK");
		const root = this.root(rootId);
		if (!root.enabled) throw new Error("WORKSPACE_ROOT_DISABLED");
		return this.transaction(() => {
			if (this.activeTask()) throw new Error("DEVELOPMENT_TASK_ALREADY_RUNNING");
			const id = randomUUID();
			this.db.prepare("INSERT INTO tasks(id,root_id,kind,state,prompt,provider,model,parent_id,scope,created_at) VALUES(?,?,?,'queued',?,?,?,?,?,?)").run(id, rootId, kind, prompt, provider ?? null, model ?? null, parentId ?? null, json({ branch: root.metadata.branch ?? null, sha: root.metadata.sha ?? null, ...(contextPlan ? { context: contextPlan } : {}) }), now());
			this.event(id, "task", { state: "queued" });
			return this.task(id);
		});
	}
	task(id, { privateFields = false } = {}) {
		const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
		if (!row) throw new Error("DEVELOPMENT_TASK_NOT_FOUND");
		return { id: row.id, rootId: row.root_id, kind: row.kind, state: row.state, prompt: row.prompt, response: row.response, provider: row.provider, model: row.model, parentId: row.parent_id, scope: parse(row.scope, {}),
			createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, result: parse(row.result), error: row.error,
			...(privateFields ? { sessionFile: row.session_file } : {}) };
	}
	tasks(rootId) {
		const rows = rootId ? this.db.prepare("SELECT id FROM tasks WHERE root_id=? ORDER BY created_at DESC,id DESC LIMIT 100").all(rootId) : this.db.prepare("SELECT id FROM tasks ORDER BY created_at DESC,id DESC LIMIT 100").all();
		return rows.map((row) => this.task(row.id));
	}
	setTaskState(id, state, { result = null, error = null } = {}) {
		const previous = this.task(id);
		const allowed = { queued: ["running", "cancelled", "interrupted"], running: ["succeeded", "failed", "cancelling", "cancelled", "interrupted"], cancelling: ["cancelled", "failed", "interrupted"] };
		if (!allowed[previous.state]?.includes(state)) throw new Error("INVALID_TASK_TRANSITION");
		this.db.prepare("UPDATE tasks SET state=?,started_at=COALESCE(started_at,?),finished_at=?,result=?,error=? WHERE id=?").run(state, state === "running" ? now() : previous.startedAt, terminal.has(state) ? now() : null, json(result), error, id);
		this.event(id, "task", { state, error });
		return this.task(id);
	}
	setSession(id, file) { this.task(id); this.db.prepare("UPDATE tasks SET session_file=? WHERE id=?").run(file, id); }
	setResponse(id, text) {
		if (typeof text !== "string" || text.length > 131072) throw new Error("DEVELOPMENT_RESPONSE_TOO_LARGE");
		this.db.prepare("UPDATE tasks SET response=? WHERE id=?").run(text, id);
	}
	beginInvocation(taskId, name, summary) {
		if (this.task(taskId).state !== "running") throw new Error("TASK_NOT_RUNNING");
		const id = randomUUID();
		this.db.prepare("INSERT INTO invocations(id,task_id,name,arguments,state,created_at) VALUES(?,?,?,?,'prepared',?)").run(id, taskId, name, json(summary), now());
		return id;
	}
	finishInvocation(id, { result = null, error = null, unknown = false } = {}) {
		const state = unknown ? "unknown" : error ? "failed" : "completed";
		this.db.prepare("UPDATE invocations SET state=?,finished_at=?,result=?,error=? WHERE id=? AND state='prepared'").run(state, now(), json(result), error, id);
	}
	invocations(taskId) {
		return this.db.prepare("SELECT * FROM invocations WHERE task_id=? ORDER BY created_at,id").all(taskId).map((row) => ({ id: row.id, name: row.name, arguments: parse(row.arguments), state: row.state, createdAt: row.created_at, finishedAt: row.finished_at, result: parse(row.result), error: row.error }));
	}
	unknownCommand() {
		return this.db.prepare("SELECT i.task_id AS taskId,t.state AS taskState FROM invocations i JOIN tasks t ON t.id=i.task_id WHERE i.name='workspace_check' AND i.state='unknown' ORDER BY i.created_at,i.id LIMIT 1").get() ?? null;
	}
	prepareChange({ taskId, rootId, path, beforeText, beforeHash, afterText, afterHash }) {
		const id = randomUUID();
		this.db.prepare("INSERT INTO changes(id,task_id,root_id,path,before_text,before_hash,after_text,after_hash,state,created_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?)").run(id, taskId, rootId, path, beforeText, beforeHash, afterText, afterHash, now());
		return id;
	}
	finishChange(id, state) {
		if (!["applied", "reverted", "failed", "unknown"].includes(state)) throw new Error("INVALID_CHANGE_STATE");
		this.db.prepare("UPDATE changes SET state=?,finished_at=? WHERE id=?").run(state, now(), id);
	}
	changes(taskId) {
		return this.db.prepare("SELECT * FROM changes WHERE task_id=? ORDER BY created_at,id").all(taskId).map((row) => ({ id: row.id, taskId: row.task_id, rootId: row.root_id, path: row.path, beforeText: row.before_text, beforeHash: row.before_hash, afterText: row.after_text, afterHash: row.after_hash, state: row.state, createdAt: row.created_at }));
	}
	references(taskId) {
		this.task(taskId);
		const rows = this.db.prepare("SELECT value FROM events WHERE task_id=? AND kind='reference' ORDER BY sequence LIMIT 33").all(taskId);
		if (rows.length > 32) throw new Error("TASK_REFERENCE_HISTORY_CORRUPT");
		return rows.map(row => {
			const value = parse(row.value);
			if (!value || value.version !== 1 || value.taskId !== taskId || typeof value.id !== "string" || !value.id || value.id.length > 80 || typeof value.rootId !== "string" || !value.rootId || value.rootId.length > 80 || typeof value.path !== "string" || !value.path || value.path.length > 2048 || typeof value.label !== "string" || !value.label.trim() || value.label.length > 80 || /[\x00-\x1f]/.test(value.label) || !/^[a-f0-9]{40}$/.test(value.revision) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("TASK_REFERENCE_HISTORY_CORRUPT");
			return value;
		});
	}
	attachReference(taskId, reference) {
		return this.transaction(() => {
			const previous = this.references(taskId), duplicate = previous.find(value => value.rootId === reference.rootId && value.path === reference.path && value.revision === reference.revision);
			if (duplicate) return duplicate;
			if (previous.length >= 32) throw new Error("TASK_REFERENCE_LIMIT");
			const value = { ...reference, version: 1, taskId, id: randomUUID(), createdAt: now() };
			this.event(taskId, "reference", value);
			return value;
		});
	}
	wasCreated(rootId, path) { return Boolean(this.db.prepare("SELECT 1 FROM changes WHERE root_id=? AND path=? AND before_text IS NULL AND state='applied' LIMIT 1").get(rootId, path)); }
	createdPaths(rootId) { return this.db.prepare("SELECT DISTINCT path FROM changes WHERE root_id=? AND before_text IS NULL AND state='applied'").all(rootId).map((row) => row.path); }
	event(taskId, kind, value) {
		const encoded = json(value);
		if (encoded.length > 65536) throw new Error("DEVELOPMENT_EVENT_TOO_LARGE");
		const result = this.db.prepare("INSERT INTO events(task_id,kind,value,created_at) VALUES(?,?,?,?)").run(taskId ?? null, kind, encoded, now());
		return Number(result.lastInsertRowid);
	}
	events(taskId, after = 0) {
		if (!Number.isSafeInteger(after) || after < 0) throw new Error("INVALID_EVENT_CURSOR");
		return this.db.prepare("SELECT * FROM events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 500").all(taskId, after).map((row) => ({ sequence: row.sequence, kind: row.kind, value: parse(row.value), createdAt: row.created_at }));
	}
	usage(taskId) { return parse(this.db.prepare("SELECT value FROM events WHERE task_id=? AND kind='usage' ORDER BY sequence DESC LIMIT 1").get(taskId)?.value); }
	context(taskId) { return parse(this.db.prepare("SELECT value FROM events WHERE task_id=? AND kind='context' ORDER BY sequence DESC LIMIT 1").get(taskId)?.value); }
	usageRows() {
		return this.db.prepare(`SELECT t.provider,t.model,
			(SELECT CASE WHEN length(value)<=65536 THEN value ELSE 'false' END FROM events WHERE task_id=t.id AND kind='usage' ORDER BY sequence DESC LIMIT 1) AS usage,
			(SELECT CASE WHEN length(value)<=65536 THEN value ELSE 'false' END FROM events WHERE task_id=t.id AND kind='context' ORDER BY sequence DESC LIMIT 1) AS context
			FROM tasks t WHERE t.kind='agent' ORDER BY t.rowid DESC LIMIT 257`).all();
	}
	ui(key) { return parse(this.db.prepare("SELECT value FROM ui_state WHERE key=?").get(key)?.value); }
	saveUi(key, value) {
		if (typeof key !== "string" || key.length > 160 || json(value).length > 262144) throw new Error("UI_STATE_TOO_LARGE");
		this.db.prepare("INSERT INTO ui_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, json(value));
	}
	recoverInterrupted() {
		return this.transaction(() => {
			const unfinished = this.db.prepare("SELECT id FROM tasks WHERE state IN ('queued','running','cancelling')").all();
			for (const { id } of unfinished) {
				this.db.prepare("UPDATE invocations SET state='unknown',finished_at=?,error='RUNTIME_INTERRUPTED' WHERE task_id=? AND state='prepared'").run(now(), id);
				this.db.prepare("UPDATE changes SET state='unknown',finished_at=? WHERE task_id=? AND state='prepared'").run(now(), id);
				this.setTaskState(id, "interrupted", { error: "RUNTIME_INTERRUPTED_NO_AUTOMATIC_REPLAY" });
			}
			return unfinished.length;
		});
	}
}
