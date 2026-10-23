import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, mkdir, writeFile, readFile, symlink, link, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { portableRuntimeScenario, assertPortableRuntimeAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { syntheticProviderScope, preparePortableFixtureDirectory } from "../apps/desktop/synthetic-scope.mjs";

async function fixture(t) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "commanddeck-desktop-smoke-")));
	t.after(async () => { const canonical = await realpath(root); assert.equal(canonical, root); assert.equal(dirname(canonical).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(canonical).startsWith("commanddeck-desktop-smoke-")); await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
	return { root, runId: randomUUID() };
}

test("packaged runtime scenarios require one explicit isolated mode and never accept source-mode flags", async t => {
	const f = await fixture(t), calls = [], app = { isPackaged: true, setPath: (...args) => calls.push(args) }, env = { COMMANDDECK_PORTABLE_ROOT: f.root, COMMANDDECK_PORTABLE_RUN_ID: f.runId };
	for (const scenario of ["idle", "confirmation", "accepted", "planning"]) assert.equal(portableRuntimeScenario(["--portable-smoke", "--portable-runtime-loss=" + scenario]), scenario);
	for (const args of [["--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-runtime-loss=other"], ["--portable-smoke", "--portable-runtime-loss=idle", "--portable-runtime-loss=planning"]]) assert.throws(() => portableRuntimeScenario(args));
	await preparePortableMode(app, ["--portable-smoke", "--portable-runtime-loss=confirmation"], env); assert.equal(env.COMMANDDECK_SMOKE_RUN_ID, f.runId);
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-runtime-loss=confirmation", "--smoke-game"], env));
	await assert.rejects(preparePortableMode(app, ["--portable-smoke", "--portable-runtime-loss=confirmation", "--smoke-game-ui"], env));
	await preparePortableMode(app, ["--portable-smoke", "--portable-runtime-loss=confirmation", "--managed-ui", "--smoke-game-ui"], env); assert.ok(calls.length >= 2);
});

test("the packaged fixture policy never gives the renderer provider, MCP-selection or development execution authority", () => {
	for (const scenario of ["idle", "confirmation", "accepted", "planning"]) {
		for (const [action, args] of [["profiles-manage", { action: "save" }], ["bridge-select", "untrusted.exe"], ["workbench", { action: "agent" }], ["workbench", { action: "check" }], ["probe", { mode: "live" }], ["attach", "real-game"]]) assert.throws(() => assertPortableRuntimeAction(action, args, { scenario }));
		assert.throws(() => assertPortableRuntimeAction("workbench", { action: "agent" }, { scenario, internal: true }));
	}
	assertPortableRuntimeAction("game", { action: "start" }, { scenario: "confirmation" });
	assertPortableRuntimeAction("profiles-manage", { action: "save" }, { scenario: "planning", internal: true });
	assert.throws(() => assertPortableRuntimeAction("game", { action: "start" }, { scenario: "idle", internal: true }));
});

test("a synthetic provider must be the current owned listener, profile and key before any credential is delivered", async t => {
	const server = createServer((_request, response) => response.end()); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { if (server.listening) await new Promise(resolve => server.close(resolve)); });
	const scope = syntheticProviderScope(), id = "deckvault-" + randomUUID(), key = "synthetic-game-smoke-" + randomUUID();
	assert.throws(() => scope.assertReference(id, "fixture")); scope.register(server, id, key);
	const draft = { id, key, apiKey: key, api: "openai-completions", modelId: "fixture", baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
	scope.assertDraft(draft); scope.assertResolved(draft); scope.assertReference(id, "fixture");
	for (const change of [{ baseUrl: "https://example.invalid/v1" }, { apiKey: "different" }, { modelId: "real-model" }, { id: "another-profile" }]) assert.throws(() => scope.assertDraft({ ...draft, ...change }), /SYNTHETIC_PROVIDER_REQUIRED/);
	assert.throws(() => scope.register(server, id, key)); await new Promise(resolve => server.close(resolve)); assert.throws(() => scope.assertResolved(draft), /SYNTHETIC_PROVIDER_NOT_BOUND/);
});

test("fixture directories are new physical children and cannot redirect writes through a junction", async t => {
	const f = await fixture(t), first = await preparePortableFixtureDirectory(f); assert.ok(first.endsWith(f.runId)); await assert.rejects(preparePortableFixtureDirectory(f), /ALREADY_EXISTS/);
	const second = await fixture(t), target = await fixture(t); await symlink(target.root, join(second.root, "runtime-fixtures"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(preparePortableFixtureDirectory(second), /DIRECTORY_REDIRECTED/); await assert.rejects(readFile(join(target.root, "m3-smoke", second.runId, "Spherewright.Mcp.exe")), { code: "ENOENT" });
});

test("profile aliases are refused before userData admission or database opening", async t => {
	const f = await fixture(t), profile = join(f.root, "supervisor-profile"), target = await fixture(t); await mkdir(profile); await writeFile(join(target.root, "original.sqlite"), "owned canary");
	await link(join(target.root, "original.sqlite"), join(profile, "aliased.sqlite")); let admitted = false;
	await assert.rejects(preparePortableMode({ isPackaged: true, setPath: () => { admitted = true; } }, ["--portable-smoke"], { COMMANDDECK_PORTABLE_ROOT: f.root, COMMANDDECK_PORTABLE_RUN_ID: f.runId }), /PROFILE_REDIRECTED/);
	assert.equal(admitted, false); assert.equal(await readFile(join(target.root, "original.sqlite"), "utf8"), "owned canary");
});
