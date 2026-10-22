import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isCurrentElectronUi, spawnOwnedUi, registerOwnedUi } from "../apps/desktop/owned-ui-process.mjs";

test("a renamed packaged UI must be the supervisor's own Electron executable and explicit UI role", () => {
	const executable = join(tmpdir(), "Spherewright CommandDeck", "Spherewright-CommandDeck.exe"), context = { currentExecutable: executable, electron: true };
	assert.equal(isCurrentElectronUi(executable, ["--managed-ui"], context), true);
	assert.equal(isCurrentElectronUi(executable.toUpperCase(), ["--managed-ui"], context), true);
	assert.equal(isCurrentElectronUi(executable, [], context), false);
	assert.equal(isCurrentElectronUi(executable, ["--managed-ui", "--owned-host-fixture"], context), false);
	assert.equal(isCurrentElectronUi(executable, ["--managed-ui"], { ...context, electron: false }), false);
});

test("matching executable names, relative paths, Node processes and adopted PIDs cannot grant UI ownership", () => {
	const executable = join(tmpdir(), "own", "electron.exe"), context = { currentExecutable: executable, electron: true };
	assert.equal(isCurrentElectronUi(join(tmpdir(), "other", "electron.exe"), ["--managed-ui"], context), false);
	assert.equal(isCurrentElectronUi("electron.exe", ["--managed-ui"], context), false);
	assert.throws(() => spawnOwnedUi(process.execPath, ["--managed-ui"], {}), /UI_LAUNCH_ROLE_REJECTED/);
	assert.throws(() => registerOwnedUi({ pid: process.pid }), /UI_CREATION_HANDLE_REQUIRED/);
});
