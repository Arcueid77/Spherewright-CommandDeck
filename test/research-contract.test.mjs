import test from "node:test";
import assert from "node:assert/strict";
import { validResearchArguments } from "../apps/desktop/research-contract.mjs";

const commit = { sessionId: "session-fixture", planetId: 1, planToken: "synthetic-native-plan-token", idempotencyKey: "81c6e420-b031-4d54-9e2f-87dd08973525" };

test("research commit arguments require a native-compatible UUID rather than an opaque prefixed key", () => {
	assert.equal(validResearchArguments("spherewright_commit_select_research", commit), true);
	assert.equal(validResearchArguments("spherewright_commit_select_research", { ...commit, idempotencyKey: commit.idempotencyKey.toUpperCase() }), true);
	for (const idempotencyKey of [undefined, null, 123, "key", "commanddeck-" + commit.idempotencyKey, " " + commit.idempotencyKey, commit.idempotencyKey + "\n", commit.idempotencyKey.replaceAll("-", ""), commit.idempotencyKey.slice(0, -1), "z" + commit.idempotencyKey.slice(1)]) assert.equal(validResearchArguments("spherewright_commit_select_research", { ...commit, idempotencyKey }), false);
});

test("session and action identities retain their existing opaque contracts", () => {
	assert.equal(validResearchArguments("spherewright_commit_select_research", { ...commit, sessionId: "opaque-session|🚀" }), true);
	assert.equal(validResearchArguments("spherewright_get_action_result", { actionId: "opaque-native-action" }), true);
	assert.equal(validResearchArguments("spherewright_get_action_result", { actionId: "bad\nidentity" }), false);
});
