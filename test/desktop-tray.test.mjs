import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createDesktopTray } from "../apps/desktop/desktop-tray.mjs";

function fixture(callbacks = {}) {
	let created = 0, destroyed = 0; const notices = [];
	class Tray extends EventEmitter {
		constructor() { super(); created++; }
		setContextMenu(menu) { this.menu = menu; }
		setToolTip() {}
		destroy() { destroyed++; }
	}
	const controller = createDesktopTray({ Tray, Menu: { buildFromTemplate: items => ({ items, getMenuItemById: id => items.find(item => item.id === id) }) }, nativeImage: { createFromBitmap: () => ({ isEmpty: () => false }) }, open: async () => {}, exit: async () => {}, notice: code => notices.push(code), ...callbacks });
	return { controller, notices, counts: () => ({ created, destroyed }) };
}

test("tray serializes native exit and rejects competing activations until its outcome is known", async () => {
	let finish, exits = 0, opens = 0;
	const f = fixture({ exit: () => { exits++; return new Promise(resolve => { finish = resolve; }); }, open: async () => { opens++; } });
	const pending = f.controller.activate("exit");
	assert.equal(exits, 1); assert.equal(f.controller.menu.getMenuItemById("exit").enabled, false);
	assert.equal(await f.controller.activate("exit"), false); assert.equal(await f.controller.activate("open"), false);
	finish(); assert.equal(await pending, true); assert.equal(exits, 1); assert.equal(opens, 0);
	assert.equal(f.controller.menu.getMenuItemById("open").enabled, true);
	f.controller.destroy(); assert.deepEqual(f.counts(), { created: 1, destroyed: 1 });
});

test("failed tray drain retains the tray and permits an explicit retry without an automatic second exit", async () => {
	let exits = 0, opens = 0;
	const f = fixture({ exit: async () => { if (++exits === 1) throw new Error("RESTORATION_NOT_CONFIRMED"); }, open: async () => { opens++; } });
	assert.equal(await f.controller.activate("exit"), false); assert.equal(exits, 1);
	assert.deepEqual(f.notices, ["TRAY_EXIT_BLOCKED"]); assert.deepEqual(f.counts(), { created: 1, destroyed: 0 });
	assert.equal(await f.controller.activate("open"), true); assert.equal(opens, 1);
	assert.equal(await f.controller.activate("exit"), true); assert.equal(exits, 2);
	f.controller.destroy();
});

test("destroying a tray during an activation prevents late menu recreation and further callbacks", async () => {
	let finish, opens = 0;
	const f = fixture({ open: () => { opens++; return new Promise(resolve => { finish = resolve; }); } });
	const pending = f.controller.activate("open"), menu = f.controller.menu;
	f.controller.destroy(); f.controller.destroy(); finish(); assert.equal(await pending, true);
	assert.equal(f.controller.menu, menu); assert.equal(await f.controller.activate("open"), false); assert.equal(opens, 1);
	assert.equal(f.controller.nativeTray.listenerCount("double-click"), 0);
	assert.deepEqual(f.counts(), { created: 1, destroyed: 1 });
});
