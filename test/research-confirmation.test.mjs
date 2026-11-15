import test from "node:test";
import assert from "node:assert/strict";
import { confirmResearchFromUi, startAutonomousGameFromUi, startGameExitFromUi, startGameRecoveryFromUi } from "../apps/desktop/research-confirmation.mjs";

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

test("the run dialog discloses the exact goal, operation types and budget and consumes only the host nonce", async () => {
	for (const response of [0, 1]) {
		const calls = [], overlays = [], challenge = { kind: "mcp-run", nonce: "native-run-nonce", goal: "Supply the finite synthetic line", context: { loaded: true }, allowedFamilies: ["handcraft", "save"], limits: { modelRequests: 12, toolCalls: 60, writes: 8, durationMs: 60000 } };
		await confirmResearchFromUi({ taskId: "original-task", request: async (name, args) => { calls.push({ name, args }); return name === "game-confirmation" ? challenge : { confirmed: true }; }, hideViewport: async () => {}, overlay: value => overlays.push(value), showDialog: async options => { assert.equal(options.defaultId, 0); assert.equal(options.cancelId, 0); assert.equal(options.message, challenge.goal); assert.ok(options.detail.includes("12次模型请求、60次工具调用、8次提交")); assert.ok(options.detail.includes("handcraft、save")); assert.ok(options.detail.includes("正常保存")); assert.ok(options.detail.includes("重开不恢复本轮授权")); return { response }; } });
		assert.deepEqual(overlays, [true, false]); assert.deepEqual(calls.at(-1), response ? { name: "game-confirmed", args: { nonce: "native-run-nonce" } } : { name: "game", args: { action: "stop" } });
	}
});

test("the trusted Start handler waits for the prepared run and opens one exact authorization dialog", async () => {
	const calls = [], confirmed = [];
	const result = await startAutonomousGameFromUi({ args: { action: "start", args: { mode: "autonomous" } }, request: async (name, args) => { calls.push({ name, args }); return args.action === "start" ? { busy: true, currentTaskId: null } : { busy: true, currentTaskId: "new-task", mcp: { awaitingAuthorization: true } }; }, confirm: async id => { confirmed.push(id); return { confirmed: true }; } });
	assert.deepEqual(confirmed, ["new-task"]); assert.equal(calls.length, 2); assert.equal(result.confirmed, true);
});

test("authorization setup timeout stops the pending round rather than inventing approval", async () => {
	const calls = []; let confirms = 0;
	await assert.rejects(startAutonomousGameFromUi({ args: { action: "start" }, timeoutMs: 0, request: async (name, args) => { calls.push({ name, args }); return { busy: true, currentTaskId: "task" }; }, confirm: async () => { confirms++; } }), /GAME_AUTHORIZATION_SETUP_TIMEOUT/);
	assert.equal(confirms, 0); assert.deepEqual(calls.at(-1), { name: "game", args: { action: "stop" } });
});

test("save and exit asks once after preparation and cancellation submits nothing", async () => {
	for (const response of [0, 1]) {
		const calls = [], overlay = [];
		const request = async (name, args) => {
			calls.push({ name, args });
			if (name === "game" && args.action === "exit-prepare") return { busy: true };
			if (name === "game" && args.action === "snapshot") return { busy: false, phase: "awaiting_approval", currentTaskId: "exit-task" };
			if (name === "game-confirmation") return { kind: "game-exit", nonce: "original-exit", taskId: "exit-task" };
			return { confirmed: true };
		};
		const result = await startGameExitFromUi({ request, confirm: taskId => confirmResearchFromUi({ taskId, request, hideViewport: async () => {}, overlay: value => overlay.push(value), showDialog: async options => { assert.deepEqual(options.buttons, ["取消", "保存并退出"]); assert.equal(options.defaultId, 0); return { response }; } }) });
		assert.deepEqual(overlay, [true, false]);
		assert.deepEqual(calls.at(-1), response ? { name: "game-confirmed", args: { nonce: "original-exit" } } : { name: "game", args: { action: "stop" } });
		assert.equal(response ? result.confirmed : result.cancelled, true);
	}
});

test("save and exit does not ask for approval when preparation fails", async () => {
	let confirmed = 0;
	await assert.rejects(startGameExitFromUi({ request: async () => ({ busy: false, phase: "failed", error: "GAME_EXIT_PREVIEW_REJECTED" }), confirm: async () => { confirmed++; } }), /GAME_EXIT_PREVIEW_REJECTED/);
	assert.equal(confirmed, 0);
});

test("saved-world recovery asks once and confirms only its host nonce", async () => {
	for (const response of [0, 1]) {
		const calls = [];
		const request = async (name, args) => {
			calls.push({ name, args });
			if (name === "game" && args.action === "recovery-prepare") return { busy: false, phase: "awaiting_approval", currentTaskId: "restore-task" };
			if (name === "game-confirmation") return { kind: "game-recovery", nonce: "original-restore", taskId: "restore-task", savedAt: 1000, savedTick: 1234, worldLabel: "Synthetic world" };
			return { confirmed: true };
		};
		const result = await startGameRecoveryFromUi({ request, confirm: taskId => confirmResearchFromUi({ taskId, request, hideViewport: async () => {}, overlay: () => {}, showDialog: async options => { assert.deepEqual(options.buttons, ["取消", "恢复世界"]); assert.ok(options.detail.includes("旧任务保持停止")); assert.ok(options.detail.includes("1234")); assert.ok(options.message.includes("Synthetic world")); return { response }; } }) });
		assert.deepEqual(calls.at(-1), response ? { name: "game-confirmed", args: { nonce: "original-restore" } } : { name: "game", args: { action: "stop" } });
		assert.equal(response ? result.confirmed : result.cancelled, true);
	}
});
