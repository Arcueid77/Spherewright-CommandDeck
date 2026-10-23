import assert from "node:assert/strict";
import { lstat, realpath, readFile } from "node:fs/promises";
import { dirname, basename, join, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateInstalledSmokeSource, installerIdentity } from "./installer-files.mjs";
import { readPortableHistory } from "../apps/desktop/portable-history.mjs";

const phases = new Set(["upgrade", "rollback", "return-to-new"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const installedProfileOwnerFile = "installer-profile-owner.json";

export function validateInstallerUpgradePair(baseline, candidate) {
	assert.ok(baseline.testIdentity && baseline.testIdentity === candidate.testIdentity, "UPGRADE_REQUIRES_SAME_ISOLATED_IDENTITY");
	assert.equal(baseline.appId, candidate.appId); assert.ok(uuid.test(baseline.testIdentity)); assert.equal(baseline.appId, installerIdentity(baseline.testIdentity));
	assert.notEqual(baseline.sourceRevision, candidate.sourceRevision, "UPGRADE_REQUIRES_DISTINCT_SOURCE_REVISIONS");
	assert.notEqual(baseline.sha256, candidate.sha256, "UPGRADE_REQUIRES_DISTINCT_INSTALLERS");
	for (const manifest of [baseline, candidate]) {
		assert.match(manifest.sourceRevision, /^[a-f0-9]{40}$/); assert.equal(manifest.perUser, true); assert.equal(manifest.userProfilesIncluded, false);
		assert.match(manifest.appVersion, /^\d{1,5}\.\d{1,5}\.\d{1,5}$/);
	}
}

export function assertInstallerRegistration(snapshot, installation, manifest) {
	assert.equal(snapshot.version, 1); assert.equal(snapshot.registrations?.length, 2);
	const user = snapshot.registrations.find(value => value.hive === "CurrentUser"), machine = snapshot.registrations.find(value => value.hive === "LocalMachine");
	assert.ok(user && machine); assert.equal(typeof user.present, "boolean"); assert.equal(machine.present, false);
	if (manifest === null) { assert.equal(user.present, false, "ISOLATED_INSTALLER_IDENTITY_ALREADY_REGISTERED"); return; }
	assert.equal(user.present, true); assert.equal(typeof user.InstallLocation, "string"); assert.equal(resolve(user.InstallLocation).toLowerCase(), installation.toLowerCase());
	assert.equal(user.DisplayVersion, manifest.appVersion + "+" + manifest.sourceRevision.slice(0, 12));
	assert.equal(typeof user.DisplayIcon, "string");
	const icon = user.DisplayIcon.replace(/,0$/, "").replace(/^"([^\"]+)"$/, "$1");
	assert.equal(resolve(icon).toLowerCase(), join(installation, "releases", manifest.sourceRevision, "Spherewright-CommandDeck.exe").toLowerCase());
}

async function jsonMember(file, limit) {
	const info = await lstat(file);
	assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= limit, "INSTALLED_PROFILE_CONTEXT_INVALID");
	assert.equal((await realpath(file)).toLowerCase(), file.toLowerCase());
	return JSON.parse(await readFile(file, "utf8"));
}

// Only a previously verified synthetic profile belonging to this exact test
// installation can be reused. This cannot select a normal user's profile.
export async function readInstalledProfileContext(file, source, revision) {
	const scope = await validateInstalledSmokeSource(source, revision);
	assert.ok(isAbsolute(file) && dirname(file).toLowerCase() === scope.toLowerCase(), "INSTALLED_PROFILE_CONTEXT_OUTSIDE_SCOPE");
	const context = await jsonMember(file, 4096);
	assert.equal(context.version, 1); assert.equal(context.kind, "installed-closed-history-reopen");
	assert.ok(phases.has(context.phase)); assert.equal(basename(file), "profile-context-" + context.phase + ".json");
	assert.match(context.runId, uuid); assert.equal(context.targetRevision, revision); assert.match(context.previousRevision, /^[a-f0-9]{40}$/); assert.notEqual(context.previousRevision, revision);
	assert.equal(context.scope, scope); assert.ok(isAbsolute(context.directory));
	const directory = await realpath(context.directory);
	assert.equal(directory.toLowerCase(), context.directory.toLowerCase());
	assert.equal(dirname(directory).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(directory).startsWith("commanddeck-desktop-smoke-"));
	assert.equal((await realpath(join(directory, "supervisor-profile/supervisor"))).toLowerCase(), join(directory, "supervisor-profile/supervisor").toLowerCase());
	const testIdentity = await readFile(join(scope, "installer-test-scope.txt"), "utf8"), owner = await jsonMember(join(directory, installedProfileOwnerFile), 4096);
	assert.deepEqual(owner, { version: 1, kind: "isolated-installer-profile", scope, testIdentity, runId: context.runId });
	const history = await readPortableHistory({ root: directory, runId: context.runId });
	assert.ok(history); assert.equal(history.sha256, context.expectedHistorySha256);
	const previous = await jsonMember(join(directory, "application-proof.json"), 131072);
	assert.equal(previous.runId, context.runId); assert.equal(previous.sourceRevision, context.previousRevision); assert.equal(previous.packaged, true); assert.equal(previous.closedHistoryReopened, true);
	assert.equal(previous.history?.closedHistorySha256, history.sha256); assert.equal(previous.gameCalls, 0); assert.equal(previous.realModelRequests, 0);
	return { ...context, directory, history, installation: join(scope, "install") };
}
