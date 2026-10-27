import { DatabaseSync } from "node:sqlite";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { matchResearchBudget, nativeResearchStateHash, researchId } from "./research-preview.mjs";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const opaque = (value) => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
const stateHash = (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const tick = (value) => Number.isSafeInteger(value) && value >= 0;
const queue = (value) => Array.isArray(value) && value.length <= 64 && value.every(positive);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const pendingStates = "'recorded','accepted','unknown'";
const auditReasons = ["ACCEPTANCE_BINDING_MISMATCH", "ORIGINAL_ACTION_BINDING_MISMATCH", "NATIVE_OUTCOME_REQUIRES_AUDIT"];

// Durable bounded research ledger. Trusted host ports own transport and approval provenance.
export class GameIntentLedger {
	#authority; #prepareResearch; #readResearchProof; #preparing = new Map(); #reading = new Map(); #plans = new Map(); #faulted = false;
	constructor(file, { approvalAuthority, prepareResearch, readResearchProof, now = () => Date.now() } = {}) {
		if (!approvalAuthority || typeof approvalAuthority !== "object") throw new Error("TRUSTED_APPROVAL_AUTHORITY_REQUIRED");
		if (typeof prepareResearch !== "function") throw new Error("TRUSTED_RESEARCH_PREPARER_REQUIRED");
		if (typeof readResearchProof !== "function") throw new Error("TRUSTED_RESEARCH_READER_REQUIRED");
		this.#authority = approvalAuthority; this.#prepareResearch = prepareResearch; this.#readResearchProof = readResearchProof; this.now = now; this.bootId = randomUUID(); mkdirSync(dirname(file), { recursive: true }); this.db = new DatabaseSync(file);
		try {
			const version = this.db.prepare("PRAGMA user_version").get().user_version;
			if (![0, 1, 2].includes(version)) throw new Error("GAME_LEDGER_SCHEMA_UNSUPPORTED");
			if (version === 0 && this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n) throw new Error("GAME_LEDGER_SCHEMA_UNKNOWN");
			// Validate the old structure before journal-mode or migration writes.
			// A rejected legacy file must not already have been promoted to v2.
			if (version > 0) {
				const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name).filter(name => !name.startsWith("sqlite_"));
				const expected = version === 1 ? ["game_gate", "game_intents", "game_tasks"] : ["game_gate", "game_intents", "game_task_details", "game_task_events", "game_tasks"];
				if (!equal(tables, expected)) throw new Error("GAME_LEDGER_SCHEMA_UNKNOWN");
				for (const query of [
					"SELECT id,scope,state,preview_hash,preview_boot,expires_at,approval_id,approval_at FROM game_tasks LIMIT 0",
					"SELECT id,task_id,idempotency_key,state,action_id,acceptance,terminal FROM game_intents LIMIT 0",
					"SELECT id,intent_id,reason FROM game_gate LIMIT 0",
					...(version === 2 ? ["SELECT task_id,body FROM game_task_details LIMIT 0", "SELECT sequence,task_id,kind,body FROM game_task_events LIMIT 0"] : []),
				]) this.db.prepare(query).all();
			}
			// An engine read-only fallback must not advertise usable task storage.
			// This opens no transaction and changes no original ledger bytes.
			if (file !== ":memory:") { const descriptor = openSync(file, "r+"); closeSync(descriptor); }
			this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;");
			if (version === 0) this.db.exec(`BEGIN IMMEDIATE;
				CREATE TABLE game_tasks(id TEXT PRIMARY KEY, scope TEXT NOT NULL, state TEXT NOT NULL, preview_hash TEXT, preview_boot TEXT, expires_at INTEGER, approval_id TEXT, approval_at INTEGER);
				CREATE TABLE game_intents(id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES game_tasks(id), idempotency_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('recorded','accepted','unknown','completed')), action_id TEXT, acceptance TEXT, terminal TEXT);
				CREATE UNIQUE INDEX one_pending_game_intent ON game_intents((1)) WHERE state IN (${pendingStates});
				CREATE TABLE game_gate(id INTEGER PRIMARY KEY CHECK(id=1), intent_id TEXT NOT NULL, reason TEXT NOT NULL);
				PRAGMA user_version=1; COMMIT;`);
			if (version < 2) this.db.exec(`BEGIN IMMEDIATE;
				CREATE TABLE game_task_details(task_id TEXT PRIMARY KEY REFERENCES game_tasks(id), body TEXT NOT NULL);
				CREATE TABLE game_task_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES game_tasks(id), kind TEXT NOT NULL, body TEXT NOT NULL);
				PRAGMA user_version=2; COMMIT;`);
			this.db.prepare("SELECT id,scope,state,preview_hash,preview_boot,expires_at,approval_id,approval_at FROM game_tasks LIMIT 1").all();
			this.db.prepare("SELECT id,task_id,idempotency_key,state,action_id,acceptance,terminal FROM game_intents LIMIT 1").all();
		} catch (error) { this.db.close(); throw error; }
	}
	#transaction(action) {
		if (this.#faulted) throw new Error("GAME_LEDGER_STORAGE_UNAVAILABLE");
		try { this.db.exec("BEGIN IMMEDIATE"); const value = action(); this.db.exec("COMMIT"); return value; }
		catch (error) { try { this.db.exec("ROLLBACK"); } catch {} if (String(error.code ?? "").startsWith("ERR_SQLITE")) { this.#faulted = true; throw new Error("GAME_LEDGER_STORAGE_UNAVAILABLE"); } throw error; }
	}
	get storageAvailable() { return !this.#faulted && !this.closed; }
	#task(id) { const value = this.db.prepare("SELECT * FROM game_tasks WHERE id=?").get(id); if (!value) throw new Error("GAME_TASK_NOT_FOUND"); return { ...value, scope: JSON.parse(value.scope) }; }
	#intent(id) { const value = this.db.prepare("SELECT * FROM game_intents WHERE id=?").get(id); if (!value) throw new Error("GAME_INTENT_NOT_FOUND"); return value; }
	#context(scope, context, writing = false) {
		if (!context || context.bridgeInstanceId !== scope.bridgeInstanceId || context.sessionId !== scope.sessionId || context.planetId !== scope.planetId || context.owned !== true || context.accessRestricted !== false) throw new Error("GAME_CONTEXT_CHANGED");
		if (writing && (context.writeHealth !== "healthy" || context.selectionStateHash !== scope.selectionStateHash || !Number.isFinite(context.observedAt) || Math.abs(this.now() - context.observedAt) > 2000)) throw new Error("FRESH_GAME_CONTEXT_REQUIRED");
	}
	createResearchTask(input) {
		if (!input || !opaque(input.bridgeInstanceId) || !opaque(input.sessionId) || !researchId(input.planetId) || !researchId(input.techId) || !tick(input.capturedAtGameTick) || !stateHash(input.selectionStateHash)) throw new Error("INVALID_RESEARCH_TASK_SCOPE");
		const scope = { kind: "select-research", bridgeInstanceId: input.bridgeInstanceId, sessionId: input.sessionId, planetId: input.planetId, techId: input.techId, capturedAtGameTick: input.capturedAtGameTick, selectionStateHash: input.selectionStateHash, maximumAcceptedWrites: 1 };
		nativeResearchStateHash(scope);
		const id = randomUUID(); this.#transaction(() => this.db.prepare("INSERT INTO game_tasks(id,scope,state) VALUES(?,?,'draft')").run(id, JSON.stringify(scope))); return this.task(id);
	}
	async prepare(id) {
		const task = this.#transaction(() => { const value = this.#task(id); if (!["draft", "awaiting_approval", "approved"].includes(value.state)) throw new Error("RESEARCH_PREVIEW_REJECTED"); this.db.prepare("UPDATE game_tasks SET state='preparing',approval_id=NULL,approval_at=NULL,preview_hash=NULL WHERE id=?").run(id); return value; });
		this.#plans.delete(id);
		const request = Object.freeze({ requestId: randomUUID(), actionKind: "select-research", arguments: Object.freeze({ sessionId: task.scope.sessionId, planetId: task.scope.planetId, techId: task.scope.techId, expectedSelectionStateHash: task.scope.selectionStateHash, stateHashVersion: 1, prioritizeQueued: false }) });
		this.#preparing.set(id, request);
		try {
			const reply = await this.#prepareResearch(request);
			if (this.#preparing.get(id) !== request || !equal(reply?.request, request)) throw new Error("RESEARCH_PREPARE_CORRELATION_MISMATCH");
			return this.#preview(id, reply.plan, reply.researchBudget);
		} catch (error) { if (this.#preparing.get(id) === request) { try { this.#transaction(() => this.db.prepare("UPDATE game_tasks SET state='blocked' WHERE id=? AND state='preparing'").run(id)); } catch {} } throw new Error(/^[A-Z_]+$/.test(error?.message) ? error.message : "RESEARCH_PREPARE_FAILED"); }
		finally { if (this.#preparing.get(id) === request) this.#preparing.delete(id); }
	}
	#preview(id, plan, observedBudget) {
		const result = this.#transaction(() => {
		const task = this.#task(id), expiresAt = Date.parse(plan?.expiresAtUtc);
		if (plan?.researchQueueReadbackVersion !== 1) throw new Error("RESEARCH_READBACK_NOT_SUPPORTED");
		if (task.state !== "preparing" || plan?.prepared !== true || plan.actionKind !== "select-research" || plan.commitAllowedNow !== true || plan.stateHashVersion !== 1 || plan.expectedStateHash !== nativeResearchStateHash(task.scope) || typeof plan.planToken !== "string" || plan.planToken.length < 20 || plan.planToken.length > 2048 || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 120000 || !Array.isArray(plan.commitBlockers) || plan.commitBlockers.length) throw new Error("RESEARCH_PREVIEW_REJECTED");
		const researchBudget = matchResearchBudget(plan.itemBudget, observedBudget);
		const previewHash = hash({ scope: task.scope, nativeExpectedStateHash: plan.expectedStateHash, researchQueueReadbackVersion: 1, researchBudget, planFingerprint: hash(plan.planToken), expiresAt });
		this.db.prepare("UPDATE game_tasks SET state='awaiting_approval',preview_hash=?,preview_boot=?,expires_at=?,approval_id=NULL,approval_at=NULL WHERE id=?").run(previewHash, this.bootId, expiresAt, id);
		return { taskId: id, scope: task.scope, previewHash, expiresAt, researchBudget };
		}); this.#plans.set(id, { token: plan.planToken, previewHash: result.previewHash, researchBudget: result.researchBudget }); return result;
	}
	confirmationPreview(id) {
		const task = this.#task(id), plan = this.#plans.get(id);
		if (task.state !== "awaiting_approval" || task.preview_boot !== this.bootId || task.expires_at <= this.now() || plan?.previewHash !== task.preview_hash) throw new Error("FRESH_RESEARCH_PREVIEW_REQUIRED");
		return Object.freeze({ researchBudget: plan.researchBudget });
	}
	approve(authority, id, previewHash) {
		if (authority !== this.#authority) throw new Error("TRUSTED_USER_APPROVAL_REQUIRED");
		return this.#transaction(() => { const task = this.#task(id); if (task.state !== "awaiting_approval" || task.preview_hash !== previewHash || task.preview_boot !== this.bootId || task.expires_at <= this.now() || !this.#plans.has(id)) throw new Error("FRESH_RESEARCH_PREVIEW_REQUIRED"); const approvalId = randomUUID(); this.db.prepare("UPDATE game_tasks SET state='approved',approval_id=?,approval_at=? WHERE id=?").run(approvalId, this.now(), id); return { approvalId, previewHash }; });
	}
	beginIntent(id, previewHash, freshContext) {
		const result = this.#transaction(() => {
			if (this.db.prepare("SELECT 1 FROM game_gate LIMIT 1").get() || this.db.prepare(`SELECT 1 FROM game_intents WHERE state IN (${pendingStates}) LIMIT 1`).get()) throw new Error("UNRESOLVED_GAME_INTENT_BLOCKS_WRITES");
			const task = this.#task(id), plan = this.#plans.get(id); this.#context(task.scope, freshContext, true);
			if (task.state !== "approved" || !task.approval_id || task.preview_hash !== previewHash || task.preview_boot !== this.bootId || task.expires_at <= this.now() || plan?.previewHash !== previewHash) throw new Error("FRESH_RESEARCH_APPROVAL_REQUIRED");
			matchResearchBudget(plan.researchBudget, freshContext.researchBudget);
			const intentId = randomUUID(), idempotencyKey = randomUUID();
			this.db.prepare("INSERT INTO game_intents(id,task_id,idempotency_key,state) VALUES(?,?,?,'recorded')").run(intentId, id, idempotencyKey);
			this.db.prepare("UPDATE game_tasks SET state='intent_recorded' WHERE id=?").run(id);
			return { intentId, idempotencyKey, commit: { sessionId: task.scope.sessionId, planetId: task.scope.planetId, planToken: plan.token, idempotencyKey } };
		});
		this.#plans.delete(id); return result; // Caller may send only after this durable transaction returns.
	}
	markUnknown(id, reason = "COMMIT_RECEIPT_UNAVAILABLE") {
		if (!["COMMIT_RECEIPT_UNAVAILABLE", "ACCEPTANCE_BINDING_MISMATCH", "ORIGINAL_ACTION_BINDING_MISMATCH", "RESEARCH_TERMINAL_PROOF_INCOMPLETE", "ORIGINAL_ACTION_NOT_FOUND"].includes(reason)) reason = "COMMIT_RECEIPT_UNAVAILABLE";
		return this.#transaction(() => { if (this.#intent(id).state !== "completed") this.#unknown(id, reason); });
	}
	#unknown(id, reason) { const intent = this.#intent(id), gate = this.db.prepare("SELECT * FROM game_gate WHERE id=1").get(); if (!auditReasons.includes(gate?.reason)) this.db.prepare("INSERT INTO game_gate(id,intent_id,reason) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET intent_id=excluded.intent_id,reason=excluded.reason").run(id, reason); if (intent.state !== "completed") this.db.prepare("UPDATE game_intents SET state='unknown' WHERE id=?").run(id); this.db.prepare("UPDATE game_tasks SET state='blocked' WHERE id=?").run(intent.task_id); }
	accept(id, receipt) {
		const result = this.#transaction(() => { const intent = this.#intent(id); if (receipt?.accepted !== true || receipt.actionKind !== "select-research" || receipt.idempotencyKey !== intent.idempotency_key || !opaque(receipt.actionId) || intent.action_id && intent.action_id !== receipt.actionId) { this.#unknown(id, "ACCEPTANCE_BINDING_MISMATCH"); return null; } if (intent.action_id === receipt.actionId) return this.intent(id); this.db.prepare("UPDATE game_intents SET action_id=?,state='accepted',acceptance=? WHERE id=?").run(receipt.actionId, JSON.stringify({ accepted: true, actionId: receipt.actionId, actionKind: "select-research", idempotencyKey: receipt.idempotencyKey }), id); this.db.prepare("UPDATE game_tasks SET state='accepted' WHERE id=?").run(intent.task_id); return this.intent(id); });
		if (!result) throw new Error("ACCEPTANCE_BINDING_MISMATCH"); return result;
	}
	reconciliationRequest(id, context) { const intent = this.#intent(id), task = this.#task(intent.task_id); this.#context(task.scope, context); if (!intent.action_id) throw new Error("UNKNOWN_COMMIT_HAS_NO_ACTION_ID"); return { actionId: intent.action_id }; }
	async reconcile(id) {
		if (auditReasons.includes(this.db.prepare("SELECT reason FROM game_gate WHERE id=1").get()?.reason)) throw new Error("INDEPENDENT_GAME_AUDIT_REQUIRED");
		const intent = this.#intent(id), scope = this.#task(intent.task_id).scope;
		if (intent.state === "completed") return this.intent(id);
		if (!intent.action_id) throw new Error("UNKNOWN_COMMIT_HAS_NO_ACTION_ID");
		if (this.#reading.has(id)) throw new Error("ORIGINAL_ACTION_READ_ALREADY_IN_FLIGHT");
		const request = Object.freeze({ requestId: randomUUID(), intentId: id, actionKind: "select-research", actionId: intent.action_id, idempotencyKey: intent.idempotency_key, bridgeInstanceId: scope.bridgeInstanceId, sessionId: scope.sessionId, planetId: scope.planetId });
		this.#reading.set(id, request);
		try { const reply = await this.#readResearchProof(request); if (this.#reading.get(id) !== request || !equal(reply?.request, request)) throw new Error("RESEARCH_READ_CORRELATION_MISMATCH"); return this.#complete(id, reply.terminal, reply.freshProgression, reply.context); }
		catch (error) { if (error?.message === "ORIGINAL_ACTION_BINDING_MISMATCH") { this.#transaction(() => this.#unknown(id, "ORIGINAL_ACTION_BINDING_MISMATCH")); throw new Error("INDEPENDENT_GAME_AUDIT_REQUIRED"); } throw new Error(/^[A-Z_]+$/.test(error?.message) ? error.message : "ORIGINAL_ACTION_READ_FAILED"); }
		finally { if (this.#reading.get(id) === request) this.#reading.delete(id); }
	}
	#complete(id, terminal, freshProgression, context) {
		const result = this.#transaction(() => {
		if (auditReasons.includes(this.db.prepare("SELECT reason FROM game_gate WHERE id=1").get()?.reason)) throw new Error("INDEPENDENT_GAME_AUDIT_REQUIRED");
		const intent = this.#intent(id), task = this.#task(intent.task_id), readback = terminal?.researchQueueReadback;
		if (terminal && (terminal.actionId !== intent.action_id || terminal.actionKind !== "select-research" || terminal.sessionId !== task.scope.sessionId || terminal.planetId !== task.scope.planetId || terminal.idempotencyKey !== intent.idempotency_key)) { this.#unknown(id, "ORIGINAL_ACTION_BINDING_MISMATCH"); return { error: "INDEPENDENT_GAME_AUDIT_REQUIRED" }; }
		this.#context(task.scope, context);
		if (["outcome_unknown", "recovery_required", "action_failed"].includes(terminal?.state) || terminal?.recoveryRequired === true) { this.#unknown(id, "NATIVE_OUTCOME_REQUIRES_AUDIT"); return { error: "INDEPENDENT_GAME_AUDIT_REQUIRED" }; }
		const before = readback?.beforeQueue, after = readback?.afterQueue, current = freshProgression?.techQueue;
		const valid = intent.action_id && terminal?.actionId === intent.action_id && terminal.actionKind === "select-research" && terminal.idempotencyKey === intent.idempotency_key && terminal.sessionId === task.scope.sessionId && terminal.planetId === task.scope.planetId && terminal.terminal === true && terminal.succeeded === true && terminal.state === "completed" && tick(terminal.completedAtGameTick) && terminal.completedAtGameTick >= task.scope.capturedAtGameTick && readback?.inventoryPreserved === true && readback.researchProgressPreserved === true && tick(readback.capturedAtGameTick) && readback.capturedAtGameTick === terminal.completedAtGameTick && queue(before) && queue(after) && !before.includes(task.scope.techId) && equal(after, [...before, task.scope.techId]) && queue(current) && current.includes(task.scope.techId) && equal(current, after.slice(after.length - current.length)) && freshProgression.sessionId === task.scope.sessionId && freshProgression.planetId === task.scope.planetId && tick(freshProgression.capturedAtGameTick) && freshProgression.capturedAtGameTick >= terminal.completedAtGameTick && stateHash(freshProgression.selectionStateHash) && context.selectionStateHash === freshProgression.selectionStateHash && context.writeHealth === "healthy" && tick(context.gameTick) && freshProgression.capturedAtGameTick <= context.gameTick && Number.isFinite(context.observedAt) && Math.abs(this.now() - context.observedAt) <= 2000 && Number.isFinite(freshProgression.observedAt) && Math.abs(this.now() - freshProgression.observedAt) <= 2000;
		if (!valid) { this.#unknown(id, "RESEARCH_TERMINAL_PROOF_INCOMPLETE"); return { error: "RESEARCH_TERMINAL_PROOF_INCOMPLETE" }; }
		this.db.prepare("UPDATE game_intents SET state='completed',terminal=? WHERE id=?").run(JSON.stringify({ actionId: terminal.actionId, completedAtGameTick: terminal.completedAtGameTick, beforeQueue: before, afterQueue: after, freshQueue: current, freshTick: freshProgression.capturedAtGameTick, selectionStateHash: freshProgression.selectionStateHash }), id); this.db.prepare("UPDATE game_tasks SET state='completed' WHERE id=?").run(task.id); this.db.prepare("DELETE FROM game_gate WHERE intent_id=?").run(id); return { value: this.intent(id) };
		}); if (result.error) throw new Error(result.error); return result.value;
	}
	stop(id) { this.#plans.delete(id); this.#preparing.delete(id); return this.#transaction(() => { const intent = this.db.prepare("SELECT id,state FROM game_intents WHERE task_id=?").get(id); this.db.prepare("UPDATE game_tasks SET state=? WHERE id=? AND state<>'completed'").run(intent ? "reconciling" : "cancelled", id); return this.task(id); }); }
	task(id) { const value = this.#task(id); return { id: value.id, state: value.state, scope: value.scope, previewHash: value.preview_hash, expiresAt: value.expires_at, approvalId: value.approval_id }; }
	intent(id) { const value = this.#intent(id); return { intentId: value.id, taskId: value.task_id, state: value.state, idempotencyKey: value.idempotency_key, actionId: value.action_id, acceptance: value.acceptance ? JSON.parse(value.acceptance) : null, terminal: value.terminal ? JSON.parse(value.terminal) : null }; }
	unresolved() { return this.db.prepare(`SELECT id FROM game_intents WHERE state IN (${pendingStates})`).all().map(({ id }) => this.intent(id)); }
	tasks() { return this.db.prepare("SELECT id FROM game_tasks ORDER BY rowid DESC LIMIT 32").all().map(({ id }) => ({ ...this.task(id), details: JSON.parse(this.db.prepare("SELECT body FROM game_task_details WHERE task_id=?").get(id)?.body ?? "{}"), intent: (() => { const value = this.db.prepare("SELECT id FROM game_intents WHERE task_id=?").get(id); return value ? this.intent(value.id) : null; })() })); }
	details(id, value) {
		this.#task(id);
		const body = { mode: value.mode === "observe" ? "observe" : "assist", techName: String(value.techName ?? "").slice(0, 160), prompt: String(value.prompt ?? "").slice(0, 2000), provider: String(value.provider ?? "").slice(0, 256), model: String(value.model ?? "").slice(0, 256), cohortHash: String(value.cohortHash ?? "").slice(0, 64), schemaHash: String(value.schemaHash ?? "").slice(0, 64), playbookHash: String(value.playbookHash ?? "").slice(0, 64), createdAt: this.now() };
		this.#transaction(() => this.db.prepare("INSERT INTO game_task_details(task_id,body) VALUES(?,?)").run(id, JSON.stringify(body)));
	}
	note(id, kind, value = {}) {
		if (!["stage", "assistant", "tool", "error", "result"].includes(kind)) throw new Error("INVALID_GAME_EVENT");
		const body = { at: this.now(), text: String(value.text ?? "").slice(0, 32768), name: String(value.name ?? "").slice(0, 80), code: /^[A-Z0-9_]{1,128}$/.test(value.code ?? "") ? value.code : null };
		this.#transaction(() => { this.#task(id); this.db.prepare("INSERT INTO game_task_events(task_id,kind,body) VALUES(?,?,?)").run(id, kind, JSON.stringify(body)); this.db.prepare("DELETE FROM game_task_events WHERE task_id=? AND sequence NOT IN (SELECT sequence FROM game_task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 200)").run(id, id); });
	}
	events(id) { this.#task(id); return this.db.prepare("SELECT sequence,kind,body FROM game_task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 100").all(id).reverse().map(({ body, ...value }) => ({ ...value, ...JSON.parse(body) })); }
	advised(id) { return this.#transaction(() => { const task = this.#task(id); if (task.state !== "draft") throw new Error("GAME_TASK_NOT_ADVISORY"); this.db.prepare("UPDATE game_tasks SET state='advised' WHERE id=?").run(id); return this.task(id); }); }
	close() { if (this.closed) return; this.closed = true; this.#plans.clear(); this.#preparing.clear(); this.#reading.clear(); this.db.close(); }
}
