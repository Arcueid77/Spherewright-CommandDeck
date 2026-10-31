import { createHash, randomUUID } from "node:crypto";
import { publicGameValue } from "./spherewright-tool-catalog.mjs";

const digest = value => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
const unwrap = value => { if (value?.success !== true || !object(value.result)) throw new Error("GAME_MCP_SERVICE_REJECTED"); return value.result; };
export function gameSessionLimits(value = {}) {
	if (!object(value)) throw new Error("INVALID_GAME_MCP_LIMITS");
	const result = { modelRequests: value.modelRequests ?? 32, toolCalls: value.toolCalls ?? 256, writes: value.writes ?? 32, durationMs: value.durationMs ?? 900000 };
	for (const [key, maximum] of Object.entries({ modelRequests: 256, toolCalls: 2048, writes: 256, durationMs: 7200000 })) if (!Number.isSafeInteger(result[key]) || result[key] < (key === "writes" ? 0 : 1) || result[key] > maximum) throw new Error("INVALID_GAME_MCP_LIMITS");
	if (Object.keys(value).some(key => !Object.hasOwn(result, key))) throw new Error("INVALID_GAME_MCP_LIMITS");
	return result;
}
export async function gameContext(port, expected, writing = false) {
	const status = await port.call("spherewright_get_status", {}), session = unwrap(await port.call("spherewright_get_session_state", {})), value = status?.status;
	if (status?.success !== true || value?.bridgeConnected !== true || value.protocolVersion !== 1 || typeof value.bridgeInstanceId !== "string" || !value.bridgeInstanceId.length || session.bridgeConnected !== true) throw new Error("GAME_MCP_CONTEXT_UNAVAILABLE");
	const context = { bridgeInstanceId: value.bridgeInstanceId, sessionId: session.gameLoaded === true ? session.sessionId : null, planetId: session.gameLoaded === true ? session.localPlanetId : null, owned: session.ownedBySpherewright === true, accessRestricted: session.accessRestricted !== false, loaded: session.gameLoaded === true, capturedAtGameTick: session.gameTick ?? null };
	if (expected && (expected.bridgeInstanceId !== context.bridgeInstanceId || expected.sessionId !== context.sessionId)) throw new Error("GAME_CONTEXT_CHANGED");
	if (context.loaded && (!context.owned || context.accessRestricted || typeof context.sessionId !== "string" || !context.sessionId.length)) throw new Error("OWNED_GAME_WORLD_REQUIRED");
	if (writing && (value.writesConfigured !== true || value.writeHealth !== "healthy" || context.loaded && (session.writesAllowed !== true || session.writeHealth !== "healthy" || session.peacefulMode !== "confirmed_peaceful" || !Array.isArray(session.writeBlockers) || session.writeBlockers.length))) throw new Error("HEALTHY_GAME_WRITES_REQUIRED");
	return context;
}
export async function readMcpAction(port, request) {
	const status = await port.call("spherewright_get_status", {});
	if (status?.success !== true || status.status?.bridgeInstanceId !== request.bridgeInstanceId) throw new Error("GAME_CONTEXT_CHANGED");
	const terminal = unwrap(await port.call("spherewright_get_action_result", { actionId: request.actionId }));
	// Return native safety outcomes before a later context read can obscure them.
	if (terminal.actionId !== request.actionId || terminal.actionKind !== request.actionKind || request.actionKind !== "new-game" && (terminal.idempotencyKey !== request.idempotencyKey || terminal.sessionId !== request.sessionId || request.planetId !== null && terminal.planetId !== request.planetId) || ["outcome_unknown", "recovery_required", "action_failed"].includes(terminal.state) || terminal.recoveryRequired === true) return { request, terminal, context: null };
	return { request, terminal, context: await gameContext(port, request.actionKind === "new-game" ? undefined : request) };
}

// A transport/authority adapter, not another factory planner or native executor.
export class SpherewrightGameSession {
	#runGrant = null;
	constructor({ port, ledger, authority, task, mode, limits, binding, goal, allowedFamilies, signal, stage, check, now = () => Date.now() }) {
		Object.assign(this, { port, ledger, authority, task, mode, limits, binding, goal, signal, stage, check, now });
		this.allowedFamilies = new Set(allowedFamilies ?? []);
		this.entries = new Map(port.tools().map(tool => [tool.name, tool])); this.context = task.scope; this.plans = new Map(); this.submissions = 0; this.calls = 0; this.pending = null; this.deadline = performance.now() + limits.durationMs; this.busy = false;
		this.abort = () => { this.#runGrant = null; this.cancelApproval(); }; signal.addEventListener("abort", this.abort);
	}
	get authorized() { return this.#runGrant !== null; }
	tools() { return [...this.entries.values()].filter(tool => tool.kind === "read" || this.mode === "assist" || this.mode === "autonomous" && this.allowedFamilies.has(tool.family)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })); }
	assertActive() { this.check(); if (this.signal.aborted || performance.now() >= this.deadline) throw new Error("GAME_MCP_SESSION_STOPPED"); }
	waitForApproval(pending) {
		if (this.pending) throw new Error("GAME_CONFIRMATION_ALREADY_OPEN");
		this.pending = pending;
		return new Promise((resolve, reject) => { pending.resolve = resolve; pending.reject = reject; pending.timer = setTimeout(() => this.cancelApproval(), Math.max(1, Math.min(pending.expiresAt - this.now(), this.deadline - performance.now()))); this.stage("awaiting_approval"); });
	}
	async authorizeRun() {
		this.assertActive(); if (this.mode !== "autonomous" || this.#runGrant) throw new Error("FRESH_GAME_MCP_AUTHORIZATION_REQUIRED");
		const disclosure = { goal: this.goal, allowedFamilies: [...this.allowedFamilies].sort(), limits: { ...this.limits }, context: { ...this.context }, binding: { ...this.binding }, newGameRequiresSeparateConfirmation: true, nativeInputExclusion: false };
		const approved = await this.waitForApproval({ kind: "run", taskId: this.task.id, disclosure, digest: digest(disclosure), expiresAt: this.now() + Math.min(120000, this.deadline - performance.now()), nonce: null, uiEpoch: null });
		this.assertActive(); await gameContext(this.port, this.context); this.assertActive();
		this.#runGrant = approved.digest;
	}
	async call(name, args) {
		this.assertActive(); const entry = this.entries.get(name);
		if (this.busy || !entry || !this.port.valid(name, args) || this.mode === "autonomous" && (!this.#runGrant || entry.kind !== "read" && !this.allowedFamilies.has(entry.family)) || this.mode === "observe" && entry.kind !== "read" || ++this.calls > this.limits.toolCalls) throw new Error("GAME_MCP_TOOL_SCOPE_REJECTED");
		this.busy = true;
		try {
			if (entry.kind === "commit") return await this.commit(entry, args);
			const pendingNewWorld = this.ledger.unresolved().some(intent => this.ledger.task(intent.taskId).scope.actionKind === "new-game");
			const context = await gameContext(this.port, pendingNewWorld ? undefined : this.context); this.assertActive();
			if (context.bridgeInstanceId !== this.context.bridgeInstanceId) throw new Error("GAME_CONTEXT_CHANGED");
			if (args.sessionId !== undefined && args.sessionId !== context.sessionId) throw new Error("GAME_CONTEXT_CHANGED");
			if (entry.kind === "prepare" && (this.ledger.unresolved().length || this.submissions >= this.limits.writes)) throw new Error("GAME_MCP_WRITE_BUDGET_OR_PENDING");
			if (name === "spherewright_get_action_result") {
				const intent = this.ledger.unresolved().find(intent => intent.actionId === args.actionId);
				if (intent) {
					let nativeResult;
					try { nativeResult = (await this.ledger.reconcile(intent.intentId)).nativeResult; this.context = context; }
					catch (error) { if (error.message !== "ORIGINAL_ACTION_PENDING") throw error; nativeResult = error.nativeResult; }
					return publicGameValue({ success: true, result: nativeResult });
				}
			}
			const reply = await this.port.call(name, args); this.assertActive();
			if (entry.kind !== "prepare") return publicGameValue(reply);
			const plan = unwrap(reply), newWorld = entry.family === "new_game", expiresAt = Date.parse(plan.expiresAtUtc);
			if (typeof plan.planToken !== "string" || plan.planToken.length < 20 || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 120000 || (newWorld ? context.loaded || plan.commitAllowed !== true || plan.peacefulMode !== true || plan.sandboxMode !== false || plan.resourceMultiplier !== 1 : plan.prepared !== true || plan.commitAllowedNow !== true || !Array.isArray(plan.commitBlockers) || plan.commitBlockers.length || typeof plan.actionKind !== "string" || !plan.actionKind.length)) throw new Error("GAME_MCP_PLAN_REJECTED");
			await gameContext(this.port, context); this.assertActive();
			const reference = "deck-plan:" + randomUUID(); this.plans.clear();
			const preview = { request: publicGameValue(args), plan: publicGameValue(plan) };
			if (JSON.stringify(preview).length > 65536) throw new Error("GAME_MCP_PREVIEW_LIMIT");
			this.plans.set(reference, { entry, context, expiresAt, token: plan.planToken, actionKind: newWorld ? "new-game" : plan.actionKind, requestHash: digest(args), preview });
			return { ...publicGameValue(reply), result: { ...publicGameValue(plan), planToken: reference, deckRequiresConfirmation: this.mode !== "autonomous" || entry.family === "new_game" } };
		} finally { this.busy = false; }
	}
	async commit(entry, args) {
		const plan = this.plans.get(args?.planToken);
		if (!plan || entry.family !== plan.entry.family || this.ledger.unresolved().length || this.submissions >= this.limits.writes || plan.expiresAt <= this.now()) throw new Error("FRESH_GAME_MCP_PLAN_REQUIRED");
		const fields = Object.keys(entry.inputSchema.properties);
		if (Object.keys(args).some(key => !fields.includes(key)) || fields.includes("sessionId") && args.sessionId !== plan.context.sessionId || fields.includes("planetId") && args.planetId !== plan.context.planetId) throw new Error("GAME_MCP_COMMIT_SCOPE_MISMATCH");
		await gameContext(this.port, plan.context, true); this.assertActive();
		const autonomous = this.mode === "autonomous" && entry.family !== "new_game";
		if (autonomous && (!this.#runGrant || !this.allowedFamilies.has(entry.family))) throw new Error("FRESH_GAME_MCP_AUTHORIZATION_REQUIRED");
		const action = this.ledger.createMcpTask({ kind: "mcp-action", parentTaskId: this.task.id, bridgeInstanceId: plan.context.bridgeInstanceId, sessionId: plan.context.sessionId, planetId: fields.includes("planetId") ? args.planetId : null, actionKind: plan.actionKind, requestHash: plan.requestHash, ...(autonomous ? { autonomousAuthorizationHash: this.#runGrant } : {}) });
		this.ledger.details(action.id, this.binding);
		const actionDigest = digest({ tool: entry.name, context: plan.context, request: plan.requestHash, preview: plan.preview, ...(autonomous ? { authorization: this.#runGrant } : {}) });
		const confirmed = autonomous ? { digest: actionDigest } : await this.waitForApproval({ kind: "action", taskId: this.task.id, actionId: action.id, plan, entry, expiresAt: plan.expiresAt, nonce: null, uiEpoch: null, digest: actionDigest });
		this.assertActive(); if (!confirmed) throw new Error("GAME_MCP_CONFIRMATION_CANCELLED");
		await gameContext(this.port, plan.context, true); this.assertActive();
		if (plan.expiresAt <= this.now()) throw new Error("FRESH_GAME_MCP_PLAN_REQUIRED");
		this.plans.clear(); this.submissions++;
		// Persist before dispatch, generate the sole key in the trusted host, and
		// never retry a commit even when the transport reports an error.
		const intent = this.ledger.beginMcpIntent(this.authority, action.id, confirmed.digest, plan.expiresAt);
		let reply;
		try { reply = await this.port.call(entry.name, { ...Object.fromEntries(fields.filter(key => ["sessionId", "planetId"].includes(key)).map(key => [key, args[key]])), planToken: plan.token, idempotencyKey: intent.idempotencyKey }); }
		catch { this.ledger.markUnknown(intent.intentId); throw new Error("COMMIT_RECEIPT_UNAVAILABLE"); }
		const receipt = unwrap(reply), newWorld = plan.actionKind === "new-game";
		this.ledger.acceptMcp(intent.intentId, { ...receipt, ...(newWorld ? { actionKind: "new-game", idempotencyKey: intent.idempotencyKey, idempotencyEchoed: false } : {}) });
		this.stage("planning");
		return publicGameValue(reply);
	}
	confirmation(uiEpoch) {
		this.assertActive(); const pending = this.pending;
		if (!pending || !Number.isSafeInteger(uiEpoch) || uiEpoch < 1 || pending.expiresAt <= this.now()) throw new Error("GAME_CONFIRMATION_UNAVAILABLE");
		pending.nonce = randomUUID(); pending.uiEpoch = uiEpoch;
		if (pending.kind === "run") return { kind: "mcp-run", nonce: pending.nonce, taskId: this.task.id, ...pending.disclosure, expiresAt: pending.expiresAt };
		return { kind: "mcp", nonce: pending.nonce, taskId: this.task.id, tool: pending.entry.name, preview: pending.plan.preview, expiresAt: pending.plan.expiresAt, remainingWrites: this.limits.writes - this.submissions };
	}
	confirm(nonce, uiEpoch) {
		this.assertActive(); const pending = this.pending;
		if (!pending || pending.nonce !== nonce || pending.uiEpoch !== uiEpoch || pending.expiresAt <= this.now()) throw new Error("FRESH_GAME_MCP_APPROVAL_REQUIRED");
		this.stage("confirming");
		if (pending.kind === "run") this.ledger.authorizeMcpRun(this.authority, this.task.id, pending.digest, this.now() + Math.max(1, this.deadline - performance.now()));
		this.pending = null; clearTimeout(pending.timer); pending.resolve({ digest: pending.digest }); return { confirmed: true };
	}
	cancelApproval() { const pending = this.pending; if (pending) { this.pending = null; clearTimeout(pending.timer); pending.reject(new Error("GAME_MCP_CONFIRMATION_CANCELLED")); } }
	close() { this.#runGrant = null; this.cancelApproval(); this.plans.clear(); this.signal.removeEventListener("abort", this.abort); }
}
