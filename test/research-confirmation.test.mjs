import test from "node:test";
import assert from "node:assert/strict";
import { confirmResearchFromUi } from "../apps/desktop/research-confirmation.mjs";

test("native confirmation defaults to cancel and uses only host challenge identity after the actual answer", async () => {
	for (const response of [0, 1]) {
		const calls = [], overlays = [], challenge = { nonce: "host-generated", techId: 100, techName: "Observed target", planetId: 1, researchBudget: [{ itemId: 1202, name: "磁线圈", count: 10, direction: "research-consumption" }, { itemId: 6001, name: "矩阵", count: 2147483647, direction: "research-consumption" }] };
		const result = await confirmResearchFromUi({ taskId: "task", request: async (name, args) => { calls.push({ name, args }); return name === "game-confirmation" ? challenge : { phase: "confirming" }; }, hideViewport: async () => { calls.push({ name: "hide" }); }, overlay: (value) => overlays.push(value), showDialog: async (options) => { assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.deepEqual(options.buttons, ["取消", "确认入队"]); assert.ok(options.message.includes("Observed target #100")); assert.ok(options.detail.includes("本级科研总需求，后续按游戏正常规则消耗；本次仅入队")); assert.ok(options.detail.includes("磁线圈 #1202 × 10")); assert.ok(options.detail.includes("矩阵 #6001 × ≥2147483647")); assert.ok(!options.detail.includes("剩余")); assert.equal(calls.length, 2); return { response }; } });
		assert.deepEqual(overlays, [true, false]);
		assert.deepEqual(calls.map((call) => call.name), response ? ["game-confirmation", "hide", "game-confirmed"] : ["game-confirmation", "hide"]);
		if (response) assert.deepEqual(calls.at(-1).args, { nonce: "host-generated" }); else assert.equal(result.cancelled, true);
	}
});

test("lost or replaced native dialog cannot fall back to an approval and always clears the overlay", async () => {
	const calls = [], overlays = [];
	await assert.rejects(confirmResearchFromUi({ taskId: "task", request: async (name) => { calls.push(name); return { nonce: "challenge", researchBudget: [] }; }, hideViewport: async () => {}, overlay: (value) => overlays.push(value), showDialog: async () => { throw new Error("WINDOW_REPLACED"); } }), /WINDOW_REPLACED/);
	assert.deepEqual(calls, ["game-confirmation"]); assert.deepEqual(overlays, [true, false]);
});
