import test from "node:test";
import assert from "node:assert/strict";
import { osStorageFailure } from "../scripts/os-storage-failure.mjs";
test("OS storage failure summaries retain fixed phases without exposing raw child output", () => {
	const output = "PRIVATE_CREDENTIAL_AND_PATH\nSTARTUP_STORAGE_UNAVAILABLE\nCOMMANDDECK_STARTUP_STAGE:window-created\nCOMMANDDECK_STARTUP_STAGE:loading-document\nCOMMANDDECK_STARTUP_STAGE:PRIVATE_CREDENTIAL_AND_PATH\n";
	const value = osStorageFailure({ kind: "legacy-game", phase: "blocked-reopen", fault: "windows-acl-write-deny", code: null, expectedCode: 1, timedOut: true, remaining: 0, output });
	assert.equal(value.reason, "application_timeout"); assert.deepEqual(value.startupStages, ["window-created", "loading-document"]); assert.deepEqual(value.startupCodes, ["STARTUP_STORAGE_UNAVAILABLE"]); assert.ok(!JSON.stringify(value).includes("PRIVATE"));
	assert.equal(osStorageFailure({ kind: "workbench-history", phase: "restored", fault: "windows-readonly-file-attribute", code: 1, expectedCode: 0, timedOut: false, remaining: 2, output }).reason, "process_exit_unconfirmed");
	assert.equal(osStorageFailure({ kind: "legacy-game", phase: "blocked", fault: "windows-acl-write-deny", code: 1, expectedCode: 1, timedOut: false, remaining: 0, output, progressConfirmed: false }).reason, "startup_progress_unconfirmed");
	assert.throws(() => osStorageFailure({ kind: "PRIVATE", phase: "blocked", fault: "windows-acl-write-deny", expectedCode: 1, timedOut: true }), /OS_STORAGE_FAILURE_SCOPE_INVALID/);
});
