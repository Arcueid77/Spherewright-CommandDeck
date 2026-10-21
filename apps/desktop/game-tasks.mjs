import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GameIntentLedger } from "./game-intent-ledger.mjs";
import { ResearchAdapter } from "./research-adapter.mjs";
import { positive, opaque } from "./research-contract.mjs";

const codeOf = (error) => /^[A-Z0-9_]{1,128}$/.test(error?.message) ? error.message : "GAME_TASK_FAILED";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// One host coordinator; model tools only observe and propose. Neither can approve or commit.
export class GameTasks {
	#authority; #approvalAuthority = {}; #confirmations = new Map();
	constructor({ directory, bridge, researchAuthority, approvalAuthority, freezeDevelopment, releaseDevelopment, planner, emit = () => {}, now = () => Date.now(), pollMilliseconds = 15000, syntheticOnly = false }) {
		if (!approvalAuthority || typeof planner !== "function") throw new Error("TRUSTED_GAME_HOST_REQUIRED");
		this.#authority = researchAuthority; this.hostApproval = approvalAuthority; this.bridge = bridge; this.freezeDevelopment = freezeDevelopment; this.releaseDevelopment = releaseDevelopment; this.planner = planner; this.emit = emit; this.now = now; this.pollMilliseconds = pollMilliseconds;
		this.syntheticOnly = syntheticOnly; this.phase = "idle"; this.currentTaskId = null; this.error = null; this.operation = null; this.closing = false; this.developmentHeld = false; this.bridgeLease = null; this.adapter = null; this.controller = null;
		this.ledger = new GameIntentLedger(join(directory, "game-tasks.sqlite"), { approvalAuthority: this.#approvalAuthority, now,
			prepareResearch: (request) => { const task = this.ledger.tasks().find((task) => task.id === this.currentTaskId); if (!this.adapter || !task) throw new Error("RESEARCH_ADAPTER_UNAVAILABLE"); return this.adapter.prepareResearch(request, task.scope); },
			readResearchProof: (request) => { if (!this.adapter) throw new Error("RESEARCH_ADAPTER_UNAVAILABLE"); return this.adapter.readResearchProof(request); },
		});
		const pending = this.ledger.unresolved();
		if (pending.length) { this.currentTaskId = pending[0].taskId; this.phase = "blocked"; this.error = "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES"; }
		else this.currentTaskId = this.ledger.tasks()[0]?.id ?? null;
	}
	async initialize() { if (this.ledger.unresolved().length) { await this.freezeDevelopment(); this.developmentHeld = true; } }
	snapshot() {
		const tasks = this.ledger.tasks();
		const catalog = this.catalogue ? { id: this.catalogue.id, planetId: this.catalogue.context.planetId, capturedAtGameTick: this.catalogue.capturedAtGameTick, expiresAt: this.catalogue.expiresAt, items: this.catalogue.items, truncated: this.catalogue.truncated } : null;
		return { busy: Boolean(this.operation), phase: this.phase, currentTaskId: this.currentTaskId, error: this.error, developmentFrozen: this.developmentHeld, unresolved: this.ledger.unresolved(), tasks, events: this.currentTaskId ? this.ledger.events(this.currentTaskId) : [], nativeInputExclusion: false, syntheticOnly: this.syntheticOnly, catalog };
	}
	#note(kind, value) { if (this.currentTaskId) this.ledger.note(this.currentTaskId, kind, value); this.emit(); }
	#stage(phase) { this.phase = phase; this.#note("stage", { text: phase }); }
	#notStopped() { if (this.closing || this.controller?.signal.aborted) throw new Error("GAME_TASK_STOPPED"); }
	#launch(phase, action) {
		if (this.operation) throw new Error("GAME_TASK_BUSY");
		this.error = null; this.phase = phase;
		const operation = {};
		this.operation = operation;
		operation.done = Promise.resolve().then(action).catch((error) => {
			this.error = codeOf(error); this.phase = this.ledger.unresolved().length ? "blocked" : this.controller?.signal.aborted ? "cancelled" : "failed";
			try { this.#note("error", { code: this.error }); } catch { this.error = "GAME_LEDGER_STORAGE_UNAVAILABLE"; }
		}).finally(async () => {
			try { if (!this.ledger.unresolved().length && !["awaiting_approval", "planning", "preparing"].includes(this.phase)) await this.#release(); }
			catch { this.phase = "blocked"; this.error = "DEVELOPMENT_GATE_RELEASE_UNCONFIRMED"; }
			this.operation = null; this.emit();
		});
		this.emit(); return this.snapshot();
	}
	async #reserve() {
		if (!this.developmentHeld) { await this.freezeDevelopment(); this.developmentHeld = true; }
		if (this.closing) throw new Error("GAME_TASK_STOPPED");
		if (!this.bridgeLease) {
			this.bridgeLease = this.bridge.acquireResearch(this.#authority);
			this.adapter = new ResearchAdapter({ ...this.bridgeLease, authority: this.#authority, now: this.now });
		}
	}
	async #release() {
		if (this.bridgeLease) { this.bridge.releaseResearch(this.bridgeLease); this.bridgeLease = null; this.adapter = null; }
		if (this.developmentHeld) { await this.releaseDevelopment(); this.developmentHeld = false; }
	}
	catalog() {
		if (this.closing || this.operation || this.bridgeLease || this.developmentHeld || this.ledger.unresolved().length) throw new Error("GAME_TASK_START_BLOCKED");
		this.currentTaskId = null; this.catalogue = null; this.controller = new AbortController();
		return this.#launch("reading_catalog", async () => {
			await this.#reserve(); this.#notStopped();
			const value = await this.adapter.observe(undefined, { writing: false }); this.#notStopped();
			const all = value.progression.technologies.filter((tech) => !tech.unlocked && !tech.isQueued && !value.progression.techQueue.includes(tech.techId));
			this.catalogue = { id: randomUUID(), context: value.context, binding: this.adapter.binding, capturedAtGameTick: value.progression.capturedAtGameTick, expiresAt: this.now() + 60000, truncated: all.length > 512, items: all.slice(0, 512).map((tech) => ({ techId: tech.techId, name: tech.name, prerequisitesObservedComplete: tech.prerequisiteTechIds.every((id) => value.progression.technologies.some((prerequisite) => prerequisite.techId === id && prerequisite.unlocked)) })) };
			this.#stage("catalog_ready");
		});
	}
	start(args) {
		if (this.closing || this.operation || this.bridgeLease || this.developmentHeld || this.ledger.unresolved().length) throw new Error("GAME_TASK_START_BLOCKED");
		if (!args || !["observe", "assist"].includes(args.mode) || !positive(args.techId) || !opaque(args.providerId) || typeof args.modelId !== "string" || !args.modelId.length || args.modelId.length > 256 || typeof args.prompt !== "string" || args.prompt.length > 2000) throw new Error("INVALID_GAME_TASK");
		const catalog = args.catalogId ? this.catalogue : null;
		if (args.catalogId && (!catalog || catalog.id !== args.catalogId || catalog.expiresAt <= this.now() || !catalog.items.some((tech) => tech.techId === args.techId))) throw new Error("FRESH_RESEARCH_CATALOG_REQUIRED");
		this.currentTaskId = null; this.controller = new AbortController(); this.#confirmations.clear();
		return this.#launch("observing", async () => {
			await this.#reserve(); this.#notStopped();
			if (catalog && (catalog.binding.cohortHash !== this.adapter.binding.cohortHash || catalog.binding.schemaHash !== this.adapter.binding.schemaHash)) throw new Error("FRESH_RESEARCH_CATALOG_REQUIRED");
			const playbook = await this.adapter.playbook(), observed = await this.adapter.observe(catalog?.context, { player: true, writing: args.mode === "assist" }); this.#notStopped();
			const technology = observed.progression.technologies.find((tech) => tech.techId === args.techId);
			if (!technology || args.mode === "assist" && (technology.unlocked || technology.isQueued || observed.progression.techQueue.includes(args.techId))) throw new Error("RESEARCH_TARGET_NOT_ELIGIBLE");
			const task = this.ledger.createResearchTask({ ...observed.context, techId: args.techId, capturedAtGameTick: observed.progression.capturedAtGameTick }); this.currentTaskId = task.id;
			this.ledger.details(task.id, { ...this.adapter.binding, mode: args.mode, techName: technology.name, prompt: args.prompt, provider: args.providerId, model: args.modelId, playbookHash: playbook.sha256 });
			this.#stage("planning");
			const result = await this.planner({ task, mode: args.mode, prompt: args.prompt, providerId: args.providerId, modelId: args.modelId, playbook: playbook.text, observation: observed.progression, signal: this.controller.signal,
				observe: () => this.observeForModel(task.id), event: (kind, value) => this.#note(kind, value) });
			this.#notStopped();
			if (args.mode === "observe") { this.ledger.advised(task.id); this.#stage("advised"); return; }
			if (result?.proposedTechId !== args.techId) throw new Error("MODEL_DID_NOT_PROPOSE_SCOPED_RESEARCH");
			this.#stage("preparing"); await this.ledger.prepare(task.id); this.#notStopped(); this.#stage("awaiting_approval");
		});
	}
	async observeForModel(taskId) {
		if (this.phase !== "planning" || taskId !== this.currentTaskId || !this.operation || !this.adapter) throw new Error("GAME_MODEL_TOOL_UNAVAILABLE");
		this.#notStopped();
		const task = this.ledger.tasks().find((value) => value.id === taskId);
		const value = await this.adapter.observe(task.scope, { writing: task.details.mode === "assist" }); this.#notStopped();
		return value.progression;
	}
	profileTask(taskId) {
		if (this.phase !== "planning" || taskId !== this.currentTaskId || !this.operation || this.closing || this.controller?.signal.aborted) throw new Error("PROTECTED_PROFILE_REQUEST_REJECTED");
		const task = this.ledger.tasks().find((value) => value.id === taskId);
		return { id: taskId, kind: "agent", state: "running", provider: task.details.provider, model: task.details.model };
	}
	plannerEvent(taskId, kind, value) { if (taskId === this.currentTaskId && this.phase === "planning" && this.operation && !this.closing && !this.controller?.signal.aborted) this.#note(kind, value); }
	confirmation(taskId, uiEpoch) {
		if (this.closing || this.operation || this.phase !== "awaiting_approval" || taskId !== this.currentTaskId || !Number.isSafeInteger(uiEpoch) || uiEpoch <= 0) throw new Error("GAME_CONFIRMATION_UNAVAILABLE");
		const task = this.ledger.task(taskId);
		if (task.state !== "awaiting_approval" || task.expiresAt <= this.now()) throw new Error("FRESH_RESEARCH_PREVIEW_REQUIRED");
		this.#confirmations.clear(); const nonce = randomUUID();
		this.#confirmations.set(nonce, { taskId, previewHash: task.previewHash, uiEpoch, expiresAt: task.expiresAt });
		const details = this.ledger.tasks().find((value) => value.id === taskId).details;
		return { nonce, taskId, techId: task.scope.techId, techName: details.techName, planetId: task.scope.planetId, expiresAt: task.expiresAt, maximumAcceptedWrites: 1, normalEnqueue: true, syntheticOnly: this.syntheticOnly };
	}
	reprepare() {
		if (this.closing || this.operation || this.phase !== "awaiting_approval" || !this.currentTaskId) throw new Error("GAME_CONFIRMATION_UNAVAILABLE");
		this.#confirmations.clear();
		return this.#launch("preparing", async () => { this.#notStopped(); await this.ledger.prepare(this.currentTaskId); this.#notStopped(); this.#stage("awaiting_approval"); });
	}
	confirm(authority, nonce, uiEpoch) {
		if (authority !== this.hostApproval) throw new Error("TRUSTED_USER_APPROVAL_REQUIRED");
		const challenge = this.#confirmations.get(nonce); this.#confirmations.delete(nonce);
		if (!challenge || this.closing || this.operation || challenge.uiEpoch !== uiEpoch || challenge.taskId !== this.currentTaskId || challenge.expiresAt <= this.now() || this.phase !== "awaiting_approval") throw new Error("FRESH_RESEARCH_APPROVAL_REQUIRED");
		return this.#launch("confirming", async () => {
			const task = this.ledger.task(challenge.taskId), fresh = await this.adapter.observe(task.scope, { player: true }); this.#notStopped();
			this.ledger.approve(this.#approvalAuthority, task.id, challenge.previewHash);
			// No await between durable intent and the one transport submission.
			const intent = this.ledger.beginIntent(task.id, challenge.previewHash, fresh.context);
			let receipt;
			try { receipt = await this.adapter.commit(intent.commit); }
			catch { this.ledger.markUnknown(intent.intentId); throw new Error("COMMIT_RECEIPT_UNAVAILABLE"); }
			this.ledger.accept(intent.intentId, receipt); this.#stage("accepted");
			await this.#pollOriginal(intent.intentId);
		});
	}
	invalidateUi(uiEpoch) {
		for (const [nonce, value] of this.#confirmations) if (value.uiEpoch === uiEpoch) this.#confirmations.delete(nonce);
		if (this.phase === "confirming" && !this.ledger.unresolved().length) { this.controller?.abort(); if (this.currentTaskId) this.ledger.stop(this.currentTaskId); }
	}
	async #pollOriginal(intentId) {
		const deadline = performance.now() + this.pollMilliseconds;
		for (let read = 0; read < 32; read++) {
			try { await this.ledger.reconcile(intentId); this.#stage("completed"); return; }
			catch (error) { if (error.message !== "ORIGINAL_ACTION_PENDING") throw error; }
			if (performance.now() >= deadline || this.closing) { this.#stage("reconciling"); return; }
			await delay(250);
		}
		this.#stage("reconciling");
	}
	reconcile(intentId) {
		const intent = this.ledger.unresolved().find((value) => value.intentId === intentId);
		if (!intent || this.closing) throw new Error("ORIGINAL_GAME_INTENT_REQUIRED");
		if (!intent.actionId) throw new Error("UNKNOWN_COMMIT_HAS_NO_ACTION_ID");
		this.currentTaskId = intent.taskId;
		return this.#launch("reconciling", async () => {
			await this.#reserve();
			const details = this.ledger.tasks().find((task) => task.id === intent.taskId).details;
			if (details.cohortHash !== this.adapter.binding.cohortHash || details.schemaHash !== this.adapter.binding.schemaHash) throw new Error("ORIGINAL_MCP_COHORT_REQUIRED");
			await this.#pollOriginal(intentId);
		});
	}
	stop() {
		this.#confirmations.clear(); this.controller?.abort();
		if (this.currentTaskId) this.ledger.stop(this.currentTaskId);
		this.phase = this.ledger.unresolved().length ? "reconciling" : "cancelled";
		if (!this.operation) return this.#launch(this.phase, async () => {});
		this.emit(); return this.snapshot();
	}
	async settled() { await this.operation?.done; return this.snapshot(); }
	async drain() {
		this.closing = true; this.#confirmations.clear(); this.controller?.abort();
		if (this.currentTaskId && !this.ledger.unresolved().length) { try { this.ledger.stop(this.currentTaskId); } catch { this.error = "GAME_LEDGER_STORAGE_UNAVAILABLE"; } }
		await this.operation?.done;
		// Durable unresolved intents remain blocked next launch. No new action is sent during shutdown.
		if (this.bridgeLease) { this.bridge.releaseResearch(this.bridgeLease); this.bridgeLease = null; this.adapter = null; }
	}
	async resumeAfterCloseFailure() { this.closing = false; if (!this.ledger.unresolved().length) { this.phase = "cancelled"; await this.#release(); } else { this.phase = "blocked"; this.error = "UNRESOLVED_GAME_INTENT_BLOCKS_WRITES"; } this.emit(); }
	close() { this.ledger.close(); }
}
