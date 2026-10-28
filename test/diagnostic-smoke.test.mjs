import test from "node:test";
import assert from "node:assert/strict";
import { diagnosticSmokeFailure, diagnosticSmokeStagePrefix, diagnosticSmokeStages } from "../apps/desktop/diagnostic-smoke.mjs";

test("diagnostic failures retain only reached fixed stages and the exact known application error", () => {
	const output = diagnosticSmokeStages.slice(0, 5).map(stage => diagnosticSmokeStagePrefix + stage).join("\n") + "\nSMOKE_FAILURE UI_RECOVERY_PENDING\n";
	const failure = diagnosticSmokeFailure({ packaged: true, exitCode: 1, timedOut: false, remaining: 0, output });
	assert.deepEqual(failure, { version: 1, packaged: true, reason: "unexpected_exit", exitCode: 1, timedOut: false, ownedImagesRemaining: 0, stagesReached: diagnosticSmokeStages.slice(0, 5), lastStage: "save", applicationCode: "UI_RECOVERY_PENDING" });
	assert.equal(diagnosticSmokeFailure({ remaining: 0, timedOut: true }).reason, "application_timeout");
	assert.equal(diagnosticSmokeFailure({ remaining: 2, timedOut: true }).reason, "process_exit_unconfirmed");
});

test("diagnostic failure summaries never project raw errors, paths, arbitrary codes or malformed progress", () => {
	const secret = "PRIVATE_CREDENTIAL_AND_PATH";
	const failure = diagnosticSmokeFailure({ packaged: secret, exitCode: -1, remaining: secret, output: [secret, diagnosticSmokeStagePrefix + secret, "SMOKE_FAILURE " + secret, "SMOKE_FAILURE UI_TEST_TIMEOUT " + secret, "prefix " + diagnosticSmokeStagePrefix + "save"].join("\n") });
	assert.equal(failure.applicationCode, "UNCLASSIFIED_APPLICATION_ERROR"); assert.equal(failure.lastStage, "not-started"); assert.deepEqual(failure.stagesReached, []);
	assert.equal(failure.exitCode, null); assert.equal(failure.ownedImagesRemaining, null); assert.equal(failure.packaged, false); assert.ok(!JSON.stringify(failure).includes(secret));
});
