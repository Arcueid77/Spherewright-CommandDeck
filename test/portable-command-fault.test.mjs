import test from "node:test";
import assert from "node:assert/strict";
import { portableCommandCase, portableCommandScenarios, assertPortableCommandAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { commandFixtureFiles, validateCommandWorkspace } from "../apps/desktop/command-fault-smoke.mjs";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createCommandHelperFaultFixture } from "../apps/desktop/command-helper-fault-fixture.mjs";

test("packaged command interruptions require one explicit isolated scenario and reject mixed modes before profile selection", async () => {
	for (const scenario of portableCommandScenarios) for (const resume of [false, true]) assert.deepEqual(portableCommandCase(["--portable-smoke", "--portable-command-loss=" + scenario, ...(resume ? ["--portable-command-resume"] : [])]), { scenario, resume });
	for (const args of [["--portable-command-loss=runtime"], ["--portable-smoke", "--portable-command-resume"], ["--portable-smoke", "--portable-command-loss=other"], ["--portable-smoke", "--portable-command-loss=reload", "--portable-command-loss=runtime"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-storage-fault=receipt"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-command-loss=runtime", "--portable-mcp-loss=accepted"], ["--portable-smoke", "--portable-command-loss=reload", "--portable-diagnostics"]]) assert.throws(() => portableCommandCase(args));
	let changes = 0; const app = { isPackaged: false, setPath() { changes++; } };
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-command-loss=runtime"], {}), /PACKAGED_PORTABLE_SMOKE_REQUIRED/); assert.equal(changes, 0);
});

test("command fixture admits only the selected workspace check and cannot grant roots, models or game execution", () => {
	const scope = { rootId: "owned-root" };
	assert.doesNotThrow(() => assertPortableCommandAction("workbench", { action: "check", args: { rootId: scope.rootId, checkId: "npm:test" } }, scope));
	for (const [action, args] of [["workbench", { action: "check", args: { rootId: "other", checkId: "npm:test" } }], ["workbench", { action: "check", args: { rootId: scope.rootId, checkId: "npm:build" } }], ["workbench", { action: "add" }], ["workbench", { action: "grants" }], ["workbench", { action: "agent" }], ["workbench", { action: "stop-command-helper-fixture" }], ["workbench", { action: "save" }], ["probe", { mode: "offline" }], ["probe", { mode: "live" }], ["start-fixture", {}], ["bridge-select", "external"], ["game", { action: "start" }], ["profiles-manage", { action: "save" }]]) assert.throws(() => assertPortableCommandAction(action, args, scope), /PORTABLE_SMOKE_ACTION_REJECTED/);
});

test("workspace admission requires the exact fixed check source and refuses caller-supplied code", async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-command-admission-"))), workspace = join(root, "command-workspace"); await mkdir(workspace);
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-command-admission-")); await rm(canonical, { recursive: true }); });
	for (const [name, source] of Object.entries(commandFixtureFiles)) await writeFile(join(workspace, name), source);
	assert.equal(await validateCommandWorkspace({ root }), workspace);
	await writeFile(join(workspace, "check.cjs"), "throw new Error('unapproved fixture source');\n"); await assert.rejects(validateCommandWorkspace({ root }));
	assert.equal(await readFile(join(workspace, "check.cjs"), "utf8"), "throw new Error('unapproved fixture source');\n");
});

test("the helper-loss handle owner cannot be installed for another mode or unscoped profile", async () => {
	for (const context of [null, { scenario: "exit", resume: false }, { scenario: "helper", resume: true }, { scenario: "helper", resume: false, runId: "invalid" }]) await assert.rejects(createCommandHelperFaultFixture({ context, directory: "" }), /COMMAND_HELPER_FIXTURE_REQUIRED/);
});
