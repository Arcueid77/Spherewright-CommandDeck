import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ownedStorageFile, assertOwnedFileWritesDenied } from "./readonly-storage-fixture.mjs";

const leases = new WeakMap(), script = fileURLToPath(new URL("acl-storage-fixture.ps1", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
async function invoke(scope, operation, descriptors = {}) {
	await ownedStorageFile(scope);
	const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Root", scope.root, "-File", scope.file, "-Operation", operation];
	if (operation !== "inspect") args.push("-OriginalDacl", descriptors.originalDacl, "-DeniedDacl", descriptors.deniedDacl);
	const temporaryParent = await realpath(tmpdir());
	return await new Promise((resolve, reject) => {
		const child = spawn(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TEMP: temporaryParent, TMP: temporaryParent, PSModulePath: join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") } });
		let stdout = "", stderr = "", timedOut = false, oversized = false;
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
		child.stdout.on("data", bytes => { stdout += bytes; if (stdout.length > 65536) { oversized = true; child.kill(); } }); child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-4096); });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", code => {
			clearTimeout(timer);
			const failure = stderr.match(/ACL_FIXTURE_[A-Z_]+_FAILED:([a-z-]+:[A-Za-z0-9_.-]{1,180})/)?.[1];
			if (code !== 0 || timedOut || oversized) return reject(new Error("ACL_FIXTURE_" + operation.toUpperCase() + "_FAILED" + (failure ? ":" + failure : "")));
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
	const lease = Object.freeze({ fault: "windows-acl-write-deny", originalDaclSha256: hash(descriptors.originalDacl), deniedDaclSha256: hash(descriptors.deniedDacl) });
	// Keep an explicit private recovery record even if the test controller exits.
	await writeFile(join(scope.root, "acl-restore-" + randomUUID() + ".private.json"), JSON.stringify({ version: 1, root: scope.root, file: scope.file, ...descriptors }), { flag: "wx", mode: 0o600 });
	leases.set(lease, { root: scope.root, file: scope.file, descriptors });
	try { const proof = await invoke(scope, "deny", descriptors); if (!proof.denied || !proof.exactDaclReadback) throw new Error("ACL_FIXTURE_DENIAL_UNPROVEN"); }
	catch (error) { await restoreOwnedAclFileWrites({ ...scope, lease }); throw error; }
	return lease;
}

export async function restoreOwnedAclFileWrites({ root, file, lease }) {
	const saved = leases.get(lease);
	if (!saved || saved.root !== root || saved.file !== file) throw new Error("ACL_FIXTURE_RESTORE_LEASE_INVALID");
	const proof = await invoke({ root, file }, "restore", saved.descriptors);
	if (!proof.restored || !(proof.exactDaclReadback || proof.alreadyOriginal)) throw new Error("ACL_FIXTURE_RESTORATION_UNPROVEN");
	leases.delete(lease);
	return { exactOriginalDaclRestored: true, originalDaclSha256: lease.originalDaclSha256 };
}

export async function assertOwnedAclReadonlyFile(scope) {
	if (!((await ownedStorageFile(scope)) & 0o222)) throw new Error("ACL_FIXTURE_READONLY_ATTRIBUTE_CHANGED");
	return { ...await assertOwnedFileWritesDenied(scope), fault: "windows-acl-write-deny", readonlyAttributeChanged: false };
}
