import test from "node:test";
import assert from "node:assert/strict";
import { gameActionIntentSchema, resolveGameActionContext } from "../apps/desktop/game-action-context.mjs";

const playerHash = "sha256:" + "a".repeat(64), resourceHash = "sha256:" + "b".repeat(64), endpointHash = "sha256:" + "c".repeat(64), storageHash = "sha256:" + "d".repeat(64);
const session = { context: { sessionId: "synthetic-session", planetId: 1 } };
const entry = (name, fields) => ({ name: "spherewright_prepare_" + name, inputSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(fields.map(field => [field, { type: field.endsWith("Id") || field === "count" ? "integer" : "string" }])), required: fields } });

test("intent schemas keep action parameters and explicit endpoint evidence while the host owns volatile context", async () => {
	const source = entry("build", ["sessionId", "planetId", "buildingItemId", "expectedPlayerStateHash", "sourceObjectId", "expectedSourceStateHash"]);
	const schema = gameActionIntentSchema(source);
	assert.deepEqual(schema.required, ["buildingItemId", "sourceObjectId", "expectedSourceStateHash"]);
	assert.ok(source.inputSchema.properties.expectedPlayerStateHash);
	const resolved = await resolveGameActionContext(session, source, { buildingItemId: 2001, sourceObjectId: 3, expectedSourceStateHash: endpointHash }, async () => ({ success: true, result: { stateHash: playerHash } }));
	assert.equal(resolved.args.expectedSourceStateHash, endpointHash);
	assert.equal(resolved.args.expectedPlayerStateHash, playerHash);
	assert.equal(resolved.args.sessionId, session.context.sessionId);
});

test("resource evidence is freshly read and the player evidence is acquired last", async () => {
	const source = entry("harvest", ["sessionId", "planetId", "resourceKind", "nodeId", "requestedYieldCount", "expectedResourceStateHash", "expectedPlayerStateHash"]), reads = [];
	const resolved = await resolveGameActionContext(session, source, { resourceKind: "vein", nodeId: 2, requestedYieldCount: 20 }, async (name, args) => {
		reads.push({ name, args });
		return { success: true, result: { stateHash: name.endsWith("player_state") ? playerHash : resourceHash } };
	});
	assert.deepEqual(reads.map(read => read.name), ["spherewright_inspect_resource_node", "spherewright_get_player_state"]);
	assert.equal(resolved.args.expectedResourceStateHash, resourceHash);
	assert.equal(resolved.args.expectedPlayerStateHash, playerHash);
	await assert.rejects(resolveGameActionContext(session, source, { sessionId: "foreign" }, async () => { throw Error("MUST_NOT_READ"); }), /GAME_ACTION_CONTEXT_IS_HOST_OWNED/);
});

test("active storage uses its fresh mutable hash after confirming the previously observed endpoint identity", async () => {
	const source = entry("transfer", ["sessionId", "planetId", "storageEntityId", "itemId", "count", "direction", "expectedStorageStateHash", "expectedPlayerStateHash"]);
	const args = { storageEntityId: 3, itemId: 1001, count: 20, direction: "storage-to-player" };
	const read = async name => ({ success: true, result: name.endsWith("player_state") ? { stateHash: playerHash } : { endpointStateHash: endpointHash, stateHash: storageHash } });
	await assert.rejects(resolveGameActionContext(session, source, args, read), /GAME_ACTION_TARGET_OBSERVATION_REQUIRED/);
	await assert.rejects(resolveGameActionContext(session, source, args, read, () => playerHash), /GAME_ACTION_TARGET_CHANGED/);
	const result = await resolveGameActionContext(session, source, args, read, () => endpointHash);
	assert.equal(result.args.expectedStorageStateHash, storageHash);
	assert.equal(result.args.count, 20);
});

test("unavailable state bindings fail before a native preparation can be formed", async () => {
	const source = entry("handcraft", ["sessionId", "planetId", "recipeId", "count", "expectedPlayerStateHash"]);
	for (const reply of [{ success: false }, { success: true, result: {} }, { success: true, result: { stateHash: "wrong-domain" } }]) {
		await assert.rejects(resolveGameActionContext(session, source, { recipeId: 1, count: 2 }, async () => reply), /GAME_ACTION_EVIDENCE_UNAVAILABLE/);
	}
});

test("device configuration uses the mode's required hash domain and preserves explicit specialized evidence", async () => {
	const source = entry("configure_building", ["sessionId", "planetId", "entityId", "recipeId", "mode", "expectedFactoryStateHash"]);
	assert.ok(!gameActionIntentSchema(source).required.includes("expectedFactoryStateHash"));
	const read = async () => ({ success: true, result: { endpointStateHash: endpointHash, stateHash: storageHash, configurationStateHash: resourceHash } });
	const production = await resolveGameActionContext(session, source, { entityId: 3, recipeId: 1, mode: "production" }, read, () => endpointHash);
	assert.equal(production.args.expectedFactoryStateHash, storageHash);
	const filter = await resolveGameActionContext(session, source, { entityId: 3, recipeId: 0, mode: "sorter-filter" }, read, () => endpointHash);
	assert.equal(filter.args.expectedFactoryStateHash, resourceHash);
	await assert.rejects(resolveGameActionContext(session, source, { entityId: 0, recipeId: 0, mode: "dyson-structure" }, read), /GAME_ACTION_EXPLICIT_EVIDENCE_REQUIRED/);
	const explicit = await resolveGameActionContext(session, source, { entityId: 0, recipeId: 0, mode: "dyson-structure", expectedFactoryStateHash: resourceHash }, async () => { throw Error("MUST_NOT_READ"); });
	assert.equal(explicit.args.expectedFactoryStateHash, resourceHash);
});
