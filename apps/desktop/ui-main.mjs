import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rendererFile = join(root, "dist/renderer/index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
const smoke = process.argv.includes("--smoke-ui");
let window,
	heartbeat,
	sequence = 0,
	allowClose = false,
	closing = false;
const pending = new Map();
function send(message) {
	if (process.connected) process.send(message, () => {});
}
function request(action, args) {
	const id = String(++sequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => {
				pending.delete(id);
				reject(new Error("SUPERVISOR_TIMEOUT"));
			},
			action === "probe" ? 105000 : action === "close" ? 45000 : action === "workbench" ? 30000 : 12000,
		);
		pending.set(id, { resolve, reject, timer });
		send({ type: "request", id, action, args });
	});
}
function finish(id, ok, value) {
	const operation = pending.get(id);
	if (!operation) return;
	pending.delete(id);
	clearTimeout(operation.timer);
	ok ? operation.resolve(value) : operation.reject(new Error(value));
}
async function testCommand(message) {
	if (!smoke) return;
	try {
		let result;
		if (message.name === "evaluate")
			result = await window.webContents.executeJavaScript(message.source);
		else if (message.name === "reload") {
			const loaded = once(window.webContents, "did-finish-load");
			window.webContents.reload();
			await loaded;
			result = true;
		} else if (message.name === "capture-workbench") {
			let captureTimer;
			try {
				const capture = await Promise.race([window.webContents.capturePage(undefined, { stayAwake: true }), new Promise((_, reject) => { captureTimer = setTimeout(() => reject(new Error("CAPTURE_TIMEOUT")), 1000); })]);
				await mkdir(join(root, ".local"), { recursive: true });
				await writeFile(join(root, ".local/m1-smoke-workbench.private.png"), capture.toPNG());
				result = { captured: true };
			} catch { result = { captured: false, code: "CAPTURE_UNAVAILABLE" }; }
			finally { clearTimeout(captureTimer); }
		} else if (message.name === "renderer-crash") {
			const loaded = once(window.webContents, "did-finish-load");
			window.webContents.forcefullyCrashRenderer();
			await loaded;
			result = true;
		} else if (message.name === "focus") {
			await request("focus-ui");
			window.webContents.focus();
			result = {
				windowFocused: window.isFocused(),
				contentsFocused: window.webContents.isFocused(),
			};
		} else if (message.name === "hang-own-ui") {
			send({ type: "test-event", name: "ui-hang-start", durationMs: 5000 });
			// Only the disposable, supervisor-created Electron UI is frozen by this test.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
			send({ type: "test-event", name: "ui-hang-ended" });
			result = true;
		} else throw new Error("UNKNOWN_UI_TEST");
		send({ type: "test-result", id: message.id, ok: true, result });
	} catch (error) {
		if (smoke) console.error("UI_TEST_DETAIL", message.name, error.message);
		send({
			type: "test-result",
			id: message.id,
			ok: false,
			code: "UI_TEST_FAILED",
		});
	}
}
if (typeof process.send !== "function") {
	console.error("Managed UI requires its creation IPC channel.");
	app.exit(1);
} else {
	process.on("message", (message) => {
		if (message.type === "response")
			finish(
				message.id,
				message.ok,
				message.ok ? message.result : message.code,
			);
		else if (message.type === "registered") finish("registration", true, true);
		else if (message.type === "event" && window && !window.isDestroyed())
			window.webContents.send("deck:event", message.event);
		else if (message.type === "focus" && window && !window.isDestroyed()) {
			window.show();
			window.focus();
		} else if (message.type === "allow-close") {
			allowClose = true;
			clearInterval(heartbeat);
			window?.close();
			app.quit();
		} else if (message.type === "test") void testCommand(message);
	});
	process.on("disconnect", () => {
		clearInterval(heartbeat);
		for (const operation of pending.values()) {
			clearTimeout(operation.timer);
			operation.reject(new Error("SUPERVISOR_DISCONNECTED"));
		}
		pending.clear();
		if (window && !window.isDestroyed())
			window.webContents.send("deck:event", {
				type: "notice",
				text: "控制进程已断开。未重放任务，也不会启动第二个宿主。",
			});
	});
	app
		.whenReady()
		.then(async () => {
			window = new BrowserWindow({
				width: 1440,
				height: 940,
				minWidth: 1000,
				minHeight: 680,
				backgroundColor: "#0b1119",
				title: "Spherewright CommandDeck · M0",
				webPreferences: {
					preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
					contextIsolation: true,
					sandbox: true,
					nodeIntegration: false,
				},
			});
			window.removeMenu();
			window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			window.webContents.on("will-navigate", (event) => event.preventDefault());
			window.webContents.session.setPermissionRequestHandler(
				(_contents, _permission, callback) => callback(false),
			);
			window.webContents.session.setPermissionCheckHandler(() => false);
			const handle = (channel, action) =>
				ipcMain.handle(channel, async (event, args) => {
					if (
						event.sender !== window.webContents ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.url !== rendererUrl
					)
						throw new Error("UNTRUSTED_IPC_SENDER");
					if (closing && channel === "deck:viewport") return { deferred: true };
					if (closing) throw new Error("DESKTOP_CLOSING");
					return action(args);
				});
			for (const [channel, action] of Object.entries({
				"deck:status": "status",
				"deck:profiles": "profiles",
				"deck:targets": "targets",
				"deck:attach": "attach",
				"deck:start-fixture": "start-fixture",
				"deck:viewport": "viewport",
				"deck:probe": "probe",
				"deck:abort": "abort",
				"deck:snapshot": "snapshot",
			}))
				handle(channel, (args) => request(action, args));
			handle("deck:focus-ui", async () => {
				// Preserve Chromium's active editor/drag operation when this UI already owns focus.
				if (window.webContents.isFocused()) return { alreadyFocused: true };
				const result = await request("focus-ui");
				window.webContents.focus();
				return result;
			});
			handle("deck:workbench", (args) => {
				if (!args || args.action === "add") throw new Error("USE_WORKSPACE_PICKER");
				return request("workbench", args);
			});
			handle("deck:add-workspace", async () => {
				const selected = await dialog.showOpenDialog(window, { title: "添加开发仓库", properties: ["openDirectory"] });
				if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
				const path = selected.filePaths[0], label = path.replaceAll("\\", "/").split("/").at(-1);
				return request("workbench", { action: "add", args: { path, label, canWrite: false, canExecute: false } });
			});
			handle("deck:detach", async () => {
				const result = await request("detach");
				window.show();
				window.focus();
				return result;
			});
			window.webContents.on("did-finish-load", () =>
				send({ type: "ui-loaded" }),
			);
			window.webContents.on("render-process-gone", () => {
				if (!closing && !window.isDestroyed())
					void window.loadFile(rendererFile).catch(() => {});
			});
			window.on("close", (event) => {
				if (allowClose) return;
				event.preventDefault();
				if (closing) return;
				closing = true;
				void request("close").catch(async () => {
					closing = false;
					if (!window.isDestroyed())
						await dialog.showMessageBox(window, {
							type: "warning",
							message: "任务收尾或窗口还原尚未确认，工作台保持打开。",
						});
				});
			});
			window.on("closed", () => {
				clearInterval(heartbeat);
				app.quit();
			});
			let beat = 0;
			heartbeat = setInterval(
				() => send({ type: "ui-heartbeat", sequence: ++beat }),
				100,
			);
			const registered = new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete("registration");
					reject(new Error("UI_REGISTRATION_TIMEOUT"));
				}, 10000);
				pending.set("registration", { resolve, reject, timer });
			});
			send({
				type: "ui-ready",
				pid: process.pid,
				hwnd: window.getNativeWindowHandle().readBigUInt64LE().toString(),
			});
			await registered;
			await window.loadFile(rendererFile);
		})
		.catch(() => {
			console.error("MANAGED_UI_STARTUP_FAILED");
			app.exit(1);
		});
}
