import test from "node:test";
import assert from "node:assert/strict";
import { portableCommandCase, assertPortableCommandAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";

test("packaged command interruptions require one explicit isolated scenario and reject mixed modes before profile selection", async () => {
	for (const scenario of ["reload", "runtime"]) for (const resume of [false, true]) assert.deepEqual(portableCommandCase(["--portable-smoke", "--portable-command-loss=" + scenario, ...(resume ? ["--portable-command-resume"] : [])]), { scenario, resume });
	for (const args of [["--portable-command-loss=runtime"], ["--portable-smoke", "--portable-command-resume"], ["--portable-smoke", "--portable-command-loss=other"], ["--portable-smoke", "--portable-command-loss=reload", "--portable-command-loss=runtime"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-storage-fault=receipt"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-mcp-loss=accepted"], ["--portable-smoke", "--portable-command-loss=reload", "--portable-diagnostics"]]) assert.throws(() => portableCommandCase(args));
	let changes = 0; const app = { isPackaged: false, setPath() { changes++; } };
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-command-loss=runtime"], {}), /PACKAGED_PORTABLE_SMOKE_REQUIRED/); assert.equal(changes, 0);
});

test("command fixture admits only the selected workspace check and cannot grant roots, models or game execution", () => {
	const scope = { rootId: "owned-root" };
	assert.doesNotThrow(() => assertPortableCommandAction("workbench", { action: "check", args: { rootId: scope.rootId, checkId: "npm:test" } }, scope));
	for (const [action, args] of [["workbench", { action: "check", args: { rootId: "other", checkId: "npm:test" } }], ["workbench", { action: "check", args: { rootId: scope.rootId, checkId: "npm:build" } }], ["workbench", { action: "add" }], ["workbench", { action: "grants" }], ["workbench", { action: "agent" }], ["workbench", { action: "save" }], ["probe", { mode: "offline" }], ["probe", { mode: "live" }], ["start-fixture", {}], ["bridge-select", "external"], ["game", { action: "start" }], ["profiles-manage", { action: "save" }]]) assert.throws(() => assertPortableCommandAction(action, args, scope), /PORTABLE_SMOKE_ACTION_REJECTED/);
});
