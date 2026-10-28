import test from "node:test";
import assert from "node:assert/strict";
import { portableStorageCase, portableStorageScenarios, assertPortableStorageAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";

test("packaged storage fault and resume require one explicit isolated scenario with no mixed fault mode", () => {
	assert.equal(portableStorageCase([]), null);
	for (const scenario of portableStorageScenarios) for (const resume of [false, true]) assert.deepEqual(portableStorageCase(["--portable-smoke", "--portable-storage-fault=" + scenario, ...(resume ? ["--portable-storage-resume"] : [])]), { scenario, resume });
	for (const args of [["--portable-storage-resume"], ["--portable-smoke", "--portable-storage-resume"], ["--portable-storage-fault=receipt"], ["--portable-smoke", "--portable-storage-fault=unknown"], ["--portable-smoke", "--portable-storage-fault=receipt", "--portable-storage-fault=terminal"], ["--portable-smoke", "--portable-storage-fault=receipt", "--portable-storage-resume=yes"], ["--portable-smoke", "--portable-storage-fault=terminal", "--portable-diagnostics"], ["--portable-smoke", "--portable-storage-fault=terminal", "--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-storage-fault=terminal", "--portable-mcp-loss=accepted"]]) assert.throws(() => portableStorageCase(args), /PACKAGED_PORTABLE_STORAGE_CASE_REQUIRED/);
	for (const scenario of ["receipt-runtime", "terminal-runtime"]) for (const other of ["--portable-runtime-loss=accepted", "--portable-mcp-loss=lost-ack", "--portable-diagnostics"]) assert.throws(() => portableStorageCase(["--portable-smoke", "--portable-storage-fault=" + scenario, other]), /PACKAGED_PORTABLE_STORAGE_CASE_REQUIRED/);
});

test("the storage fixture cannot allocate probes, real MCP selections or renderer providers and retains trusted diagnostic checks", () => {
	for (const [action, args] of [["probe", { mode: "live" }], ["probe", { mode: "offline" }], ["attach", "owned-fixture"], ["start-fixture", {}], ["bridge-select", "external"], ["profiles-manage", { action: "save" }], ["workbench", { action: "check" }]]) assert.throws(() => assertPortableStorageAction(action, args), /PORTABLE_SMOKE_ACTION_REJECTED/);
	assert.doesNotThrow(() => assertPortableStorageAction("diagnostics-preview", {}));
	assert.doesNotThrow(() => assertPortableStorageAction("game", { action: "reconcile" }));
	assert.doesNotThrow(() => assertPortableStorageAction("bridge-select", "fixed-fixture", { internal: true }));
});

test("storage fixture admission rejects source executables and missing isolation before selecting a user profile", async () => {
	let profileChanges = 0; const app = { isPackaged: false, setPath() { profileChanges++; } }, args = ["--portable-smoke", "--portable-storage-fault=receipt"];
	await assert.rejects(preparePortableMode(app, args, {}), /PACKAGED_PORTABLE_SMOKE_REQUIRED/);
	app.isPackaged = true; await assert.rejects(preparePortableMode(app, args, {}), /PACKAGED_PORTABLE_SMOKE_REQUIRED/); assert.equal(profileChanges, 0);
});
