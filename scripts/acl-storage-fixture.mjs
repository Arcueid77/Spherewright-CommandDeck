import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ownedStorageFile, assertOwnedFileWritesDenied } from "./readonly-storage-fixture.mjs";

const leases = new WeakMap(), script = fileURLToPath(new URL("acl-storage-fixture.ps1", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
// Cold Windows PowerShell/ACL initialization may exceed 15 seconds under the
// full CI suite. This remains bounded and does not weaken any DACL readback.
export const aclFixtureTimeoutMs = 45000;
export function aclFixtureFailure(operation, { timedOut, oversized, exitCode }) {
	const reason = timedOut ? "timeout" : oversized ? "output-limit" : "exit-" + (Number.isInteger(exitCode) ? exitCode : "unknown");
	return "ACL_FIXTURE_" + operation.toUpperCase() + "_FAILED:" + reason;
}
async function invoke(scope, operation, descriptors = {}) {
	await ownedStorageFile(scope);
	const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", scope.root, "-File", scope.file, "-Operation", operation];
	if (["deny", "restore"].includes(operation)) args.push("-OriginalDacl", descriptors.originalDacl, "-DeniedDacl", descriptors.deniedDacl, "-ExpectedOwnerGroup", descriptors.ownerGroup);
	const temporaryParent = await realpath(tmpdir());
	return await new Promise((resolve, reject) => {
		const child = spawn(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMP: temporaryParent, TMP: temporaryParent, PSModulePath: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") } });
		let stdout = "", stderr = "", timedOut = false, oversized = false;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, aclFixtureTimeoutMs);
		child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65536) { oversized = true; child.kill(); } }); child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4096); });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", code => {
			clearTimeout(timer);
			const failure = stderr.match(/ACL_FIXTURE_[A-Z_-]+_FAILED:([a-z-]+:[A-Za-z0-9_.-]{1,180})/)?.[1], diff = stderr.match(/ACL_FIXTURE_DESCRIPTOR_DIFF:(\{[^\r\n]{1,2048}\})/)?.[1];
			if (code !== 0 || timedOut || oversized) return reject(new Error(aclFixtureFailure(operation, { timedOut, oversized, exitCode: code }) + (failure ? ":" + failure : "") + (diff ? ":" + diff : "")));
			try { const proof = JSON.parse(stdout); if (proof.version !== 1) throw new Error("ACL_FIXTURE_REPLY_INVALID"); resolve(proof); } catch (error) { reject(error); }
		});
	});
}

export async function denyOwnedAclFileWrites(scope) {
	const mode = await ownedStorageFile(scope);
	if (!(mode & 0o222)) throw new Error("ACL_FIXTURE_ORIGINAL_ATTRIBUTE_NOT_WRITABLE");
	const handle = await open(scope.file, "r+"); await handle.close();
	const descriptors = await invoke(scope, "inspect");
	if (![descriptors.originalDacl, descriptors.deniedDacl].every(value => typeof value === "string" && value.startsWith("D:") && value.length <= 16384) || descriptors.originalDacl === descriptors.deniedDacl) throw new Error("ACL_FIXTURE_DESCRIPTORS_INVALID");
	for (const value of [descriptors.originalAcl, descriptors.deniedAcl]) {
		if (typeof value !== "string" || !value.length || value.length > 65536 || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("ACL_FIXTURE_ACL_BYTES_INVALID");
	}
	const lease = Object.freeze({ fault: "windows-acl-write-deny", originalDaclSha256: hash(Buffer.from(descriptors.originalAcl, "base64")), deniedDaclSha256: hash(Buffer.from(descriptors.deniedAcl, "base64")) });
	// Keep an explicit private recovery record even if the test controller exits.
	await writeFile(join(scope.root, "acl-restore-" + randomUUID() + ".private.json"), JSON.stringify({ version: 1, root: scope.root, file: scope.file, ...descriptors }), { flag: "wx", mode: 0o600 });
	leases.set(lease, { root: scope.root, file: scope.file, descriptors });
	try { const proof = await invoke(scope, "deny", descriptors); if (!proof.denied || !proof.exactDaclReadback || !proof.daclOnly || proof.ownerGroup !== descriptors.ownerGroup) throw new Error("ACL_FIXTURE_DENIAL_UNPROVEN"); }
	catch (error) {
		try { await restoreOwnedAclFileWrites({ ...scope, lease }); }
		catch (restorationError) { throw new AggregateError([error, restorationError], "ACL_FIXTURE_DENIAL_AND_RESTORATION_FAILED:" + error.message + ":" + restorationError.message); }
		throw error;
	}
	return lease;
}

export async function restoreOwnedAclFileWrites({ root, file, lease }) {
	const saved = leases.get(lease);
	if (!saved || saved.root !== root || saved.file !== file) throw new Error("ACL_FIXTURE_RESTORE_LEASE_INVALID");
	const proof = await invoke({ root, file }, "restore", saved.descriptors);
	if (!proof.restored || !(proof.exactDaclReadback || proof.alreadyOriginal) || proof.ownerGroup !== saved.descriptors.ownerGroup || (!proof.alreadyOriginal && !proof.daclOnly)) throw new Error("ACL_FIXTURE_RESTORATION_UNPROVEN");
	leases.delete(lease);
	return { exactOriginalDaclRestored: true, ownerGroupPreserved: true, originalDaclSha256: lease.originalDaclSha256, autoInheritedMetadataChanged: proof.autoInheritedMetadataChanged === true };
}

export async function protectOwnedAclFixture(scope) {
	const proof = await invoke(scope, "protect-fixture");
	if (!proof.protectedFixture || !proof.exactDaclReadback || !proof.daclOnly) throw new Error("ACL_FIXTURE_PROTECTION_UNPROVEN");
	return { protectedFixture: true };
}

export async function resetOwnedAclAutoFixture(scope) {
	const proof = await invoke(scope, "reset-auto-fixture");
	if (!proof.nonAutoFixture || !proof.exactDaclReadback || !proof.daclOnly) throw new Error("ACL_FIXTURE_AUTO_PRECONDITION_UNPROVEN");
	return { nonAutoFixture: true };
}

export async function changeOwnedAclRuleFixture(scope) {
	const proof = await invoke(scope, "unexpected-rule-fixture");
	if (!proof.unexpectedRuleFixture || !proof.exactDaclReadback || !proof.daclOnly) throw new Error("ACL_FIXTURE_CHANGED_RULE_UNPROVEN");
}

export async function clearOwnedAclRuleFixture(scope) {
	const proof = await invoke(scope, "clear-rule-fixture");
	if (!proof.clearedRuleFixture || !proof.exactDaclReadback || !proof.daclOnly) throw new Error("ACL_FIXTURE_RULE_CLEANUP_UNPROVEN");
}

export async function assertOwnedAclReadonlyFile(scope) {
	if (!((await ownedStorageFile(scope)) & 0o222)) throw new Error("ACL_FIXTURE_READONLY_ATTRIBUTE_CHANGED");
	return { ...await assertOwnedFileWritesDenied(scope), fault: "windows-acl-write-deny", readonlyAttributeChanged: false };
}
