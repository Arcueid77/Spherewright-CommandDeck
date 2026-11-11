import { gameObjective, validateGameGoal, createGameGoal, gameGoalExpected, gameGoalChecks as checks } from "./game-goal-contract.mjs";
export { gameObjective, validateGameGoal, createGameGoal } from "./game-goal-contract.mjs";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { publicGameValue } from "./spherewright-tool-catalog.mjs";
import { extendProductionGoal, productionGoalSample } from "./game-production-goal.mjs";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, maximum = 240) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const string = { type: "string", minLength: 1, maxLength: 240 };
const checkSchema = {
	type: "object", additionalProperties: false, required: ["label", "tool", "args", "path", "operator", "value"],
	properties: { label: string, tool: { type: "string", pattern: "^spherewright_", maxLength: 100 }, args: { type: "object" }, path: { type: "string", maxLength: 256, pattern: "^/" }, operator: { type: "string", enum: ["eq", "gte", "lte"] }, value: { type: ["string", "number", "boolean"], maxLength: 240 } },
};
export const gameGoalTools = [
	{ name: "deck_goal_execute_action", description: "Execute one ordinary autonomous native action. Uses the named native prepare tool and its exact arguments, commits its fresh plan once under the approved family and budget, then waits up to 120 seconds for the original action. Check result.succeeded and the original native outcome. New-world creation uses its separate native confirmation flow.", inputSchema: { type: "object", additionalProperties: false, required: ["prepareTool", "args"], properties: { prepareTool: { type: "string", pattern: "^spherewright_prepare_", maxLength: 100 }, args: { type: "object" } } } },
	{ name: "deck_goal_plan", description: "Record the current stage, reason and next step. Define completionChecks using fields actually observed in native read results. Revise proposed conditions with an explanation when schema or state evidence changes; revisions are recorded. The user's fixed production item/rate/window still apply. Optional stageChecks verify this stage. activeTools selects relevant registered native tools.", inputSchema: { type: "object", additionalProperties: false, required: ["stage", "reason", "nextStep"], properties: { stage: string, reason: string, nextStep: string, completionChecks: { type: "array", minItems: 1, maxItems: 8, items: checkSchema }, stageChecks: { type: "array", maxItems: 4, items: checkSchema }, activeTools: { type: "array", minItems: 1, maxItems: 128, items: { type: "string", maxLength: 100 } } } } },
	{ name: "deck_goal_wait", description: "Wait without model polling for a bounded native read condition or the original in-flight action. For a production goal with no in-flight action, omit condition to monitor its sustained production window. Waits spend the existing wall/tool allowance and return evidence. Do not resubmit accepted actions.", inputSchema: { type: "object", additionalProperties: false, required: ["reason", "timeoutSeconds"], properties: { reason: string, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 }, condition: checkSchema } } },
	{ name: "deck_goal_verify", description: "Fresh-read the recorded completion conditions and, for a production goal, the fixed item/rate/window. Only the host can mark this goal complete. Supply and facility checks should use native entity/connection evidence. Returns missing or unmet conditions for the next decision.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
	{ name: "deck_goal_status", description: "Read the durable goal, stage, recent observations, original-action state and remaining task allowance.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
];

function pointer(value, path) {
	if (!path) return value;
	for (const key of path.slice(1).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) {
		if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
		value = value[key];
	}
	return value;
}

export function gameGoalProjection(goal, actions, { active = false, now = Date.now() } = {}) {
	if (!goal) return null;
	const value = validateGameGoal(goal), stage = value.stages.at(-1) ?? null;
	const action = actions[0] ?? null, pending = actions.find(task => task.intent && ["recorded", "accepted", "unknown"].includes(task.intent.state));
	let behavior = { state: value.status === "waiting" ? "waiting" : active ? "deciding" : "idle", label: value.wait?.reason ?? stage?.title ?? "观察当前世界", actionId: null, taskId: null, terminal: null };
	if (pending) behavior = { state: pending.intent.state === "unknown" ? "reconciling" : pending.intent.state === "accepted" ? "executing" : "submitting", label: pending.scope.actionKind, actionId: pending.intent.actionId, taskId: pending.id, terminal: null };
	else if (!active && value.status !== "waiting" && action?.intent?.terminal) behavior = { state: action.intent.terminal.succeeded === false ? "failed" : "verified", label: action.scope.actionKind, actionId: action.intent.actionId, taskId: action.id, terminal: action.intent.terminal };
	if (!pending && active && value.activity) behavior = { ...behavior, ...value.activity };
	const verification = value.verification && { ...value.verification, ageMs: Math.max(0, now - value.verification.observedAt), stale: now - value.verification.observedAt > 15000 };
	const recordedStatus = value.status;
	const status = pending?.intent?.state === "unknown" ? "blocked" : !active && ["running", "waiting", "verifying"].includes(recordedStatus) ? "paused" : recordedStatus;
	return { ...value, recordedStatus, status, active, stage, behavior, verification, nextStep: stage?.nextStep ?? null, reason: stage?.reason ?? null };
}

export class GameGoalController {
	constructor({ ledger, task, session, objective, prompt, previous, stage, emit, signal, now = () => Date.now(), pause = (ms, signal) => sleep(ms, undefined, { signal }) }) {
		Object.assign(this, { ledger, task, session, stage, emit, signal, now, pause });
		this.goal = createGameGoal(prompt, objective, { ...session.context }, now());
		this.baseUsage = previous ? { ...previous.usage } : { modelRequests: 0, toolCalls: 0, writes: 0 };
		this.coordinationCalls = 0;
		this.goal.id = previous?.id ?? task.id;
		this.goal.previousTaskId = previous?.taskId ?? null;
		this.goal.taskId = task.id;
		this.goal.revision = (previous?.revision ?? 0) + 1;
		this.goal.limits = previous?.limits ?? { ...session.limits };
		this.goal.deadlineAt = previous?.deadlineAt ?? now() + session.limits.durationMs;
		this.goal.usage = { ...this.baseUsage };
		if (previous && previous.title === prompt && hash(previous.objective) === hash(objective)) {
			this.goal.stages = structuredClone(previous.stages);
			this.goal.completionChecks = structuredClone(previous.completionChecks);
			this.goal.stageChecks = structuredClone(previous.stageChecks);
			if (previous.productionPlanetId) this.goal.productionPlanetId = previous.productionPlanetId;
		}
		this.persist();
	}
	persist() {
		this.goal.updatedAt = this.now();
		this.goal.usage.toolCalls = this.baseUsage.toolCalls + this.session.calls + this.coordinationCalls;
		this.goal.usage.writes = this.baseUsage.writes + this.session.submissions;
		this.ledger.goal(this.task.id, this.goal); this.emit();
	}
	assertActive() {
		this.session.assertActive();
		if (["blocked", "paused", "completed", "ready"].includes(this.goal.status)) throw new Error("GAME_GOAL_NOT_RUNNING");
	}
	get done() { return ["blocked", "paused", "completed", "ready"].includes(this.goal.status); }
	view() { return gameGoalProjection(this.goal, this.ledger.children(this.task.id), { active: !this.done, now: this.now() }); }
	assertToolBudget() {
		if (this.session.calls + this.coordinationCalls >= this.session.limits.toolCalls) throw new Error("GAME_GOAL_TOOL_LIMIT");
	}
	assertRead(check) {
		const entry = this.session.entries.get(check.tool);
		if (entry?.kind !== "read" || !this.session.port.valid(check.tool, check.args)) throw new Error("GAME_GOAL_READ_CONDITION_REQUIRED");
	}
	async read(name, args) {
		this.assertActive();
		this.assertToolBudget();
		const reply = await this.session.call(name, args);
		this.goal.context = { ...this.session.context }; this.persist();
		return reply;
	}
	async check(condition) {
		this.assertRead(condition);
		const reply = await this.read(condition.tool, condition.args), actual = pointer(reply, condition.path);
		const available = reply?.success === true && ["number", "string", "boolean"].includes(typeof actual) && (typeof actual !== "number" || Number.isFinite(actual));
		const expected = gameGoalExpected(actual, condition.value);
		const passed = available && (condition.operator === "eq" ? actual === expected : typeof actual === "number" && (condition.operator === "gte" ? actual >= expected : actual <= expected));
		const sourceTick = reply?.result?.capturedAtGameTick ?? reply?.result?.gameTick ?? reply?.status?.gameTick;
		const observation = { label: condition.label, tool: condition.tool, path: condition.path, operator: condition.operator, requested: condition.value, expected, actual: available ? actual : null, available, passed, observedAt: this.now(), capturedAtGameTick: integer(sourceTick) ? sourceTick : null, hash: hash(reply) };
		if (!available) {
			const parent = pointer(reply, condition.path.slice(0, condition.path.lastIndexOf("/")));
			observation.availableFields = Object.keys(parent ?? reply?.result ?? reply ?? {}).slice(0, 24);
		}
		this.goal.observations = [...this.goal.observations.filter(value => value.label !== condition.label), observation].slice(-12); this.persist();
		return observation;
	}
	plan(args) {
		this.assertActive();
		if (!object(args) || Object.keys(args).some(key => !["stage", "reason", "nextStep", "completionChecks", "stageChecks", "activeTools"].includes(key)) || ![args.stage, args.reason, args.nextStep].every(value => text(value))) throw new Error("INVALID_GAME_GOAL_PLAN");
		const candidate = structuredClone(this.goal);
		if (args.activeTools !== undefined) {
			const available = new Set(this.session.tools().map(tool => tool.name));
			if (!Array.isArray(args.activeTools) || !args.activeTools.length || args.activeTools.length > 128 || new Set(args.activeTools).size !== args.activeTools.length || args.activeTools.some(name => !available.has(name))) throw new Error("GAME_GOAL_TOOL_SCOPE_REJECTED");
			candidate.selectedTools = [...args.activeTools];
		}
		if (args.completionChecks !== undefined) {
			const conditions = checks(args.completionChecks);
			if (!conditions.length) throw new Error("GAME_GOAL_COMPLETION_CHECKS_REQUIRED");
			conditions.forEach(check => this.assertRead(check));
			if (hash(conditions) !== hash(candidate.completionChecks)) candidate.checkRevision = (candidate.checkRevision ?? 0) + 1;
			candidate.completionChecks = conditions;
		}
		const stageChecks = checks(args.stageChecks ?? [], 4); stageChecks.forEach(check => this.assertRead(check));
		const previous = candidate.stages.at(-1);
		if (previous?.title === args.stage) Object.assign(previous, { reason: args.reason, nextStep: args.nextStep });
		else {
			if (candidate.stages.length >= 16) throw new Error("GAME_GOAL_STAGE_LIMIT");
			if (previous?.status === "current") previous.status = "visited";
			candidate.stages.push({ title: args.stage, reason: args.reason, nextStep: args.nextStep, status: "current", startedAt: this.now() });
		}
		candidate.stageChecks = stageChecks; this.goal = candidate; this.persist(); return this.view();
	}
	async executeAction(args) {
		this.assertActive();
		if (!object(args) || Object.keys(args).some(key => !["prepareTool", "args"].includes(key)) || !object(args.args)) throw new Error("INVALID_GAME_ACTION_ARGUMENTS");
		const entry = this.session.entries.get(args.prepareTool);
		if (this.session.mode !== "autonomous" || !this.session.authorized || entry?.kind !== "prepare" || entry.family === "new_game") throw new Error("AUTONOMOUS_GAME_ACTION_REQUIRED");
		const commit = [...this.session.entries.values()].find(value => value.kind === "commit" && value.family === entry.family);
		if (!commit) throw new Error("GAME_MCP_CALL_NOT_SUPPORTED");
		const prepared = await this.native(entry.name, args.args);
		if (prepared?.success !== true) return prepared;
		const commitArgs = { planToken: prepared.result.planToken, idempotencyKey: randomUUID() };
		for (const field of ["sessionId", "planetId"]) if (Object.hasOwn(commit.inputSchema.properties, field)) commitArgs[field] = this.session.context[field];
		const receipt = await this.native(commit.name, commitArgs);
		if (receipt?.success !== true) return receipt;
		const outcome = await this.wait({ reason: "核对原生 " + entry.family + " 原动作", timeoutSeconds: 120 });
		const terminal = outcome.originalActions.at(-1);
		return { success: true, result: { ...receipt.result, ...terminal, terminal: terminal?.terminal === true, succeeded: terminal?.succeeded === true, stillPending: !outcome.satisfied, itemBudget: prepared.result.itemBudget } };
	}
	async native(name, args) {
		this.assertActive();
		this.assertToolBudget();
		this.goal.activity = { state: this.session.entries.get(name)?.kind === "read" ? "observing" : "preparing", label: name }; this.persist();
		try {
			const result = await this.session.call(name, args);
			if (result?.success === false) this.failure(name, args);
			this.goal.context = { ...this.session.context }; this.goal.activity = { state: "deciding", label: this.goal.stages.at(-1)?.title ?? "观察现场" }; this.persist(); return result;
		} catch (error) {
			this.failure(name, args);
			throw error;
		}
	}
	failure(name, args) {
		const key = hash({ name, args: publicGameValue(args) });
		const previous = this.goal.recentFailures.find(value => value.key === key);
		this.goal.recentFailures = [{ key, name, count: (previous?.count ?? 0) + 1 }, ...this.goal.recentFailures.filter(value => value.key !== key)].slice(0, 6);
		if (this.goal.recentFailures[0].count >= 3) this.stop("blocked", "GAME_GOAL_REPEATED_FAILURE");
		else this.persist();
	}
	async wait(args) {
		this.assertActive();
		if (!object(args) || Object.keys(args).some(key => !["reason", "timeoutSeconds", "condition"].includes(key)) || !text(args.reason) || !Number.isSafeInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 120) throw new Error("INVALID_GAME_GOAL_WAIT");
		const condition = args.condition === undefined ? null : checks([args.condition])[0];
		if (condition) this.assertRead(condition);
		const productionWait = !condition && !this.pending().length && this.goal.objective.kind === "production";
		if (!condition && !this.pending().length && !productionWait) throw new Error("GAME_GOAL_WAIT_CONDITION_REQUIRED");
		const deadline = performance.now() + args.timeoutSeconds * 1000;
		this.goal.status = "waiting"; this.goal.wait = { reason: args.reason, deadlineAt: this.now() + args.timeoutSeconds * 1000 }; this.persist(); this.stage("waiting");
		let satisfied = false, unavailable = false, originalActions = [];
		let sampledAt = -Infinity;
		try {
			do {
				this.assertActive();
				if (this.goal.objective.kind === "production" && !this.pending().length && performance.now() - sampledAt >= 2000) {
					await this.production(); sampledAt = performance.now();
				}
				if (condition) {
					const observation = await this.check(condition);
					satisfied = observation.passed;
					unavailable = !observation.available;
				}
				else if (productionWait) satisfied = this.goal.verification?.state === "verified";
				else { originalActions = await this.reconcile(); satisfied = !this.pending().length; }
				if (satisfied || unavailable || performance.now() >= deadline) break;
				await this.pause(Math.min(1000, Math.max(1, deadline - performance.now())), this.signal);
			} while (true);
		} finally {
			if (!this.done) { this.goal.status = "running"; this.goal.wait = null; this.persist(); this.stage("planning"); }
		}
		return { satisfied, timedOut: !satisfied && !unavailable, originalActions, ...(unavailable ? { reason: "GAME_GOAL_WAIT_FIELD_UNAVAILABLE" } : {}), goal: this.view() };
	}
	pending() { return this.ledger.unresolved().filter(intent => this.ledger.task(intent.taskId).scope.parentTaskId === this.task.id); }
	async reconcile() {
		const results = [];
		for (const intent of this.pending()) {
			if (!intent.actionId || intent.state === "unknown") throw new Error("UNRESOLVED_GAME_INTENT_BLOCKS_WRITES");
			const reply = await this.read("spherewright_get_action_result", { actionId: intent.actionId });
			results.push(reply.result);
		}
		return results;
	}
	async production() {
		if (!this.session.context.loaded) return;
		this.goal.productionPlanetId ??= this.session.context.planetId;
		const context = { ...this.session.context, planetId: this.goal.productionPlanetId }, objective = this.goal.objective;
		let cursor = "", baseline, sample = null, localFound = false;
		const seen = new Set();
		for (let pageIndex = 0; pageIndex < 32; pageIndex++) {
			const reply = await this.read("spherewright_get_overseer_production", { sessionId: context.sessionId, itemIds: [objective.itemId], limit: 16, cursor });
			const page = reply?.result;
			if (reply?.success !== true || !page) break;
			if (!baseline) baseline = page;
			if (page.snapshotId !== baseline.snapshotId || page.capturedAtGameTick !== baseline.capturedAtGameTick || JSON.stringify(page.window) !== JSON.stringify(baseline.window)) throw new Error("GAME_GOAL_PRODUCTION_SCOPE_CHANGED");
			if (page.planets?.some(planet => planet.planetId === context.planetId)) { sample = productionGoalSample(page, context, objective); localFound = true; break; }
			if (!page.nextCursor) break;
			if (seen.has(page.nextCursor)) throw new Error("GAME_GOAL_PRODUCTION_SCOPE_CHANGED");
			seen.add(page.nextCursor); cursor = page.nextCursor;
		}
		if (localFound && this.goal.measurementStartTick === undefined) this.goal.measurementStartTick = context.capturedAtGameTick ?? sample?.endTick ?? 0;
		this.goal.verification = extendProductionGoal(this.goal.verification, sample, objective, this.goal.measurementStartTick ?? 0, this.now()); this.persist();
	}
	async verify() {
		this.assertActive(); this.goal.status = "verifying"; this.persist(); this.stage("verifying");
		try {
			await this.reconcile();
			if (this.pending().length) return { completed: false, reason: "ORIGINAL_ACTION_PENDING", goal: this.view() };
			const stage = [];
			for (const condition of this.goal.stageChecks) stage.push(await this.check(condition));
			if (stage.length && stage.every(value => value.passed) && this.goal.stages.length) this.goal.stages.at(-1).status = "verified";
			const results = [];
			for (const condition of this.goal.completionChecks) results.push(await this.check(condition));
			if (this.goal.objective.kind === "production") await this.production();
			const passed = results.length > 0 && results.every(value => value.passed) && (this.goal.objective.kind !== "production" || this.goal.verification?.state === "verified");
			if (passed) { this.goal.status = "completed"; this.goal.completedAt = this.now(); this.goal.problem = null; }
			this.persist(); return { completed: passed, reason: results.length ? null : "GAME_GOAL_COMPLETION_CHECKS_REQUIRED", goal: this.view() };
		} finally {
			if (!this.done) this.goal.status = "running";
			this.persist(); this.stage(this.goal.status === "completed" ? "goal_completed" : "planning");
		}
	}
	async nextDecision() {
		if (this.done) return { continue: false, goal: this.view() };
		this.goal.decisions++;
		if (this.pending().length) await this.wait({ reason: "核对已受理的原动作", timeoutSeconds: 120 });
		await this.verify();
		if (this.done) return { continue: false, goal: this.view() };
		const completed = this.ledger.children(this.task.id).filter(value => value.intent?.state === "completed").length;
		const key = hash({ completed, observations: this.goal.observations.map(({ label, actual, passed }) => ({ label, actual, passed })), coverage: this.goal.verification?.seconds ?? null });
		this.goal.stalledDecisions = key === this.goal.lastProgress ? this.goal.stalledDecisions + 1 : 0;
		this.goal.lastProgress = key;
		if (this.goal.stalledDecisions >= 3) this.stop("blocked", "GAME_GOAL_NO_PROGRESS");
		else this.persist();
		return { continue: !this.done, goal: this.view() };
	}
	usage(value) { if (integer(value?.requests)) this.goal.usage.modelRequests = this.baseUsage.modelRequests + value.requests; this.persist(); }
	stop(status = "paused", problem = null) {
		if (this.goal.status === "completed") return;
		if (this.goal.status === "blocked" && status === "paused") return;
		if (this.goal.status === status && (!problem || problem === this.goal.problem)) return;
		this.goal.status = status; this.goal.problem = problem; this.goal.wait = null; this.persist();
	}
	async call(name, args) {
		if (["deck_goal_next_decision", "deck_goal_status", "deck_goal_verify"].includes(name) && (!object(args) || Object.keys(args).length)) throw new Error("INVALID_GAME_GOAL_ARGUMENTS");
		if (gameGoalTools.some(tool => tool.name === name) || ["deck_goal_guidance_access", "deck_goal_catalog_access"].includes(name)) {
			this.assertToolBudget(); this.coordinationCalls++; this.persist();
		}
		if (["deck_goal_guidance_access", "deck_goal_catalog_access"].includes(name)) { this.assertActive(); return { allowed: true }; }
		if (name === "deck_goal_next_decision") return this.nextDecision();
		if (name === "deck_goal_status") return this.view();
		if (name === "deck_goal_plan") return this.plan(args);
		if (name === "deck_goal_execute_action") return this.executeAction(args);
		if (name === "deck_goal_wait") return this.wait(args);
		if (name === "deck_goal_verify") return this.done ? { completed: this.goal.status === "completed", goal: this.view() } : this.verify();
		throw new Error("GAME_GOAL_TOOL_UNAVAILABLE");
	}
}
