import { realpath, lstat, chmod, open } from "node:fs/promises";
import { dirname, basename, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

async function owned({ root, file }) {
	if (process.platform !== "win32" || typeof root !== "string" || typeof file !== "string" || !isAbsolute(root) || !isAbsolute(file)) throw new Error("WINDOWS_READONLY_FIXTURE_REQUIRED");
	const canonical = await realpath(root), name = relative(root, file).replaceAll("\\", "/"), info = await lstat(file);
	if (canonical.toLowerCase() !== root.toLowerCase() || dirname(canonical).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-desktop-smoke-") || !/^supervisor-profile\/supervisor\/(?:game-smoke-[a-f0-9-]{36}\/game-tasks|m1-smoke-[a-f0-9-]{36}\/workbench)\.sqlite$/.test(name) || (await realpath(file)).toLowerCase() !== file.toLowerCase() || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8388608) throw new Error("READONLY_FIXTURE_SCOPE_INVALID");
	return info.mode & 0o777;
}

export async function denyOwnedFileWrites(scope) {
	const mode = await owned(scope);
	if (!(mode & 0o222)) throw new Error("READONLY_FIXTURE_ORIGINAL_NOT_WRITABLE");
	await chmod(scope.file, mode & ~0o222); return mode;
}

export async function restoreOwnedFileWrites(scope) {
	await owned(scope);
	if (!Number.isInteger(scope.mode) || scope.mode < 0 || scope.mode > 0o777 || !(scope.mode & 0o222)) throw new Error("READONLY_FIXTURE_RESTORE_MODE_INVALID");
	await chmod(scope.file, scope.mode);
}

export async function assertOwnedReadonlyFile(scope) {
	await owned(scope); let accessCode, sqliteCode, database;
	try { const handle = await open(scope.file, "r+"); await handle.close(); } catch (error) { if (!["EACCES", "EPERM"].includes(error.code)) throw error; accessCode = error.code; }
	if (!accessCode) throw new Error("READONLY_FIXTURE_OS_WRITE_NOT_DENIED");
	try { database = new DatabaseSync(scope.file); const version = database.prepare("PRAGMA user_version").get().user_version; database.exec("PRAGMA user_version=" + version); }
	catch (error) { if (error.code !== "ERR_SQLITE_ERROR" || !Number.isInteger(error.errcode) || (error.errcode & 255) !== 8) throw error; sqliteCode = error.errcode; }
	finally { database?.close(); }
	if (!sqliteCode) throw new Error("READONLY_FIXTURE_SQLITE_WRITE_NOT_DENIED");
	return { actualOsWriteDenied: true, accessCode, sqliteReadOnlyObserved: true, sqliteCode, fault: "windows-readonly-file-attribute" };
}
