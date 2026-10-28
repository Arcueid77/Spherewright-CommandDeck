import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { portableGatewayCase, assertPortableGatewayAction, preparePortableMode } from "../apps/desktop/portable-mode.mjs";
import { readGatewayExitConfig } from "../apps/desktop/agent-gateway-packaged-smoke.mjs";

async function fixture(t) {
	const temporary = await realpath(tmpdir()), root = await realpath(await mkdtemp(join(temporary, "commanddeck-desktop-smoke-")));
	t.after(async () => { assert.equal(dirname(await realpath(root)).toLowerCase(), temporary.toLowerCase()); await rm(root, { recursive: true, force: true }); });
	return { root, runId: randomUUID() };
}

test("packaged gateway admission needs the isolated package profile and exactly one bounded phase", async t => {
	assert.equal(portableGatewayCase([]), null);
	for (const phase of ["record", "reopen"]) assert.deepEqual(portableGatewayCase(["--portable-smoke", "--portable-gateway=" + phase]), { phase });
	for (const argv of [["--portable-gateway=record"], ["--portable-smoke", "--portable-gateway"], ["--portable-smoke", "--portable-gateway=other"], ["--portable-smoke", "--portable-gateway=record", "--portable-gateway=reopen"], ["--portable-smoke", "--portable-gateway=record", "--portable-runtime-loss=idle"], ["--portable-smoke", "--portable-gateway=reopen", "--portable-development-usage=record"]]) assert.throws(() => portableGatewayCase(argv), /PACKAGED_GATEWAY_CASE_REQUIRED/);
	const context = await fixture(t), env = { COMMANDDECK_PORTABLE_ROOT: context.root, COMMANDDECK_PORTABLE_RUN_ID: context.runId }, paths = [];
	const app = { isPackaged: true, setPath: (...args) => paths.push(args) }, argv = ["--portable-smoke", "--portable-gateway=record"];
	await assert.rejects(preparePortableMode({ ...app, isPackaged: false }, argv, { ...env }), /PACKAGED_PORTABLE_SMOKE_REQUIRED/);
	assert.deepEqual(await preparePortableMode(app, argv, env), context); assert.deepEqual(paths, [["userData", join(context.root, "supervisor-profile")]]);
	assert.equal(env.COMMANDDECK_PI_CONFIG_DIR, join(context.root, "no-user-provider-configuration"));
});

test("gateway fixture rejects execution, keeps service selection internal and admits only the record-phase mecha toggle", () => {
	for (const enabled of [false, true]) assertPortableGatewayAction("bridge", { action: "mecha", args: { enabled } }, { phase: "record" });
	for (const args of [{ enabled: "true" }, { enabled: true, extra: "no" }, {}]) assert.throws(() => assertPortableGatewayAction("bridge", { action: "mecha", args }, { phase: "record" }), /PORTABLE_SMOKE_ACTION_REJECTED/);
	assert.throws(() => assertPortableGatewayAction("bridge", { action: "mecha", args: { enabled: true } }, { phase: "reopen" }), /PORTABLE_SMOKE_ACTION_REJECTED/);
	for (const phase of ["record", "reopen"]) {
		for (const action of ["snapshot", "start", "copy", "stop"]) assertPortableGatewayAction("gateway", { action }, { phase });
		for (const [action, args] of [["probe", { mode: "offline" }], ["probe", { mode: "live" }], ["attach", "owned-fixture"], ["start-fixture"], ["game", { action: "start" }], ["game-confirmed", {}], ["workbench", { action: "check" }], ["workbench", { action: "agent" }], ["workbench", { action: "edit" }], ["profiles-manage", { action: "save" }], ["journal", { action: "start" }]]) assert.throws(() => assertPortableGatewayAction(action, args, { phase, internal: true }), /PORTABLE_SMOKE_ACTION_REJECTED/);
		for (const action of ["refresh", "disconnect"]) {
			assert.throws(() => assertPortableGatewayAction("bridge", { action }, { phase }), /PORTABLE_SMOKE_ACTION_REJECTED/);
			if (phase === "record") assertPortableGatewayAction("bridge", { action }, { phase, internal: true }); else assert.throws(() => assertPortableGatewayAction("bridge", { action }, { phase, internal: true }), /PORTABLE_SMOKE_ACTION_REJECTED/);
		}
	}
});

test("old config verification cannot launch a substituted executable, script, extra arguments or environment", async t => {
	const context = await fixture(t), file = join(context.root, "gateway-exit-config.private.json"), command = join(context.root, "bundle/Spherewright-CommandDeck.exe"), script = join(context.root, "bundle/resources/app/apps/desktop/agent-gateway-stdio.mjs");
	const config = { command, args: [script], env: { ELECTRON_RUN_AS_NODE: "1", COMMANDDECK_GATEWAY_PIPE: "\\\\.\\pipe\\Spherewright-CommandDeck-ReadOnly-" + randomUUID(), COMMANDDECK_GATEWAY_KEY: "1".repeat(64) } };
	await writeFile(file, JSON.stringify(config)); assert.deepEqual(await readGatewayExitConfig(context, command, script), config);
	for (const invalid of [{ ...config, command: "some-other-program" }, { ...config, args: [script, "extra"] }, { ...config, args: ["other-script"] }, { ...config, env: { ...config.env, NODE_OPTIONS: "--require=anything" } }, { ...config, env: { ...config.env, ELECTRON_RUN_AS_NODE: "0" } }]) { await writeFile(file, JSON.stringify(invalid)); await assert.rejects(readGatewayExitConfig(context, command, script)); }
});
