import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { rendererAsset, createRendererProtocol, rendererUrl, popoutUrl } from "../apps/desktop/renderer-protocol.mjs";
import { popoutGeometry, visiblePopoutBounds, managePopoutWindows } from "../apps/desktop/popout-windows.mjs";
import { portablePopoutCase, assertPortablePopoutAction } from "../apps/desktop/popout-case.mjs";

test("renderer origin only serves built UI assets and refuses arbitrary filesystem/protocol requests", async () => {
	const base = await realpath(await mkdtemp(join(tmpdir(), "deck-renderer-protocol-")));
	try {
		await mkdir(join(base, "assets")); await writeFile(join(base, "index.html"), "<h1>fixture</h1>"); await writeFile(join(base, "assets/main-123.js"), "const fixture = true;");
		const serve = createRendererProtocol(base);
		const response = await serve({ url: rendererUrl, method: "GET" }); assert.equal(response.status, 200); assert.equal(await response.text(), "<h1>fixture</h1>");
		const script = await serve({ url: "deck-ui://app/assets/main-123.js", method: "GET" }); assert.match(script.headers.get("content-type"), /javascript/);
		for (const url of ["file:///index.html", "deck-ui://other/index.html", "deck-ui://app/index.html?path=private", "deck-ui://app/assets/%2e%2e/index.html", "deck-ui://app/../private.txt", "deck-ui://app/assets/main.js.map", "deck-ui://app:10/index.html", "deck-ui://user@app/index.html", "deck-ui://app/assets/sub/index.js"]) { assert.equal(rendererAsset(url), null, url); assert.equal((await serve({ url, method: "GET" })).status, 404); }
		assert.equal((await serve({ url: rendererUrl, method: "POST" })).status, 404);
		assert.equal((await serve({ url: popoutUrl, method: "GET" })).status, 404);
		assert.equal(await (await serve({ url: rendererUrl, method: "HEAD" })).text(), "");
	} finally { assert.equal(dirname(base), await realpath(tmpdir())); assert.ok(basename(base).startsWith("deck-renderer-protocol-")); await rm(base, { recursive: true, force: true }); }
});

test("popout placement is bounded across negative-origin displays and screen removal", () => {
	const main = { x: 0, y: 0, width: 1920, height: 1040 }, left = { x: -1280, y: 0, width: 1280, height: 720 };
	assert.deepEqual(popoutGeometry("top=25,left=-1100,width=800,height=500", [main, left]), { x: -1100, y: 25, width: 800, height: 500 });
	assert.deepEqual(visiblePopoutBounds({ x: -1100, y: 25, width: 800, height: 500 }, [main]), { x: 0, y: 25, width: 800, height: 500 });
	assert.deepEqual(popoutGeometry("top=900,left=1800,width=8000,height=6000", [main]), { x: 0, y: 0, width: 1920, height: 1040 });
	for (const value of ["top=0,left=0,width=0,height=10", "top=0,left=0,width=400,height=300,nodeIntegration=yes", "top=0,left=0,width=400,height=NaN", "top=0,left=0,width=400,height=300,left=10", "top=0,left=0"]) assert.equal(popoutGeometry(value, [main]), null);
});

test("packaged popout mode is explicit and permits layout/history access without execution capabilities", () => {
	for (const phase of ["record", "reopen"]) assert.deepEqual(portablePopoutCase(["--portable-smoke", "--portable-popouts=" + phase]), { phase });
	for (const args of [["--portable-popouts=record"], ["--portable-smoke", "--portable-popouts=invalid"], ["--portable-smoke", "--portable-popouts=record", "--portable-popouts=reopen"], ["--portable-smoke", "--portable-popouts=record", "--portable-runtime-loss=idle"]]) assert.throws(() => portablePopoutCase(args));
	assertPortablePopoutAction("workbench", { action: "ui-save" }); assertPortablePopoutAction("game", { action: "snapshot" });
	for (const [action, args] of [["probe", { mode: "offline" }], ["start-fixture"], ["bridge-select"], ["workbench", { action: "save" }], ["game", { action: "start" }], ["profiles-manage", { action: "save" }], ["journal", { action: "start" }]]) assert.throws(() => assertPortablePopoutAction(action, args), /PORTABLE_SMOKE_ACTION_REJECTED/);
});

test("only owned popouts open, child permissions are fixed, and opener teardown removes them", () => {
	class Contents extends EventEmitter { getURL() { return rendererUrl; } setWindowOpenHandler(fn) { this.open = fn; } }
	class Window extends EventEmitter {
		constructor(options = {}) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; this.bounds = options; }
		isDestroyed() { return this.destroyed; } removeMenu() {} show() {} getBounds() { return this.bounds; } setBounds(value) { this.bounds = value; } setMinimumSize() {}
		close() { this.destroy(); } destroy() { this.destroyed = true; this.emit("closed"); }
	}
	const owner = new Window(), screen = new EventEmitter(); screen.getAllDisplays = () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
	let closing = false;
	const manager = managePopoutWindows({ owner, BrowserWindow: Window, screen, closing: () => closing });
	const details = { url: popoutUrl, frameName: "1-3", features: "top=10,left=10,width=500,height=400" };
	assert.equal(owner.webContents.open({ ...details, url: "https://example.invalid" }).action, "deny");
	const allowed = owner.webContents.open(details); assert.equal(allowed.action, "allow");
	allowed.createWindow({ webPreferences: { preload: "/privileged.cjs", nodeIntegration: true, sandbox: false } });
	const child = manager.windows.get(details.frameName);
	assert.equal(child.options.webPreferences.preload, undefined); assert.equal(child.options.webPreferences.nodeIntegration, false); assert.equal(child.options.webPreferences.sandbox, true);
	const initial = { url: popoutUrl, isMainFrame: true, preventDefault() { this.prevented = true; } }; child.webContents.emit("will-frame-navigate", initial); assert.equal(initial.prevented, undefined);
	const external = { ...initial, url: "https://example.invalid" }; child.webContents.emit("will-navigate", external); assert.equal(external.prevented, true);
	child.webContents.emit("did-finish-load"); child.webContents.emit("will-navigate", initial); assert.equal(initial.prevented, true);
	assert.equal(child.webContents.open(details).action, "deny"); assert.equal(owner.webContents.open(details).action, "deny");
	screen.getAllDisplays = () => []; screen.emit("display-removed"); assert.equal(child.isDestroyed(), false);
	screen.getAllDisplays = () => [{ workArea: { x: -800, y: 0, width: 800, height: 600 } }]; screen.emit("display-added"); assert.ok(child.getBounds().x < 0);
	owner.webContents.emit("did-start-loading"); assert.equal(manager.windows.size, 0); assert.equal(child.isDestroyed(), true);
	closing = true; assert.equal(owner.webContents.open(details).action, "deny");
	owner.destroy(); assert.equal(screen.listenerCount("display-removed"), 0);
});
