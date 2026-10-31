import { app, BrowserWindow, ipcMain, dialog, protocol, screen } from "electron";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { confirmResearchFromUi, startAutonomousGameFromUi } from "./research-confirmation.mjs";
import { createVideoProtocol, videoScheme, videoPlaybackUrl } from "./video-protocol.mjs";
import { recordingPermissionGate } from "./recording-permission.mjs";
import { createRendererProtocol, rendererScheme, rendererUrl } from "./renderer-protocol.mjs";
import { managePopoutWindows } from "./popout-windows.mjs";

protocol.registerSchemesAsPrivileged([{ scheme: rendererScheme, privileges: { standard: true, secure: true } }, { scheme: videoScheme, privileges: { standard: true, secure: true, stream: true, corsEnabled: true } }]);

const root = fileURLToPath(new URL("../../", import.meta.url));
const rendererDirectory = join(root, "dist/renderer");
const smoke = process.argv.includes("--smoke-ui");
const gameSmoke = smoke && process.argv.includes("--smoke-game-ui");
const diagnosticSmoke = smoke && process.argv.includes("--smoke-diagnostics-ui");
let syntheticDiagnosticAnswer = null;
const portableSmoke = smoke && process.argv.includes("--portable-smoke"), portableRendererErrors = [];
let syntheticGameAnswer = null;
let syntheticGameDialogCount = 0;
let holdSyntheticGameAnswer = false, heldSyntheticGameAnswer = null;
let window,
	heartbeat,
	sequence = 0,
	allowClose = false,
	closing = false;
let confirmingGame = false;
let diagnosticSaving = false, documentGeneration = 0;
const videoEntries = new Map(); let videoSelection = 0;
let recordingGate, recordingPermit, popouts;
const pending = new Map();
function send(message) {
	if (process.connected) process.send(message, () => {});
}
function request(action, args) {
	if (!process.connected) return Promise.reject(new Error("SUPERVISOR_DISCONNECTED"));
	const id = String(++sequence);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => {
				pending.delete(id);
				reject(new Error("SUPERVISOR_TIMEOUT"));
			},
			action === "probe" ? 105000 : ["close", "bridge-select", "bridge"].includes(action) ? 45000 : action === "workbench" ? 30000 : 12000,
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
		else if (message.name === "popout-state") result = [...popouts.windows].map(([name, child]) => ({ name, id: child.id, url: child.webContents.getURL(), visible: child.isVisible(), bounds: child.getBounds(), preferences: { sandbox: child.webContents.getLastWebPreferences().sandbox, contextIsolation: child.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: child.webContents.getLastWebPreferences().nodeIntegration, preload: Boolean(child.webContents.getLastWebPreferences().preload) } }));
		else if (["popout-evaluate", "popout-close"].includes(message.name)) {
			const child = popouts.windows.get(message.windowName);
			if (!child || child.isDestroyed()) throw new Error("UNKNOWN_OWN_POPOUT");
			if (message.name === "popout-close") { child.close(); result = true; }
			else result = await child.webContents.executeJavaScript(message.source);
		}
		else if (message.name === "portable-renderer-state" && portableSmoke) {
			const dom = await window.webContents.executeJavaScript("({body:document.body.textContent.length,brand:document.querySelector('.brand')?.textContent,groups:document.querySelectorAll('.dv-groupview').length,noNode:typeof require==='undefined',hasBridge:typeof window.deck?.snapshot==='function',readyState:document.readyState})");
			result = { ...dom, loading: window.webContents.isLoadingMainFrame(), errors: [...portableRendererErrors] };
		}
		else if (message.name === "show-ui") {
			window.restore(); window.show(); window.focus();
			result = { visible: window.isVisible(), minimized: window.isMinimized() };
		}
		else if (message.name === "minimize-ui") { window.minimize(); result = true; }
		else if (message.name === "window-state") result = { visible: window.isVisible(), minimized: window.isMinimized() };
		else if (message.name === "reload") {
			const loaded = once(window.webContents, "did-finish-load");
			window.webContents.reload();
			await loaded;
			result = true;
		} else if (message.name === "answer-diagnostic-save" && diagnosticSmoke && typeof message.cancelled === "boolean") {
			if (diagnosticSaving || syntheticDiagnosticAnswer) throw new Error("DIAGNOSTIC_BUSY");
			const directory = portableSmoke ? process.env.COMMANDDECK_PORTABLE_ROOT : process.env.COMMANDDECK_DIAGNOSTIC_FIXTURE_ROOT;
			if (!directory || !message.cancelled && message.fileName !== "diagnostic-export.json") throw new Error("INVALID_DIAGNOSTIC_FIXTURE_DESTINATION");
			syntheticDiagnosticAnswer = message.cancelled ? { canceled: true } : { canceled: false, filePath: join(directory, message.fileName) }; result = true;
		} else if (message.name === "answer-game-confirmation" && gameSmoke && [0, 1].includes(message.response)) {
			syntheticGameAnswer = message.response; result = true;
		} else if (message.name === "hold-game-confirmation" && gameSmoke) {
			if (confirmingGame || holdSyntheticGameAnswer || heldSyntheticGameAnswer || syntheticGameAnswer !== null) throw new Error("SYNTHETIC_CONFIRMATION_ALREADY_HELD");
			holdSyntheticGameAnswer = true; result = true;
		} else if (message.name === "game-confirmation-count" && gameSmoke) result = syntheticGameDialogCount;
		else if (message.name === "held-game-confirmation-state" && gameSmoke) result = Boolean(heldSyntheticGameAnswer);
		else if (message.name === "answer-held-game-confirmation" && gameSmoke && [0, 1].includes(message.response)) {
			if (!heldSyntheticGameAnswer) throw new Error("NO_HELD_SYNTHETIC_CONFIRMATION");
			const resolve = heldSyntheticGameAnswer; heldSyntheticGameAnswer = null; resolve({ response: message.response }); result = true;
		} else if (["capture-workbench", "capture-bridge", "capture-game"].includes(message.name)) {
			let captureTimer;
			try {
				const capture = await Promise.race([window.webContents.capturePage(undefined, { stayAwake: true }), new Promise((_, reject) => { captureTimer = setTimeout(() => reject(new Error("CAPTURE_TIMEOUT")), 1000); })]);
				await mkdir(join(root, ".local"), { recursive: true });
				await writeFile(join(root, message.name === "capture-game" ? ".local/m3-smoke-game.private.png" : message.name === "capture-bridge" ? ".local/m2-smoke-bridge.private.png" : ".local/m1-smoke-workbench.private.png"), capture.toPNG());
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
		else if (message.type === "event" && window && !window.isDestroyed()) {
			if (message.event?.type === "recording-changed" && ["idle", "stopping"].includes(message.event.recording?.phase)) recordingGate?.revoke();
			window.webContents.send("deck:event", message.event);
		}
		else if (message.type === "focus" && window && !window.isDestroyed()) {
			if (window.isMinimized()) window.restore();
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
				type: "supervisor-disconnected",
				text: "控制进程已断开。未重放任务，也不会启动第二个宿主。",
			});
	});
	app
		.whenReady()
		.then(async () => {
			await protocol.handle(rendererScheme, createRendererProtocol(rendererDirectory));
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
			if (portableSmoke) window.webContents.on("console-message", (details) => { if (details.level === "error") { portableRendererErrors.push(String(details.message).slice(0, 400)); if (portableRendererErrors.length > 4) portableRendererErrors.shift(); } });
			popouts = managePopoutWindows({ owner: window, BrowserWindow, screen, closing: () => closing });
			window.webContents.on("will-navigate", (event) => event.preventDefault());
			recordingGate = recordingPermissionGate({ owner: window.webContents, url: rendererUrl, generation: () => documentGeneration, authorize: (permit, generation) => request("recording", { action: "authorize", generation, args: { permit } }) });
			window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(recordingGate.permission(contents, permission)));
			window.webContents.session.setPermissionCheckHandler((contents, permission) => recordingGate.permission(contents, permission));
			window.webContents.session.setDisplayMediaRequestHandler((request, callback) => { void recordingGate.display(request, callback); });
			await window.webContents.session.protocol.handle(videoScheme, createVideoProtocol({ entries: videoEntries, generation: () => documentGeneration, read: (grant, generation, offset, length) => request("video", { action: "read", generation, args: { grant, offset, length } }) }));
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
				"deck:profiles-manage": "profiles-manage",
				"deck:bridge": "bridge",
				"deck:targets": "targets",
				"deck:attach": "attach",
				"deck:start-fixture": "start-fixture",
				"deck:viewport": "viewport",
				"deck:probe": "probe",
				"deck:abort": "abort",
				"deck:snapshot": "snapshot",
				"deck:journal": "journal",
				"deck:resume-system": "resume-system",
			}))
				handle(channel, (args) => request(action, args));
			handle("deck:model-usage", () => request("model-usage"));
			handle("deck:gateway", args => {
				if (!args || !["snapshot", "start", "stop", "copy"].includes(args.action) || Object.keys(args).length !== 1) throw new Error("INVALID_GATEWAY_ACTION");
				return request("gateway", { action: args.action, generation: documentGeneration });
			});
			handle("deck:video", async args => {
				if (!args || !["snapshot", "context", "open", "bookmark", "close"].includes(args.action)) throw new Error("INVALID_VIDEO_ACTION");
				if (args.action === "snapshot") return request("video", { action: "snapshot" });
				if (args.action === "context") return request("video", { action: "context", generation: documentGeneration, args: { id: args.args?.id, offset: args.args?.offset } });
				if (args.action === "bookmark") {
					const entry = videoEntries.get(args.args?.grant); if (!entry || entry.generation !== documentGeneration || closing) throw new Error("VIDEO_PLAYBACK_CHANGED");
					return request("video", { action: "bookmark", generation: entry.generation, args: { grant: args.args.grant, timeMs: args.args?.timeMs, tag: args.args?.tag, eventSequence: args.args?.eventSequence } });
				}
				if (args.action === "close") {
					const entry = videoEntries.get(args.args?.grant); videoEntries.delete(args.args?.grant);
					return entry ? request("video", { action: "close", generation: entry.generation, args: { grant: args.args.grant } }) : { closed: true };
				}
				const generation = documentGeneration, selection = ++videoSelection; videoEntries.clear();
				const opened = await request("video", { action: "open", generation, args: { id: args.args?.id } });
				if (generation !== documentGeneration || selection !== videoSelection || closing) { await request("video", { action: "close", generation, args: { grant: opened.grant } }); throw new Error("VIDEO_UI_CHANGED"); }
				videoEntries.set(opened.grant, { ...opened, generation }); return { ...opened, url: videoPlaybackUrl(opened.grant) };
			});
			handle("deck:recording", async args => {
				if (!args || !["snapshot", "prepare", "ready", "set-masks", "start", "append", "finish", "cancel", "closed"].includes(args.action)) throw new Error("INVALID_RECORDING_ACTION");
				const generation = documentGeneration, value = { ...args.args };
				if (args.action === "prepare") {
					const prepared = await request("recording", { action: "prepare", generation, args: value });
					if (generation !== documentGeneration || closing) { await request("recording", { action: "cancel", generation, args: { permit: prepared.permit } }); throw new Error("VIDEO_UI_CHANGED"); }
					recordingPermit = { permit: prepared.permit, generation }; recordingGate.arm(prepared.permit); return prepared;
				}
				if (["cancel", "closed", "finish"].includes(args.action) && value.permit === recordingPermit?.permit) recordingGate.revoke();
				if (args.action === "closed" && value.permit === recordingPermit?.permit) recordingPermit = null;
				if (args.action === "append") { if (!(value.bytes instanceof Uint8Array) || value.bytes.length < 1 || value.bytes.length > 2097152) throw new Error("VIDEO_CHUNK_INVALID"); value.data = Buffer.from(value.bytes).toString("base64"); delete value.bytes; }
				return request("recording", { action: args.action, generation, args: value });
			});
			const confirmGame = taskId => confirmResearchFromUi({ taskId, request, showDialog: (options) => { if (gameSmoke) syntheticGameDialogCount++; if (gameSmoke && holdSyntheticGameAnswer) { holdSyntheticGameAnswer = false; return new Promise(resolve => { heldSyntheticGameAnswer = resolve; }); } if (gameSmoke && syntheticGameAnswer !== null) { const response = syntheticGameAnswer; syntheticGameAnswer = null; return Promise.resolve({ response }); } return dialog.showMessageBox(window, options); }, hideViewport: () => request("viewport", { x: 0, y: 0, width: 1, height: 1, visible: false }), overlay: (busy) => { if (!window.isDestroyed()) window.webContents.send("deck:event", { type: "game-confirmation-state", busy }); } });
			handle("deck:game", async (args) => {
				if (!args || !["snapshot", "start", "stop", "reconcile", "reprepare", "catalog"].includes(args.action)) throw new Error("INVALID_GAME_ACTION");
				if (args.action === "start" && args.args?.kind === "mcp" && args.args.mode === "autonomous") {
					if (confirmingGame || diagnosticSaving) throw new Error("GAME_CONFIRMATION_ALREADY_OPEN");
					confirmingGame = true;
					try { return await startAutonomousGameFromUi({ args, request, confirm: confirmGame }); }
					finally { confirmingGame = false; }
				}
				return request("game", args);
			});
			handle("deck:confirm-research", async (args) => {
				if (confirmingGame || diagnosticSaving) throw new Error("GAME_CONFIRMATION_ALREADY_OPEN");
				confirmingGame = true;
				try {
					return await confirmGame(args?.taskId);
				} finally { confirmingGame = false; }
			});
			handle("deck:diagnostic-preview", options => request("diagnostics-preview", { options, generation: documentGeneration }));
			handle("deck:diagnostic-discard", id => request("diagnostics-discard", { id, generation: documentGeneration }));
			handle("deck:diagnostic-save", async id => {
				if (diagnosticSaving || confirmingGame) throw new Error("DIAGNOSTIC_BUSY");
				diagnosticSaving = true;
				const generation = documentGeneration; let grant;
				try {
					grant = await request("diagnostics-begin-save", { id, generation });
					if (generation !== documentGeneration) throw new Error("DIAGNOSTIC_UI_CHANGED");
					let selected;
					if (diagnosticSmoke && syntheticDiagnosticAnswer) { selected = syntheticDiagnosticAnswer; syntheticDiagnosticAnswer = null; }
					else selected = await dialog.showSaveDialog(window, { title: "保存诊断报告", defaultPath: grant.fileName, filters: [{ name: "JSON 诊断报告", extensions: ["json"] }], properties: ["showOverwriteConfirmation", "dontAddToRecent"] });
					if (generation !== documentGeneration) throw new Error("DIAGNOSTIC_UI_CHANGED");
					if (selected.canceled || !selected.filePath) { await request("diagnostics-cancel-save", { grant: grant.grant, generation }); return { cancelled: true }; }
					return await request("diagnostics-write", { grant: grant.grant, generation, path: selected.filePath });
				} finally {
					if (grant) await request("diagnostics-cancel-save", { grant: grant.grant, generation }).catch(() => {});
					diagnosticSaving = false;
				}
			});
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
			handle("deck:choose-bridge", async () => {
				const selected = await dialog.showOpenDialog(window, { title: "选择 Spherewright.Mcp.exe（会启动本机只读观察服务）", properties: ["openFile"], filters: [{ name: "Spherewright MCP", extensions: ["exe"] }] });
				if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
				return request("bridge-select", selected.filePaths[0]);
			});
			handle("deck:detach", async () => {
				const result = await request("detach");
				window.show();
				window.focus();
				return result;
			});
			window.webContents.on("did-start-loading", () => { recordingGate.revoke(); recordingPermit = null; videoSelection++; videoEntries.clear(); send({ type: "ui-document", generation: ++documentGeneration }); });
			window.webContents.on("did-finish-load", () =>
				send({ type: "ui-loaded" }),
			);
			window.webContents.on("render-process-gone", () => {
				if (!closing && !window.isDestroyed())
					void window.loadURL(rendererUrl).catch(() => {});
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
			await window.loadURL(rendererUrl);
		})
		.catch(() => {
			console.error("MANAGED_UI_STARTUP_FAILED");
			app.exit(1);
		});
}
