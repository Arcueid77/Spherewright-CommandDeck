import test from "node:test";
import assert from "node:assert/strict";
import { observeGameProgress, gameProgressKey, recordGameMotion } from "../apps/desktop/game-goal-progress.mjs";

test("clock, energy and hash changes alone keep the same gameplay progress", () => {
	const goal = { observations: [] };
	const reply = count => ({ success: true, result: { gameTick: count * 100, coreEnergy: count, stateHash: String(count), inventory: [{ itemId: 1, count: 20, inc: 0 }] } });
	observeGameProgress(goal, "spherewright_get_player_state", {}, reply(1));
	const baseline = gameProgressKey(goal, []);
	goal.observations = [{ available: true, tool: "spherewright_get_session_state", path: "/result/gameTick", actual: 100, passed: true }];
	assert.equal(gameProgressKey(goal, []), baseline);
	goal.observations[0].actual = 200;
	assert.equal(gameProgressKey(goal, []), baseline);
	observeGameProgress(goal, "spherewright_get_player_state", {}, reply(2));
	assert.equal(gameProgressKey(goal, []), baseline);
	observeGameProgress(goal, "spherewright_get_player_state", {}, { success: true, result: { inventory: [{ itemId: 1, count: 21 }] } });
	assert.notEqual(gameProgressKey(goal, []), baseline);
});

test("actual research uploads count as progress while unaccepted, failed and save attempts retain zero effect", () => {
	const goal = { observations: [] };
	const make = hashUploaded => ({ success: true, result: { techQueue: [1], technologies: [{ techId: 1, unlocked: false, currentLevel: 0, hashUploaded }] } });
	observeGameProgress(goal, "spherewright_get_progression_state", {}, make(0));
	const baseline = gameProgressKey(goal, []);
	const action = (kind, succeeded) => ({ scope: { actionKind: kind }, intent: { state: "completed", actionId: "synthetic", terminal: { succeeded } } });
	assert.equal(gameProgressKey(goal, [action("handcraft", false), action("save", true)]), baseline);
	observeGameProgress(goal, "spherewright_get_progression_state", {}, make(30));
	assert.notEqual(gameProgressKey(goal, []), baseline);
	assert.notEqual(gameProgressKey(goal, [action("build", true)]), gameProgressKey(goal, []));
});

test("arrival within tolerance supplies motion evidence only when the actual route advances", () => {
	const goal = { observations: [] }, before = { x: 0, y: 0, z: 0 };
	assert.equal(recordGameMotion(goal, "tiny", before, { x: 0.002, y: 0, z: 0 }, { x: 2.002, y: 0, z: 0 }).effectObserved, false);
	assert.equal(recordGameMotion(goal, "moved", before, { x: 3, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).effectObserved, true);
	assert.deepEqual(goal.motionActionIds, ["moved"]);
});
