import { app, BrowserWindow, ipcMain, utilityProcess, dialog } from "electron";
import { once } from "node:events";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { OwnedFixtureHost } from "./owned-fixture.mjs";
import { publicProfiles } from "./profiles.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const rendererFile = join(root, "dist/renderer/index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
let window,
	native,
	runtime,
	allowClose = false,
	closing = false;
let probeSequence = 0;
const pending = new Map();
const emit = (event) => {
	if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
		window.webContents.send("deck:event", event);
};
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", () => {
		window?.restore();
		window?.focus();
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
			native = new OwnedFixtureHost(window);
			await native.ready;
			native.on("stopped", () =>
				emit({
					type: "native-state",
					text: "游戏侧宿主替身已结束。Deck 与 DSP 尚未对接。",
				}),
			);
			const environment = Object.fromEntries(
				Object.entries(process.env).filter(
					([key]) =>
						!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(key),
				),
			);
			environment.PI_OFFLINE = "1";
			runtime = utilityProcess.fork(
				fileURLToPath(new URL("./runtime.mjs", import.meta.url)),
				[],
				{
					env: environment,
					cwd: root,
					stdio: "pipe",
					serviceName: "CommandDeck Pi runtime",
				},
			);
			runtime.stdout.on("data", () => {});
			runtime.stderr.on("data", () => {});
			runtime.on("message", (message) => {
				if (message.type === "event") emit(message.event);
				const operation = pending.get(message.id);
				if (operation) {
					pending.delete(message.id);
					clearTimeout(operation.timer);
					message.type === "result"
						? operation.resolve(message.result)
						: operation.reject(new Error(message.code));
				}
			});
			runtime.on("exit", () => {
				for (const operation of pending.values()) {
					clearTimeout(operation.timer);
					operation.reject(new Error("RUNTIME_STOPPED"));
				}
				pending.clear();
				emit({
					type: "notice",
					text: "Pi runtime 已停止。没有游戏动作接口被启用。",
				});
			});
			const handle = (channel, action) =>
				ipcMain.handle(channel, async (event, args) => {
					if (
						event.sender !== window.webContents ||
						event.senderFrame !== window.webContents.mainFrame ||
						event.senderFrame.url !== rendererUrl
					)
						throw new Error("UNTRUSTED_IPC_SENDER");
					if (closing) throw new Error("DESKTOP_CLOSING");
					return action(args);
				});
			handle("deck:status", () => native.request("status"));
			handle("deck:profiles", () => {
				try {
					return publicProfiles();
				} catch {
					return [];
				}
			});
			handle("deck:targets", () => native.request("list"));
			handle("deck:attach", (id) => {
				if (typeof id !== "string" || id.length > 200)
					throw new Error("INVALID_TARGET");
				return native.request("attach", { targetId: id });
			});
			handle("deck:detach", async () => {
				const state = await native.request("detach");
				window.show();
				window.focus();
				return state;
			});
			handle("deck:start-fixture", () => native.request("start-fixture"));
			handle("deck:viewport", (rect) => {
				if (closing) return { visible: false };
				if (
					!rect ||
					!["x", "y", "width", "height"].every(
						(key) =>
							typeof rect[key] === "number" && Number.isFinite(rect[key]),
					) ||
					typeof rect.visible !== "boolean"
				)
					throw new Error("INVALID_VIEWPORT");
				return native.request("rect", rect);
			});
			handle("deck:abort", () => {
				runtime.postMessage({ type: "abort" });
				return { requested: true };
			});
			handle("deck:probe", async (config) => {
				if (
					!config ||
					!["offline", "live"].includes(config.mode) ||
					pending.size > 0
				)
					throw new Error("INVALID_OR_BUSY_PROBE");
				if (
					config.mode === "live" &&
					!publicProfiles().some(
						(p) =>
							p.providerId === config.providerId &&
							p.modelId === config.modelId,
					)
				)
					throw new Error("MODEL_NOT_CONFIGURED");
				const id = String(++probeSequence);
				const storageRoot = join(
					app.getPath("userData"),
					"m0-probes",
					id + "-" + Date.now(),
				);
				await mkdir(storageRoot, { recursive: true });
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						pending.delete(id);
						runtime.postMessage({ type: "abort" });
						reject(new Error("PROBE_TIMEOUT"));
					}, 100000);
					pending.set(id, { resolve, reject, timer });
					runtime.postMessage({
						type: "probe",
						id,
						command: {
							mode: config.mode,
							providerId: config.providerId,
							modelId: config.modelId,
							storageRoot,
						},
					});
				});
			});
			window.on("close", (event) => {
				if (allowClose) return;
				event.preventDefault();
				if (closing) return;
				closing = true;
				void (async () => {
					try {
						runtime.postMessage({ type: "abort" });
						await native.request("detach");
						await native.request("close");
						allowClose = true;
						window.close();
						app.quit();
					} catch {
						closing = false;
						await dialog.showMessageBox(window, {
							type: "warning",
							message: "未能证明替身宿主已正常脱离，工作台保持打开。",
						});
					}
				})();
			});
			await window.loadFile(rendererFile);
			if (process.argv.includes("--demo-fixture")) {
				await window.webContents.executeJavaScript(
					"window.deck.startFixture().then(() => window.deck.attach('owned-fixture'))",
				);
				emit({
					type: "native-state",
					text: "游戏侧宿主替身已启动；可在中央点击、拖动、滚轮和按键。不是 DSP。",
				});
			}
			if (process.argv.includes("--smoke")) {
				try {
					const option = (name) => {
						const index = process.argv.indexOf(name);
						return index < 0 ? undefined : process.argv[index + 1];
					};
					const probe = process.argv.includes("--smoke-live")
						? {
								mode: "live",
								providerId: option("--provider"),
								modelId: option("--model"),
							}
						: { mode: "offline" };
					const result = await window.webContents.executeJavaScript(
						`(async () => { await window.deck.startFixture(); await window.deck.attach('owned-fixture'); const config = ${JSON.stringify(probe)}; if (config.mode === 'live') localStorage.setItem('deck-profile', JSON.stringify({providerId:config.providerId,modelId:config.modelId})); return { title: document.title, panels: document.querySelectorAll('.dv-groupview').length, nodeExposed: typeof require !== 'undefined', native: await window.deck.status(), probe: await window.deck.probe(config) }; })()`,
					);
					assert.equal(result.panels, 4);
					assert.equal(result.nodeExposed, false);
					assert.equal(result.native.attached, true);
					assert.equal(result.native.hostVisible, true);
					assert.equal(result.native.uiVisible, true);
					assert.equal(result.native.uiChildStyle, true);
					assert.equal(result.native.nativeParentMatches, true);
					assert.equal(result.native.gameParentMatches, true);
					assert.equal(result.native.gameOwnerPid, result.native.hostOwnerPid);
					assert.equal(result.probe.executed, 1);
					assert.equal(result.probe.requestCount, 2);
					assert.equal(result.probe.finalStopReason, "stop");
					assert.deepEqual(result.probe.active, ["deck_echo"]);
					assert.deepEqual(result.probe.callable, ["deck_echo"]);
					const reloaded = once(window.webContents, "did-finish-load");
					window.webContents.reload();
					await reloaded;
					result.afterReload = await window.webContents.executeJavaScript(
						"window.deck.status()",
					);
					if (
						probeSequence !== 1 ||
						result.afterReload.hostOwnerPid !== result.native.hostOwnerPid
					)
						throw new Error("RELOAD_REPLAY_OR_HOST_CHANGED");
					const rendererGone = once(window.webContents, "render-process-gone");
					window.webContents.forcefullyCrashRenderer();
					await rendererGone;
					result.afterRendererCrash = await native.request("status");
					if (
						!result.afterRendererCrash.gameAlive ||
						result.afterRendererCrash.hostOwnerPid !==
							result.native.hostOwnerPid ||
						probeSequence !== 1
					)
						throw new Error("RENDERER_CRASH_HOST_OR_TASK_CHANGED");
					result.sameHostAfterReload = true;
					result.sameHostAfterRendererCrash = true;
					result.noProbeReplay = probeSequence === 1;
					// Keep CI artifacts portable; raw HWNDs, PIDs and session paths stay private.
					for (const name of ["native", "afterReload", "afterRendererCrash"]) {
						const { targetPid, gameOwnerPid, hostOwnerPid, ...portable } =
							result[name];
						result[name] = portable;
					}
					await window.loadFile(rendererFile);
					await mkdir(join(root, ".local"), { recursive: true });
					await writeFile(
						join(
							root,
							probe.mode === "live"
								? ".local/desktop-smoke-live.json"
								: ".local/desktop-smoke.json",
						),
						JSON.stringify(result, null, 2),
					);
					window.close();
				} catch {
					app.exit(1);
				}
			}
		})
		.catch((error) => {
			console.error("DESKTOP_STARTUP_FAILED", error.message);
			app.exit(1);
		});
}
