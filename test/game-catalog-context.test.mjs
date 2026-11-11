import test from "node:test";
import assert from "node:assert/strict";
import { gameCatalogIndex, gameCatalogDetails } from "../apps/desktop/game-catalog-context.mjs";

test("native catalog indexing preserves IDs, current metadata and prerequisites without mutating full evidence", () => {
	const source = "spherewright_get_progression_state";
	const reply = { success: true, result: { capturedAtGameTick: 10, currentTechId: 1, selectionStateHash: "original", technologies: [{ techId: 1, name: "Synthetic", unlocked: false, isQueued: true, prerequisiteTechIds: [2], itemRequirements: [{ itemId: 3, count: 10 }] }] } };
	const index = gameCatalogIndex(source, reply);
	assert.equal(index.result.selectionStateHash, "original");
	assert.deepEqual(index.result.technologies[0].prerequisiteTechIds, [2]);
	assert.equal(index.result.technologies[0].itemRequirements, undefined);
	assert.equal(reply.result.technologies[0].itemRequirements[0].count, 10);
	const cache = new Map([[source, { args: { sessionId: "synthetic" }, reply }]]);
	const details = gameCatalogDetails(cache, { source, collection: "technologies", ids: [1] });
	assert.deepEqual(details.result.rows, reply.result.technologies);
	assert.deepEqual(details.result.sourcePaths, ["/result/technologies/0"]);
	details.result.rows[0].itemRequirements[0].count = 99;
	details.result.sourceArgs.sessionId = "changed";
	assert.equal(reply.result.technologies[0].itemRequirements[0].count, 10);
	assert.equal(cache.get(source).args.sessionId, "synthetic");
});

test("catalog detail selection pages native rows and rejects unsupported or excessive requests", () => {
	const source = "spherewright_get_recipe_catalog", rows = Array.from({ length: 12 }, (_, index) => ({ recipeId: index + 1, name: "Synthetic recipe " + index }));
	const cache = new Map([[source, { args: {}, reply: { success: true, result: { recipes: rows } } }]]);
	const page = gameCatalogDetails(cache, { source, collection: "recipes", query: "SYNTHETIC", offset: 4, limit: 4 });
	assert.deepEqual(page.result.rows, rows.slice(4, 8));
	assert.deepEqual(page.result.sourcePaths, [4, 5, 6, 7].map(index => "/result/recipes/" + index));
	const selected = gameCatalogDetails(cache, { source, collection: "recipes", ids: [2, 10] });
	assert.deepEqual(selected.result.sourcePaths, ["/result/recipes/1", "/result/recipes/9"]);
	assert.equal(page.result.nextOffset, 8);
	assert.equal(page.result.total, 12);
	assert.equal(gameCatalogDetails(new Map(), { source, collection: "recipes" }).error.code, "GAME_CATALOG_SOURCE_REQUIRED");
	for (const args of [{ source: "__proto__", collection: "constructor" }, { source, collection: "technologies" }, { source, collection: "recipes", limit: 9 }, { source, collection: "recipes", ids: [0] }, { source, collection: "recipes", offset: -1 }]) assert.throws(() => gameCatalogDetails(cache, args), /INVALID_GAME_CATALOG_QUERY/);
});
