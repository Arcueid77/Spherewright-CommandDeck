import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerGameControl } from "../apps/desktop/owner-game-control.mjs";

function fixture(overrides = {}) {
	const calls = [], authority = {};
	const dependencies = {
		enabled: true, ready: async () => {}, approvalAuthority: authority,
		native: { request: async () => ({ kind: "dsp", attached: true, gameParentMatches: true, nativeParentMatches: true, clientWidth: 800, clientHeight: 600 }) },
		api: async (...args) => { calls.push(args); return { started: true }; },
		game: { currentTaskId: "task", snapshot: () => ({}), confirmation: (...args) => { calls.push(args); return { nonce: "nonce" }; }, confirm: (...args) => { calls.push(args); return { confirmed: true }; }, stop: () => {} },
		openPanel: () => calls.push("panel"), ...overrides,
	};
	return { control: createOwnerGameControl(dependencies), calls, authority };
}

test("owner game control requires explicit startup delegation", () => {
	assert.throws(() => createOwnerGameControl({ enabled: false }), /EXPLICIT_OWNER_GAME_CONTROL_REQUIRED/);
});

test("owner game control requires a physically embedded DSP before starting or confirming", async () => {
	const { control, calls } = fixture({ native: { request: async () => ({ kind: "dsp", attached: true, nativeParentMatches: false }) } });
	await assert.rejects(control.start({ kind: "mcp", mode: "autonomous" }), /EMBEDDED_GAME_REQUIRED/);
	await assert.rejects(control.confirm("nonce"), /EMBEDDED_GAME_REQUIRED/);
	assert.deepEqual(calls, []);
});

test("owner game control uses the supervisor's existing task and approval authority", async () => {
	const { control, calls, authority } = fixture();
	const request = { kind: "mcp", mode: "autonomous", providerId: "existing-provider" };
	await control.start(request);
	control.confirmation();
	await control.confirm("nonce");
	assert.deepEqual(calls, [["game", { action: "start", args: request }], "panel", ["task", 2147483647], [authority, "nonce", 2147483647]]);
});
