import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { interactiveTestEnvironment, requireInteractiveTestEnvironment } from "../apps/desktop/interactive-test-policy.mjs";

test("interactive smoke requires a hosted runner or an explicit desktop opt-in", () => {
	for (const env of [{}, { CI: "true" }, { GITHUB_ACTIONS: "true" }, { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" }]) {
		assert.equal(interactiveTestEnvironment(env), null);
		assert.throws(() => requireInteractiveTestEnvironment(env), /INTERACTIVE_TEST_REQUIRES_ISOLATED_DESKTOP/);
	}
	assert.equal(requireInteractiveTestEnvironment({ GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }), "hosted-runner");
	assert.equal(requireInteractiveTestEnvironment({ COMMANDDECK_ALLOW_VISIBLE_TEST_WINDOWS: "1" }), "explicit-interactive");
});

test("a local desktop smoke stops before it can launch Electron", () => {
	const script = fileURLToPath(new URL("../scripts/run-desktop-smoke.mjs", import.meta.url));
	const env = { ...process.env, CI: "true", GITHUB_ACTIONS: "", RUNNER_ENVIRONMENT: "", COMMANDDECK_ALLOW_VISIBLE_TEST_WINDOWS: "" };
	const child = spawnSync(process.execPath, [script], { env, encoding: "utf8", windowsHide: true, timeout: 5000 });
	assert.notEqual(child.status, 0);
	assert.match(child.stderr, /INTERACTIVE_TEST_REQUIRES_ISOLATED_DESKTOP/);
});
