import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { historyHash, portableHistoryFile } from "../apps/desktop/portable-history.mjs";
import { installerIdentity } from "../scripts/installer-files.mjs";
import { validateInstallerUpgradePair, assertInstallerRegistration, readInstalledProfileContext, installedProfileOwnerFile } from "../scripts/installer-upgrade-state.mjs";

const testIdentity = "11111111-2222-3333-4444-555555555555", oldRevision = "a".repeat(40), newRevision = "b".repeat(40);
const baseline = { testIdentity, appId: installerIdentity(testIdentity), sourceRevision: oldRevision, sha256: "c".repeat(64), perUser: true, userProfilesIncluded: false, appVersion: "0.0.1" }, candidate = { ...baseline, sourceRevision: newRevision, sha256: "d".repeat(64) };
async function temporary(t, prefix) {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	t.after(async () => { const path = await realpath(root); assert.equal(dirname(path).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(path).startsWith(prefix)); await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }); return root;
}

test("upgrade requires two explicit different candidates sharing one isolated registration", () => {
	validateInstallerUpgradePair(baseline, candidate);
	for (const changed of [{ testIdentity: null }, { testIdentity: randomUUID() }, { appId: "Spherewright.CommandDeck" }, { sourceRevision: oldRevision }, { sha256: baseline.sha256 }, { perUser: false }, { userProfilesIncluded: true }, { appVersion: "invalid" }]) assert.throws(() => validateInstallerUpgradePair(baseline, { ...candidate, ...changed }));
});

test("registration checks distinguish absent, selected revision and unknown/mismatched state", () => {
	const installation = join(tmpdir(), "isolated-install"), absent = { version: 1, registrations: [{ hive: "CurrentUser", present: false }, { hive: "LocalMachine", present: false }] };
	assertInstallerRegistration(absent, installation, null); assert.throws(() => assertInstallerRegistration(absent, installation, candidate));
	const current = { version: 1, registrations: [{ hive: "CurrentUser", present: true, InstallLocation: installation + "/", DisplayVersion: "0.0.1+" + newRevision.slice(0, 12), DisplayIcon: '"' + join(installation, "releases", newRevision, "Spherewright-CommandDeck.exe") + '",0' }, { hive: "LocalMachine", present: false }] };
	assertInstallerRegistration(current, installation, candidate); assert.throws(() => assertInstallerRegistration(current, installation, null));
	for (const [name, value] of [["DisplayVersion", "0.0.1+" + oldRevision.slice(0, 12)], ["DisplayIcon", join(installation, "releases", oldRevision, "Spherewright-CommandDeck.exe")], ["InstallLocation", tmpdir()]]) { const changed = structuredClone(current); changed.registrations[0][name] = value; assert.throws(() => assertInstallerRegistration(changed, installation, candidate)); }
	const machine = structuredClone(current); machine.registrations[1].present = true; assert.throws(() => assertInstallerRegistration(machine, installation, candidate));
	assert.throws(() => assertInstallerRegistration({ ...current, registrations: [current.registrations[0], current.registrations[0]] }, installation, candidate));
});

test("a resumed launch binds its marked physical profile, previous proof, history hash and exact target installation", async t => {
	const scope = await temporary(t, "commanddeck-installer-smoke-"), directory = await temporary(t, "commanddeck-desktop-smoke-"), runId = randomUUID(), source = join(scope, "install/releases", newRevision);
	await mkdir(source, { recursive: true }); await mkdir(join(directory, "supervisor-profile/supervisor"), { recursive: true }); await writeFile(join(scope, "installer-test-scope.txt"), testIdentity);
	const workbench = { roots: [{ enabled: false, canWrite: false, canExecute: false }], tasks: [{}], task: { state: "succeeded", invocations: [{ state: "completed" }] } }, game = { tasks: [{ state: "completed", intent: { state: "completed", idempotencyKey: "synthetic-key", actionId: "synthetic-action", terminal: {} } }] };
	const history = { version: 1, kind: "closed-synthetic-history", runId, workbench, game, sha256: historyHash({ workbench, game }) };
	await writeFile(join(directory, portableHistoryFile), JSON.stringify(history));
	const owner = { version: 1, kind: "isolated-installer-profile", scope, testIdentity, runId }; await writeFile(join(directory, installedProfileOwnerFile), JSON.stringify(owner));
	const previous = { runId, sourceRevision: oldRevision, packaged: true, closedHistoryReopened: true, history: { closedHistorySha256: history.sha256 }, gameCalls: 0, realModelRequests: 0 }, proofFile = join(directory, "application-proof.json"); await writeFile(proofFile, JSON.stringify(previous));
	const context = { version: 1, kind: "installed-closed-history-reopen", phase: "upgrade", scope, directory, runId, targetRevision: newRevision, previousRevision: oldRevision, expectedHistorySha256: history.sha256 }, contextFile = join(scope, "profile-context-upgrade.json"); await writeFile(contextFile, JSON.stringify(context));
	const original = await readFile(proofFile), value = await readInstalledProfileContext(contextFile, source, newRevision); assert.equal(value.directory, directory); assert.equal(value.history.sha256, history.sha256);
	for (const changed of [{ scope: directory }, { targetRevision: oldRevision }, { previousRevision: newRevision }, { phase: "../outside" }, { runId: randomUUID() }, { expectedHistorySha256: "f".repeat(64) }]) { await writeFile(contextFile, JSON.stringify({ ...context, ...changed })); await assert.rejects(readInstalledProfileContext(contextFile, source, newRevision)); assert.deepEqual(await readFile(proofFile), original); }
	await writeFile(contextFile, JSON.stringify(context)); await writeFile(join(directory, installedProfileOwnerFile), JSON.stringify({ ...owner, testIdentity: randomUUID() })); await assert.rejects(readInstalledProfileContext(contextFile, source, newRevision));
	await writeFile(join(directory, installedProfileOwnerFile), JSON.stringify(owner)); const outside = join(directory, "profile-context-upgrade.json"); await writeFile(outside, JSON.stringify(context)); await assert.rejects(readInstalledProfileContext(outside, source, newRevision), /OUTSIDE_SCOPE/);
	assert.deepEqual(await readFile(proofFile), original);
});
