import test from "node:test";
import assert from "node:assert/strict";
import { energyStarvedHarvestCandidate, energyStarvedHarvestAudit, stoppedGameAction } from "../apps/desktop/game-action-outcome.mjs";

const hash = letter => "sha256:" + letter.repeat(64);
const terminal = () => ({ actionKind: "harvest", state: "action_failed", terminal: true, succeeded: false,
	recoveryRequired: false, failureKind: null, stalled: false, doNotRetrySameTarget: false,
	message: "The normal mining order stopped after the mecha had no core energy, reactor energy, current reactor item, or usable fuel for 600 game ticks.",
	beforeStateHash: hash("a"), afterStateHash: hash("b"), startedAtGameTick: 10, completedAtGameTick: 20,
	sessionId: "synthetic-session", planetId: 1, targetObjectId: 42, requestedCount: 12,
	itemDeltas: [{ itemId: 9001, beforeCount: 7, afterCount: 10, delta: 3 }] });
const context = () => ({ sessionId: "synthetic-session", planetId: 1, loaded: true, owned: true, accessRestricted: false,
	writeHealth: "healthy", capturedAtGameTick: 22, observedAt: 1000 });
const player = () => ({ sessionId: "synthetic-session", planetId: 1, capturedAtGameTick: 21,
	stateHashVersion: 1, stateHash: hash("c"), isAlive: true, isOnPlanet: true, isFlying: false, isSailing: false,
	movementState: "Walk", speed: 0, inventory: [{ itemId: 9001, count: 10 }], nativePhysics: {
		state: "observed", currentOrderPresent: false, queuedOrderCount: 0, controllerMovementStateInFrame: "Walk",
		groundContact: { cachedWalkIsGrounded: true }, velocity: { x: 0, y: 0, z: 0 },
		walkManualVelocity: { x: 0, y: 0, z: 0 }, walkRtsVelocity: { x: 0, y: 0, z: 0 }, controllerVerticalSpeed: 0,
	} });

test("energy starvation is only an audit candidate, never an automatically resolved action", () => {
	assert.equal(energyStarvedHarvestCandidate(terminal()), true);
	assert.equal(stoppedGameAction(terminal()), false);
	for (const change of [
		{ actionKind: "move" }, { state: "outcome_unknown" }, { terminal: false }, { succeeded: true },
		{ recoveryRequired: true }, { failureKind: "position_stalled" }, { stalled: true },
		{ message: "other failure" }, { beforeStateHash: null }, { afterStateHash: null },
		{ completedAtGameTick: 9 }, { targetObjectId: 0 }, { requestedCount: 0 },
		{ itemDeltas: [] }, { itemDeltas: [{ itemId: 9001, beforeCount: 7, afterCount: 10, delta: 2 }] },
		{ itemDeltas: [{ itemId: 9001, beforeCount: 7, afterCount: 20, delta: 13 }] },
	]) assert.equal(energyStarvedHarvestCandidate({ ...terminal(), ...change }), false);
});

test("energy-starved harvest audit requires the same fresh, idle, grounded world and retained partial yield", () => {
	assert.equal(energyStarvedHarvestAudit(terminal(), player(), context(), 1000), true);
	for (const change of [
		{ sessionId: "other" }, { planetId: 2 }, { capturedAtGameTick: 19 }, { stateHash: null },
		{ isAlive: false }, { isOnPlanet: false }, { isFlying: true }, { speed: 1 },
		{ inventory: [] }, { inventory: [{ itemId: 9001, count: 9 }] },
		{ nativePhysics: null }, { nativePhysics: { ...player().nativePhysics, currentOrderPresent: true } },
		{ nativePhysics: { ...player().nativePhysics, queuedOrderCount: 1 } },
		{ nativePhysics: { ...player().nativePhysics, groundContact: { cachedWalkIsGrounded: false } } },
		{ nativePhysics: { ...player().nativePhysics, velocity: { x: 1, y: 0, z: 0 } } },
	]) assert.equal(energyStarvedHarvestAudit(terminal(), { ...player(), ...change }, context(), 1000), false);
	for (const change of [{ sessionId: "other" }, { writeHealth: "quarantined" }, { capturedAtGameTick: 20 }, { observedAt: -5000 }])
		assert.equal(energyStarvedHarvestAudit(terminal(), player(), { ...context(), ...change }, 1000), false);
});
