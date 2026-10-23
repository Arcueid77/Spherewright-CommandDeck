import assert from "node:assert/strict";
import { readFile, lstat, realpath, writeFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { startupFailurePage } from "./startup-failure.mjs";

// Called after ready, without loading a renderer preload, provider or runtime.
export async function showStartupBlocked(app, code, { runtimeStoppedBeforeNotice = false } = {}) {
	const { BrowserWindow } = await import("electron");
	const window = new BrowserWindow({ width: 620, height: 360, resizable: false, show: false, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: false } });
	window.setMenu(null); window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	window.webContents.on("will-navigate", event => event.preventDefault());
	window.once("closed", () => app.quit());
	await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(startupFailurePage(code)));
	window.show();
	if (process.argv.includes("--portable-smoke")) {
		const root = await realpath(process.env.COMMANDDECK_PORTABLE_ROOT), runId = process.env.COMMANDDECK_PORTABLE_RUN_ID;
		assert.equal(dirname(root).toLowerCase(), (await realpath(tmpdir())).toLowerCase()); assert.ok(basename(root).startsWith("commanddeck-desktop-smoke-")); assert.match(runId, /^[a-f0-9-]{36}$/);
		const path = join(root, "startup-failure-case.json"), info = await lstat(path);
		assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size < 4096);
		const expected = JSON.parse(await readFile(path, "utf8"));
		assert.equal(expected.version, 1); assert.equal(expected.runId, runId); assert.equal(expected.code, code);
		const page = await window.webContents.executeJavaScript('({text:document.body.textContent,noNode:typeof require==="undefined"&&typeof process==="undefined",noBridge:typeof window.deck==="undefined",scripts:document.scripts.length})');
		assert.ok(window.isVisible()); assert.ok(page.text.includes("启动受阻") && page.text.includes(code)); assert.equal(page.noNode, true); assert.equal(page.noBridge, true); assert.equal(page.scripts, 0); assert.equal(app.hasSingleInstanceLock(), true);
		await writeFile(join(root, "startup-blocked-proof.json"), JSON.stringify({ runId, code, visibleBlockedWindow: true, rendererNodeDisabled: true, noPreloadBridge: true, noPageScripts: true, profileLockHeld: true, runtimeStoppedBeforeNotice, gameCalls: 0, realModelRequests: 0 }), { flag: "wx" });
		app.exit(1);
	}
	return window;
}
