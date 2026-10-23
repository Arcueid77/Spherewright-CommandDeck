import assert from "node:assert/strict";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const portableHistoryFile = "closed-history-fixture.json";
export const historyHash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// This file contains closed synthetic records, never a command or authorization.
export async function readPortableHistory(context) {
	const file = join(context.root, portableHistoryFile);
	let info;
	try { info = await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 131072, "PORTABLE_HISTORY_FILE_INVALID");
	const value = JSON.parse(await readFile(file, "utf8"));
	assert.equal(value.version, 1); assert.equal(value.kind, "closed-synthetic-history"); assert.equal(value.runId, context.runId);
	assert.equal(value.workbench?.roots?.length, 1); assert.equal(value.workbench?.tasks?.length, 1);
	assert.equal(value.workbench.roots[0].enabled, false); assert.equal(value.workbench.roots[0].canWrite, false); assert.equal(value.workbench.roots[0].canExecute, false);
	assert.equal(value.workbench.task?.state, "succeeded"); assert.equal(value.workbench.task?.invocations?.length, 1);
	assert.equal(value.workbench.task.invocations[0].state, "completed");
	assert.equal(value.game?.tasks?.length, 1); assert.equal(value.game.tasks[0].state, "completed"); assert.equal(value.game.tasks[0].intent?.state, "completed");
	assert.ok(value.game.tasks[0].intent?.idempotencyKey && value.game.tasks[0].intent?.actionId && value.game.tasks[0].intent?.terminal);
	assert.equal(value.sha256, historyHash({ workbench: value.workbench, game: value.game }));
	return value;
}

export async function assertPortableHistory(api, expected) {
	const state = await api("workbench", { action: "state" });
	assert.equal(state.activeTask, null); assert.equal(state.executionBlocked, false);
	const task = await api("workbench", { action: "task", args: { taskId: expected.workbench.task.id } });
	const draft = await api("workbench", { action: "ui-get", args: { key: "draft" } });
	const game = await api("game", { action: "snapshot" });
	assert.equal(game.busy, false); assert.equal(game.developmentFrozen, false); assert.deepEqual(game.unresolved, []);
	const actual = { workbench: { roots: state.roots, tasks: state.tasks, task, draft }, game: { tasks: game.tasks, events: game.events } };
	assert.deepEqual(actual, { workbench: expected.workbench, game: expected.game }, "PORTABLE_CLOSED_HISTORY_CHANGED");
	assert.equal(historyHash(actual), expected.sha256);
	return { closedHistorySha256: expected.sha256, developmentTasks: 1, developmentInvocations: 1, gameTasks: 1, syntheticCompletedIntents: 1, unresolvedIntents: 0, draftPreserved: true };
}
