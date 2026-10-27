import assert from "node:assert/strict";

// This matrix changes Deck only. The original synthetic service protocol and
// fixed Pi runtime must be identical; it grants no server-version migration.
export function validateActionUpgradePair(baseline, candidate) {
	for (const value of [baseline, candidate]) {
		assert.match(value.sourceRevision, /^[a-f0-9]{40}$/); assert.match(value.piCommit, /^[a-f0-9]{40}$/);
		assert.equal(value.portableStorageFaults, 1); assert.equal(value.nativeProcessObserver, 1);
	}
	assert.notEqual(baseline.sourceRevision, candidate.sourceRevision, "ACTION_UPGRADE_REQUIRES_DISTINCT_REVISIONS");
	assert.equal(baseline.piCommit, candidate.piCommit, "ACTION_UPGRADE_PI_RUNTIME_CHANGED");
	for (const path of ["resources/app/test/fixtures/research-mcp-server.mjs", "resources/app/apps/desktop/research-preview.mjs"]) {
		const before = baseline.files.find(file => file.path === path), after = candidate.files.find(file => file.path === path);
		assert.ok(before && after, "ACTION_UPGRADE_SERVICE_SOURCE_MISSING"); assert.match(before.sha256, /^[a-f0-9]{64}$/);
		assert.equal(before.sha256, after.sha256, "ACTION_UPGRADE_SERVICE_PROTOCOL_CHANGED");
	}
}

export function actionUpgradeStages(scenario) {
	assert.ok(["terminal", "receipt"].includes(scenario), "ACTION_UPGRADE_SCENARIO_INVALID");
	return [
		{ phase: "fault", role: "baseline", resume: false, ordinary: false },
		{ phase: "upgrade", role: "candidate", resume: true, ordinary: false },
		...(scenario === "terminal" ? [{ phase: "closed-reopen", role: "candidate", ordinary: true }] : [{ phase: "blocked-rollback", role: "baseline", resume: true, ordinary: false }]),
	];
}
