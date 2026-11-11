const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, maximum = 240) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
const statuses = ["running", "waiting", "verifying", "blocked", "paused", "ready", "completed"];

// Normalize model-produced comparison literals against the observed scalar type.
// Native tool arguments continue through their original schema validation.
export function gameGoalExpected(actual, requested) {
	if (typeof requested !== "string") return requested;
	if (typeof actual === "boolean" && ["true", "false"].includes(requested)) return requested === "true";
	if (typeof actual === "number" && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(requested)) {
		const value = Number(requested);
		if (Number.isFinite(value)) return value;
	}
	return requested;
}

export function gameObjective(value) {
	if (!object(value) || !["evidence", "production"].includes(value.kind)) throw new Error("INVALID_GAME_OBJECTIVE");
	if (value.kind === "evidence") {
		if (Object.keys(value).length !== 1) throw new Error("INVALID_GAME_OBJECTIVE");
		return { kind: "evidence" };
	}
	if (Object.keys(value).some(key => !["kind", "itemId", "minimumPerMinute", "windowSeconds"].includes(key))
		|| !Number.isSafeInteger(value.itemId) || value.itemId < 1
		|| !Number.isFinite(value.minimumPerMinute) || value.minimumPerMinute <= 0 || value.minimumPerMinute > 1e9
		|| !Number.isSafeInteger(value.windowSeconds) || value.windowSeconds < 10 || value.windowSeconds > 3600) throw new Error("INVALID_GAME_OBJECTIVE");
	return { kind: "production", itemId: value.itemId, minimumPerMinute: value.minimumPerMinute, windowSeconds: value.windowSeconds };
}

export function gameGoalChecks(value, maximum = 8) {
	if (!Array.isArray(value) || value.length > maximum || JSON.stringify(value).length > 8192) throw new Error("INVALID_GAME_GOAL_CHECKS");
	if (new Set(value.map(check => check?.label)).size !== value.length) throw new Error("INVALID_GAME_GOAL_CHECKS");
	return value.map(check => {
		if (object(check) && ["gte", "lte"].includes(check.operator)) check = { ...check, value: gameGoalExpected(0, check.value) };
		if (!object(check)
			|| Object.keys(check).some(key => !["label", "tool", "args", "path", "operator", "value"].includes(key))
			|| !text(check.label)
			|| !/^spherewright_[a-z0-9_]{1,80}$/.test(check.tool ?? "")
			|| !object(check.args) || JSON.stringify(check.args).length > 2048
			|| typeof check.path !== "string" || check.path.length > 256 || !check.path.startsWith("/")
			|| check.path.split("/").some(part => /^(?:__proto__|prototype|constructor)$|token|ticket|credential|secret|password/i.test(part))
			|| !["eq", "gte", "lte"].includes(check.operator)
			|| !["string", "number", "boolean"].includes(typeof check.value)
			|| typeof check.value === "number" && !Number.isFinite(check.value)
			|| typeof check.value === "string" && (check.value.length > 240 || /[\x00-\x1f\x7f]/.test(check.value))
			|| check.operator !== "eq" && typeof check.value !== "number") throw new Error("INVALID_GAME_GOAL_CHECKS");
		return structuredClone(check);
	});
}

export function validateGameGoal(value) {
	if (!object(value) || value.version !== 1 || !text(value.title, 2000)
		|| !integer(value.revision) || value.revision < 1 || !statuses.includes(value.status)
		|| !Array.isArray(value.stages) || value.stages.length > 16
		|| !object(value.context) || !object(value.usage)
		|| !integer(value.decisions) || !integer(value.stalledDecisions)
		|| !Number.isFinite(value.updatedAt) || JSON.stringify(value).length > 49152) throw new Error("INVALID_STORED_GAME_GOAL");
	gameObjective(value.objective);
	gameGoalChecks(value.completionChecks);
	gameGoalChecks(value.stageChecks, 4);
	if (value.stages.some(stage => !text(stage.title) || !text(stage.reason) || !text(stage.nextStep) || !["current", "visited", "verified"].includes(stage.status))) throw new Error("INVALID_STORED_GAME_GOAL");
	for (const key of ["modelRequests", "toolCalls", "writes"]) if (!integer(value.usage[key])) throw new Error("INVALID_STORED_GAME_GOAL");
	return structuredClone(value);
}

export function createGameGoal(title, objective, context, now) {
	return validateGameGoal({
		version: 1, revision: 1, title, objective: gameObjective(objective), status: "running", context,
		stages: [], completionChecks: [], stageChecks: [], observations: [],
		wait: null, verification: null, problem: null,
		decisions: 0, stalledDecisions: 0, lastProgress: null, recentFailures: [],
		usage: { modelRequests: 0, toolCalls: 0, writes: 0 },
		startedAt: now, updatedAt: now,
	});
}
