import { createHash } from "node:crypto";
import { opaque, positive, tick, selectionHash } from "./research-contract.mjs";
import { matchResearchBudget, researchBudgetFromRequirements, researchId } from "./research-preview.mjs";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ids = (value) => Array.isArray(value) && value.length <= 64 && value.every(positive);
const label = (value) => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 160) : "";
function result(value) {
	if (value?.success !== true || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) throw new Error("RESEARCH_SERVICE_RESULT_REJECTED");
	return value.result;
}
function same(scope, context) {
	if (scope && ["bridgeInstanceId", "sessionId", "planetId"].some((key) => scope[key] !== context[key])) throw new Error("GAME_CONTEXT_CHANGED");
}

// Correlation is established here, directly around one fixed MCP request/response pair.
// No caller-supplied native plan or proof is accepted by the ledger.
export class ResearchAdapter {
	#recoveryOnly;
	constructor({ client, authority, selection, now = () => Date.now(), recoveryOnly = false }) {
		this.client = client; this.port = client.researchPort(authority); this.now = now;
		this.#recoveryOnly = recoveryOnly === true;
		this.binding = Object.freeze({ cohortHash: selection.cohortHash, schemaHash: client.metadata.schemaHash });
	}
	async playbook() {
		const text = await this.port.playbook();
		return { text, sha256: createHash("sha256").update(text).digest("hex") };
	}
	async context(expected, writing = true) {
		const status = await this.client.read("spherewright_get_status"), session = result(await this.client.read("spherewright_get_session_state"));
		const value = status?.status;
		if (status?.success !== true || value?.bridgeConnected !== true || value.protocolVersion !== 1 || !opaque(value.bridgeInstanceId) || value.gameLoaded !== true || session.bridgeConnected !== true || session.gameLoaded !== true || session.ownedBySpherewright !== true || session.accessRestricted !== false || !opaque(session.sessionId) || !positive(session.localPlanetId) || !tick(session.gameTick) || !tick(session.revision) || this.client.closed) throw new Error("OWNED_RESEARCH_WORLD_REQUIRED");
		const context = { bridgeInstanceId: value.bridgeInstanceId, sessionId: session.sessionId, planetId: session.localPlanetId, gameTick: session.gameTick, revision: session.revision, owned: true, accessRestricted: false, writeHealth: session.writeHealth, observedAt: this.now() };
		same(expected, context);
		if (writing && (value.writesConfigured !== true || value.writeHealth !== "healthy" || session.writesAllowed !== true || session.writeHealth !== "healthy" || session.peacefulMode !== "confirmed_peaceful" || !Array.isArray(session.writeBlockers) || session.writeBlockers.length)) throw new Error("HEALTHY_RESEARCH_WRITES_REQUIRED");
		return context;
	}
	async observe(expected, { writing = true, player = false, researchTechId } = {}) {
		if (researchTechId !== undefined && !researchId(researchTechId)) throw new Error("INVALID_RESEARCH_TASK_SCOPE");
		const before = await this.context(expected, writing), args = { sessionId: before.sessionId, planetId: before.planetId };
		if (player) {
			const value = result(await this.port.player(args));
			if (value.sessionId !== before.sessionId || value.planetId !== before.planetId || !tick(value.capturedAtGameTick) || value.capturedAtGameTick < before.gameTick || !selectionHash(value.stateHash) || value.stateHashVersion !== 1) throw new Error("FRESH_RESEARCH_PLAYER_REQUIRED");
		}
		const raw = result(await this.port.progression(args)), receivedAt = this.now(), after = await this.context(before, writing);
		if (raw.sessionId !== before.sessionId || raw.planetId !== before.planetId || !tick(raw.capturedAtGameTick) || raw.capturedAtGameTick < before.gameTick || raw.capturedAtGameTick > after.gameTick || !selectionHash(raw.selectionStateHash) || raw.selectionStateHashVersion !== 1 || !ids(raw.techQueue) || new Set(raw.techQueue).size !== raw.techQueue.length || !Array.isArray(raw.technologies) || raw.technologies.length > 4096 || Math.abs(this.now() - receivedAt) > 2000) throw new Error("FRESH_RESEARCH_PROGRESSION_REQUIRED");
		const technologies = raw.technologies.map((tech) => {
			if (!positive(tech.techId) || typeof tech.unlocked !== "boolean" || typeof tech.isQueued !== "boolean" || !ids(tech.prerequisiteTechIds)) throw new Error("RESEARCH_TECHNOLOGY_INVALID");
			return { techId: tech.techId, name: label(tech.name), unlocked: tech.unlocked, isQueued: tech.isQueued, prerequisiteTechIds: [...tech.prerequisiteTechIds] };
		});
		if (new Set(technologies.map((tech) => tech.techId)).size !== technologies.length) throw new Error("RESEARCH_TECHNOLOGY_INVALID");
		const researchBudget = researchTechId === undefined ? undefined : researchBudgetFromRequirements(raw.technologies.find((tech) => tech.techId === researchTechId)?.itemRequirements);
		return { context: { ...after, selectionStateHash: raw.selectionStateHash }, progression: { sessionId: raw.sessionId, planetId: raw.planetId, capturedAtGameTick: raw.capturedAtGameTick, selectionStateHash: raw.selectionStateHash, observedAt: receivedAt, techQueue: [...raw.techQueue], technologies }, ...(researchBudget === undefined ? {} : { researchBudget }) };
	}
	async prepareResearch(request, scope) {
		if (this.#recoveryOnly) throw new Error("READ_ONLY_RESEARCH_RECOVERY");
		const expected = { sessionId: scope.sessionId, planetId: scope.planetId, techId: scope.techId, expectedSelectionStateHash: scope.selectionStateHash, stateHashVersion: 1, prioritizeQueued: false };
		if (request.actionKind !== "select-research" || !equal(request.arguments, expected)) throw new Error("RESEARCH_PREPARE_SCOPE_MISMATCH");
		const fresh = await this.observe(scope, { player: true, researchTechId: scope.techId });
		if (fresh.context.selectionStateHash !== scope.selectionStateHash) throw new Error("RESEARCH_SELECTION_CHANGED");
		const plan = result(await this.port.prepare(request.arguments));
		if (plan.researchQueueReadbackVersion !== 1) throw new Error("RESEARCH_READBACK_NOT_SUPPORTED");
		return { request, plan, researchBudget: matchResearchBudget(plan.itemBudget, fresh.researchBudget) };
	}
	async commit(dto) { if (this.#recoveryOnly) throw new Error("READ_ONLY_RESEARCH_RECOVERY"); return result(await this.port.commit(dto)); } // Called once, only after durable beginIntent.
	async readResearchProof(request) {
		const originalContext = await this.context(request, false);
		const raw = result(await this.port.result({ actionId: request.actionId }));
		if (raw.actionId !== request.actionId || raw.actionKind !== "select-research" || raw.sessionId !== request.sessionId || raw.planetId !== request.planetId || raw.idempotencyKey !== request.idempotencyKey) throw new Error("ORIGINAL_ACTION_BINDING_MISMATCH");
		if (!["outcome_unknown", "recovery_required", "action_failed"].includes(raw.state) && raw.recoveryRequired !== true && raw.terminal === false) throw new Error("ORIGINAL_ACTION_PENDING");
		// Project before returning: flight tokens, save names and unrelated native fields never enter the ledger.
		const readback = raw.researchQueueReadback;
		const terminal = { actionId: raw.actionId, actionKind: raw.actionKind, sessionId: raw.sessionId, planetId: raw.planetId, idempotencyKey: raw.idempotencyKey, state: raw.state, terminal: raw.terminal, succeeded: raw.succeeded, recoveryRequired: raw.recoveryRequired, completedAtGameTick: raw.completedAtGameTick, researchQueueReadback: readback ? { capturedAtGameTick: readback.capturedAtGameTick, beforeQueue: readback.beforeQueue, afterQueue: readback.afterQueue, inventoryPreserved: readback.inventoryPreserved, researchProgressPreserved: readback.researchProgressPreserved } : null };
		// A known native safety failure must reach durable isolation even if the next read disconnects.
		if (["outcome_unknown", "recovery_required", "action_failed"].includes(raw.state) || raw.recoveryRequired === true) return { request, terminal, freshProgression: null, context: originalContext };
		const fresh = await this.observe(request);
		return { request, terminal, freshProgression: fresh.progression, context: fresh.context };
	}
}
