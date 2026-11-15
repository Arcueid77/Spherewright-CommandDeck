// Synthetic stdio peer. No game, filesystem, provider or external network access.
import { createInterface } from "node:readline";
const mode = process.argv[2] ?? "normal", uri = "spherewright://agent/playbooks/opening-movement-v1";
let loaded = mode !== "new-game" && !mode.startsWith("recovery"), commits = 0, preparations = 0, sessionReads = 0, prepared = null, original = null;
let actionReads = 0, productionTick = 1234;
const session = "synthetic-game-session", bridge = "synthetic-game-bridge";
const schema = properties => ({ type: "object", properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type, ...(name === "itemIds" ? { items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 64 } : name === "limit" ? { minimum: 0, maximum: 16 } : {}) }])), required: Object.keys(properties), additionalProperties: false });
const tool = (name, fields, readOnlyHint = true, destructiveHint = false) => ({ name, description: `Synthetic ${name}`, annotations: { readOnlyHint, destructiveHint }, inputSchema: schema(fields) });
const tools = [
	tool("spherewright_get_status", {}), tool("spherewright_get_session_state", {}), tool("spherewright_get_action_result", { actionId: "string" }), tool("spherewright_get_recipe_catalog", {}),
	tool("spherewright_get_overseer_production", { sessionId: "string", itemIds: "array", limit: "integer", cursor: "string" }),
	tool("spherewright_prepare_handcraft", { sessionId: "string", planetId: "integer", recipeId: "integer", count: "integer" }, false), tool("spherewright_commit_handcraft", { sessionId: "string", planetId: "integer", planToken: "string", idempotencyKey: "string" }, false, true),
	tool("spherewright_prepare_new_game", { galaxySeed: "integer", starCount: "integer" }, false), tool("spherewright_commit_new_game", { planToken: "string", idempotencyKey: "string" }, false, true),
	tool("spherewright_prepare_save_import", { sessionId: "string" }, false), tool("spherewright_commit_save_import", { planToken: "string", idempotencyKey: "string" }, false, true),
];
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const playerHash = "sha256:" + "a".repeat(64);
if (mode === "context") {
	tools.push(tool("spherewright_get_player_state", { sessionId: "string", planetId: "integer" }));
	const prepare = tools.find(entry => entry.name === "spherewright_prepare_handcraft");
	prepare.inputSchema.properties.expectedPlayerStateHash = { type: "string" };
	prepare.inputSchema.required.push("expectedPlayerStateHash");
}
if (mode.startsWith("exit")) {
	tools.push(tool("spherewright_prepare_return_to_main_menu", { sessionId: "string", planetId: "integer", expectedRevision: "integer" }, false));
	tools.push(tool("spherewright_commit_return_to_main_menu", { sessionId: "string", planetId: "integer", planToken: "string", idempotencyKey: "string" }, false, true));
}
if (mode.startsWith("recovery") || mode === "exit-recovery") {
	tools.push(tool("spherewright_prepare_resume_owned_game", { resumeToken: "string", recoveryMode: "string" }, false));
	tools.push(tool("spherewright_commit_resume_owned_game", { planToken: "string", idempotencyKey: "string", userConfirmedInConversation: "boolean", confirmationDigest: "string" }, false, true));
}
if (mode === "foundry") {
	tools.push(tool("spherewright_get_foundry_plan", { sessionId: "string", planetId: "integer", targetItemId: "integer", targetRatePerMinute: "number" }));
	tools.push(tool("spherewright_get_power_summary", { sessionId: "string", planetId: "integer" }));
}
if (mode === "energy") {
	tools.push(tool("spherewright_get_player_state", { sessionId: "string", planetId: "integer" }));
	tools.push(tool("spherewright_prepare_harvest", { sessionId: "string", planetId: "integer", targetObjectId: "integer", count: "integer" }, false));
	tools.push(tool("spherewright_commit_harvest", { sessionId: "string", planetId: "integer", planToken: "string", idempotencyKey: "string" }, false, true));
}
for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line), id = request.id, name = request.params?.name, args = request.params?.arguments ?? {};
	if (id === undefined) continue;
	if (request.method === "initialize") { send(id, { protocolVersion: "2025-06-18", serverInfo: { name: "NO DSP synthetic Spherewright", version: "0.0.0" }, capabilities: { tools: {}, resources: {} } }); continue; }
	if (request.method === "tools/list") { send(id, { tools }); continue; }
	if (request.method === "resources/list") { send(id, { resources: [{ uri, name: "Synthetic playbook" }] }); continue; }
	if (request.method === "resources/read") { send(id, { contents: [{ uri, text: "Synthetic only. Use fresh prepare, native confirmation, one commit and original-action readback." }] }); continue; }
	let reply;
	if (name === "spherewright_get_player_state" && mode === "energy") {
		send(id, { structuredContent: { success: true, result: { sessionId: session, planetId: 1, capturedAtGameTick: productionTick, stateHashVersion: 1, stateHash: playerHash, isAlive: true, isOnPlanet: true, isFlying: false, isSailing: false, movementState: "Walk", speed: 0, inventory: [{ itemId: 1001, count: 10 }], nativePhysics: { state: "observed", currentOrderPresent: false, queuedOrderCount: 0, controllerMovementStateInFrame: "Walk", groundContact: { cachedWalkIsGrounded: true }, velocity: { x: 0, y: 0, z: 0 }, walkManualVelocity: { x: 0, y: 0, z: 0 }, walkRtsVelocity: { x: 0, y: 0, z: 0 }, controllerVerticalSpeed: 0 } } } }); continue;
	}
	if (name === "spherewright_get_player_state" && mode === "context") {
		send(id, { structuredContent: { success: true, result: { stateHash: playerHash, inventory: [], position: { x: 0, y: 0, z: 200 } } } }); continue;
	}
	if (name === "spherewright_prepare_handcraft" && mode === "context" && args.expectedPlayerStateHash !== playerHash) {
		send(id, { structuredContent: { success: false, result: null, error: { code: "STALE_STATE" } } }); continue;
	}
	if (name === "spherewright_get_status") reply = { success: true, status: { bridgeConnected: true, protocolVersion: 1, bridgeInstanceId: bridge, gameLoaded: loaded, writesConfigured: true, writeHealth: "healthy", syntheticCommitCount: commits, syntheticPrepareCount: preparations } };
	else if (name === "spherewright_get_session_state") {
		sessionReads++; const currentLoaded = loaded || mode === "recovery-world-change" && sessionReads > 2;
		reply = { success: true, result: { bridgeConnected: true, gameLoaded: currentLoaded, ownedBySpherewright: currentLoaded, accessRestricted: !currentLoaded, sessionId: currentLoaded ? mode === "exit-world-change" && prepared || mode === "recovery-world-change" ? "synthetic-other-world" : session : null, localPlanetId: currentLoaded ? 1 : null, gameTick: productionTick, revision: commits, writesAllowed: true, writeHealth: "healthy", peacefulMode: "confirmed_peaceful", writeBlockers: [], gameVersion: "1.2.3", ...(mode.startsWith("exit") && !currentLoaded ? { restartResumeAvailable: true, restartResumeToken: "PRIVATE_SYNTHETIC_TOKEN", lastOwnedSaveGameTick: 1234 } : {}) } };
	}
	else if (name === "spherewright_get_foundry_plan" && mode === "foundry") reply = { success: true, result: { sessionId: session, planetId: 1, capturedAtGameTick: productionTick, targetItemId: args.targetItemId, targetRatePerMinute: args.targetRatePerMinute, executable: false, machineCount: 4, machineWorkPowerWatts: 2000000, stages: [{ itemId: args.targetItemId, recipeId: 9, buildingItemId: 2901, machineCount: 4, requiredRatePerMinute: args.targetRatePerMinute }], externalInputs: [{ itemId: 1001, ratePerMinute: 144 }], machineCost: [], remainingChecks: ["power and transport"] } };
	else if (name === "spherewright_get_power_summary" && mode === "foundry") reply = { success: true, result: { sessionId: session, planetId: 1, capturedAtGameTick: productionTick, totalEnergyCapacity: 100000, totalEnergyRequired: 80000, totalEnergyServed: 80000 } };
	else if (name === "spherewright_get_recipe_catalog" && mode === "refused-read") reply = { success: false, error: { code: "RECIPE_LOCKED", message: "Synthetic recipe is not unlocked" }, result: null };
	else if (name === "spherewright_get_recipe_catalog") reply = { success: true, result: { items: [{ itemId: 1001, name: "Synthetic ore" }], saveName: "PRIVATE_SYNTHETIC_SAVE", resumeToken: "PRIVATE_SYNTHETIC_TICKET" } };
	else if (name?.startsWith("spherewright_prepare_") && mode === "refused") reply = { success: false, error: { code: "INSUFFICIENT_ITEMS", message: "Synthetic material shortage" }, result: { prepared: false, commitAllowedNow: false, commitBlockers: ["Synthetic material shortage"] } };
	else if (name?.startsWith("spherewright_prepare_")) {
		preparations++;
		prepared = { family: name.slice("spherewright_prepare_".length), token: "PRIVATE_SYNTHETIC_NATIVE_TOKEN_" + String(commits), args };
		reply = { success: true, result: { ...(prepared.family === "new_game" ? { commitAllowed: true, peacefulMode: true, sandboxMode: false, resourceMultiplier: 1 } : prepared.family === "resume_owned_game" ? { prepared: true, recoveryMode: "open_saved_primary", recoveryEvidenceVersion: 1, opensSavedWorldOnly: true, opensExactLastExitOnly: false, previousAutomationRemainsStopped: true, newChargingProhibited: true, exactEmbeddedIdentityVerified: true, discardedUnstoredProgressGameTicks: mode === "recovery-bad-plan" ? 1 : 0, expectedPlanetId: 1, candidateGameTick: 1234, minimumGameTick: 1234, sourceGameVersion: "1.2.3", targetGameVersion: "1.2.3", userConfirmationRequired: true, commitAllowedNow: false, commitBlockers: [{ code: "USER_CONFIRMATION_REQUIRED" }], confirmationDigest: "sha256:" + "d".repeat(64), confirmationPrompt: "Open only the exact complete owned OwnedPrimary at tick 1234, pausing at Native load completion. Discarded progress: 0 ticks, from known floor 1234. Existing applicable conversation authority may cover this exact disclosed choice. Old automation remains stopped; no automatic Save, Resume, charging, flight, task renewal or action replay.", effectiveRecoveryDeadlineUtc: null, maximumChargeGameTicks: 0, maximumChargeWallSeconds: 0, recoveryScope: "", nativeChargeFeasibilityRequiresFreshCapture: false, priorFailedResumeProvenanceUsed: false, priorFailedResumeV2ProvenanceUsed: false, priorFailedResumeV3ProvenanceUsed: false, priorActionTerminalFailureAttested: false, priorActionTerminalCompletionAttested: false, failedRemoteLastExitReauthorizationUsed: false, completedRemoteLastExitContinuationUsed: false, remotePrimaryRecoveryAuthorizationUsed: false, conservedObservedProgressDebitGameTicks: null, legacyLocalMoveUnknownProvenanceUsed: false } : { prepared: true, actionKind: prepared.family === "return_to_main_menu" ? "return-to-main-menu" : prepared.family === "harvest" ? "harvest" : "handcraft", commitAllowedNow: true, commitBlockers: [], itemBudget: [{ itemId: 1001, count: args.count }], completionCondition: "Native handcraft queue accepts requested count" }), planToken: prepared.token, expiresAtUtc: new Date(Date.now() + (mode === "exit-expired" && preparations === 1 ? 150 : 30000)).toISOString(), saveName: "PRIVATE_SYNTHETIC_SAVE" } };
		if (mode === "recovery-changed-scope") reply.result.maximumChargeGameTicks = 1;
		if (mode === "recovery-altered-disclosure") reply.result.confirmationPrompt += " Additional authority.";
		if (mode === "recovery-extra-blocker") reply.result.commitBlockers.push({ code: "NATIVE_NOT_READY" });
	} else if (name?.startsWith("spherewright_commit_") && mode === "stale-commit") reply = { success: false, result: null, error: { code: "STALE_STATE", message: "Synthetic player state changed before admission" } };
	else if (name?.startsWith("spherewright_commit_")) {
		if (!prepared || args.planToken !== prepared.token) throw new Error("BAD_SYNTHETIC_PLAN");
		if (prepared.family === "resume_owned_game" && (args.userConfirmedInConversation !== true || args.confirmationDigest !== "sha256:" + "d".repeat(64))) throw new Error("BAD_SYNTHETIC_RECOVERY_CONSENT");
		commits++; const newGame = prepared.family === "new_game", exit = prepared.family === "return_to_main_menu", recovery = prepared.family === "resume_owned_game"; loaded = !exit;
		actionReads = 0;
		original = { actionId: `synthetic-action-${commits}`, actionKind: newGame ? "new-game" : exit ? "return-to-main-menu" : recovery ? "resume-owned-game" : mode === "energy" ? "harvest" : "handcraft", sessionId: session, planetId: 1, idempotencyKey: recovery ? null : args.idempotencyKey, state: ["pending", "goal", "exit-pending", "recovery-pending"].includes(mode) ? "executing" : mode === "unknown" ? "outcome_unknown" : mode === "energy" ? "action_failed" : "completed", terminal: !["pending", "goal", "exit-pending", "recovery-pending"].includes(mode), succeeded: !["pending", "goal", "exit-pending", "recovery-pending", "unknown", "energy"].includes(mode), completedAtGameTick: 1234, ...(exit ? { mainMenuReturnReadback: { normalSaveConfirmed: true, completeSaveVerified: true, nativeEndRequested: true, mainMenuVerified: mode !== "exit-bad-proof", savedGameTick: 1234 } } : {}), ...(mode === "energy" ? { recoveryRequired: false, failureKind: "mecha_power_starved", stalled: false, doNotRetrySameTarget: false, message: "Synthetic localized energy stop", beforeStateHash: playerHash, afterStateHash: playerHash, startedAtGameTick: 1230, targetObjectId: 42, requestedCount: 12, itemDeltas: [{ itemId: 1001, beforeCount: 7, afterCount: 10, delta: 3 }] } : {}) };
		if (mode === "lost-ack" || mode === "exit-lost-ack" || mode === "recovery-lost-ack") process.exit(0);
		reply = { success: true, result: { actionId: original.actionId, accepted: true, ...(newGame ? { saveName: "PRIVATE_SYNTHETIC_SAVE" } : recovery ? { idempotentReplay: false } : { actionKind: original.actionKind, idempotencyKey: args.idempotencyKey }) } }; prepared = null;
	} else if (name === "spherewright_get_action_result") {
		if (["goal", "exit-pending", "recovery-pending"].includes(mode) && original && ++actionReads >= 2) { Object.assign(original, { state: "completed", terminal: true, succeeded: true }); if (mode === "exit-pending") loaded = false; }
		if (!original || args.actionId !== original.actionId) reply = { success: false, error: "NOT_FOUND" };
		else { const result = { ...original }; if (result.actionKind === "new-game") { delete result.idempotencyKey; delete result.completedAtGameTick; } if (mode === "wrong-key") result.idempotencyKey = "wrong-original-key"; reply = { success: true, result }; }
	} else if (name === "spherewright_get_overseer_production") {
		productionTick += 300;
		const rate = commits === 0 ? 0 : mode === "goal-low-rate" ? 30 : 60, producedCount = rate / 6;
		reply = { success: true, result: { sessionId: session, snapshotId: "synthetic-production-" + productionTick, capturedAtGameTick: productionTick, requestedItemIds: args.itemIds, totalFactoryCount: 1, returnedFactoryCount: 1, nextCursor: null, window: { state: "ready", startGameTick: productionTick - 599, endGameTick: productionTick, elapsedGameTicks: 600, elapsedGameSeconds: 10, crossedSessionBoundary: false }, planets: [{ planetId: 1, capturedAtGameTick: productionTick, production: [{ itemId: args.itemIds[0], itemName: "Synthetic matrix", producedCount, consumedCount: 0, actualProductionPerMinute: rate, actualConsumptionPerMinute: 0, rateSource: "native_factory_statistics_level_0" }] }] } };
	} else reply = { success: false, error: "UNSUPPORTED" };
	send(id, { content: [{ type: "text", text: "Synthetic result" }], structuredContent: reply, ...(mode === "refused" && name?.startsWith("spherewright_prepare_") || mode === "refused-read" && name === "spherewright_get_recipe_catalog" || mode === "stale-commit" && name?.startsWith("spherewright_commit_") ? { isError: true } : {}) });
}
