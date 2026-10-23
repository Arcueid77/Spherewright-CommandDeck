import { app } from "electron";
import { readFile, writeFile, realpath, lstat, rename } from "node:fs/promises";
import { basename, dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

const input = process.env.COMMANDDECK_PROFILE_LOCK_TEST_ROOT;
if (!isAbsolute(input ?? "")) throw new Error("PROFILE_LOCK_FIXTURE_ROOT_REQUIRED");
const root = await realpath(input);
if (dirname(root).toLowerCase() !== (await realpath(tmpdir())).toLowerCase() || !basename(root).startsWith("commanddeck-desktop-smoke-")) throw new Error("PROFILE_LOCK_FIXTURE_ROOT_INVALID");
const configPath = join(root, "lock-test.json"), configInfo = await lstat(configPath);
if (!configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.size > 4096) throw new Error("PROFILE_LOCK_FIXTURE_CONFIG_INVALID");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (!/^[a-f0-9-]{36}$/.test(config.runId ?? "") || typeof config.appName !== "string" || !config.appName || config.appName.length > 200) throw new Error("PROFILE_LOCK_FIXTURE_CONFIG_INVALID");
app.setName(config.appName);
app.setPath("userData", join(root, "supervisor-profile/supervisor"));
app.on("window-all-closed", () => {});
// Windows Electron GUI executables do not provide a dependable stdin control
// stream. A marked, private file controls only this test-created process.
setInterval(async () => {
	try { const path = join(root, "holder-close.txt"), info = await lstat(path); if (info.isFile() && !info.isSymbolicLink() && info.size === 36 && await readFile(path, "utf8") === config.runId) app.exit(0); } catch {}
}, 50);
setTimeout(() => app.exit(7), 60000);
if (!app.requestSingleInstanceLock()) app.exit(9);
else app.whenReady().then(async () => {
	const pending = join(root, "holder-ready.pending"), ready = join(root, "holder-ready.json");
	await writeFile(pending, JSON.stringify({ pid: process.pid, runId: config.runId, held: app.hasSingleInstanceLock() }), { flag: "wx" });
	if ((await realpath(pending)).toLowerCase() !== pending.toLowerCase() || dirname(ready).toLowerCase() !== root.toLowerCase()) throw new Error("PROFILE_LOCK_READY_PATH_INVALID");
	try { await lstat(ready); throw new Error("PROFILE_LOCK_READY_ALREADY_EXISTS"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	await rename(pending, ready);
}).catch(() => app.exit(8));
