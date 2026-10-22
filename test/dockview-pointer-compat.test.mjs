import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { correctDockviewPointerStart, dockviewPointerCompatibility } from "../scripts/dockview-pointer-compat.mjs";

const original = readFileSync(new URL(import.meta.resolve("dockview-core")), "utf8");
function controllerFor(source) {
	const start = source.indexOf("var PointerDragController = class PointerDragController");
	const end = source.indexOf("\n//#endregion", start);
	assert.ok(start >= 0 && end > start);
	class Disposable { addDisposables() {} }
	class Emitter { event() {} fire() {} }
	const listeners = new Map(), element = { parentElement: null }, over = [], drops = [];
	const view = {}, document = { defaultView: view, elementsFromPoint: () => [element] };
	const Controller = runInNewContext(`${source.slice(start, end)}\nPointerDragController;`, {
		CompositeDisposable: Disposable, Emitter, window: view, document,
		getHitTestRoot: () => document,
		disableIframePointEvents: () => ({ release() {} }), disableTextSelection: () => ({ release() {} }),
		addDisposableListener(_target, type, listener) { listeners.set(type, listener); return { dispose: () => listeners.delete(type) }; },
		setTimeout: (callback) => callback(),
	});
	const controller = new Controller();
	controller.registerTarget({ element, handleDragOver: (event) => over.push([event.clientX, event.clientY]), handleDrop: (event) => drops.push([event.clientX, event.clientY]), handleDragLeave() {} });
	const event = { pointerId: 7, clientX: 450, clientY: 20 };
	controller.beginDrag({ pointerEvent: event, source: { ownerDocument: document }, getData: () => ({ dispose() {} }) });
	return { controller, over, drops, finish: (type) => listeners.get(type)(event) };
}

test("the threshold-crossing move establishes its target before an immediate release", () => {
	const baseline = controllerFor(original); baseline.finish("pointerup"); assert.equal(baseline.drops.length, 0);
	const fixed = controllerFor(correctDockviewPointerStart(original));
	assert.deepEqual(fixed.over, [[450, 20]]); assert.equal(fixed.drops.length, 0);
	fixed.finish("pointerup"); assert.deepEqual(fixed.drops, [[450, 20]]); assert.equal(fixed.controller.active, undefined);
});

test("cancelling a promoted drag never drops its highlighted target", () => {
	const fixed = controllerFor(correctDockviewPointerStart(original));
	fixed.finish("pointercancel"); assert.equal(fixed.drops.length, 0); assert.equal(fixed.controller.active, undefined);
});

test("dependency changes and a missing build transform fail explicitly", () => {
	assert.throws(() => correctDockviewPointerStart(original + "\n"), /DOCKVIEW_POINTER_SOURCE_CHANGED/);
	const plugin = dockviewPointerCompatibility(); plugin.buildStart();
	assert.equal(plugin.transform(original, "/other-module.mjs"), undefined);
	assert.throws(() => plugin.buildEnd(), /DOCKVIEW_POINTER_FIX_NOT_APPLIED/);
	assert.ok(plugin.transform(original, "/node_modules/dockview-core/dist/package/main.esm.mjs").code);
	assert.doesNotThrow(() => plugin.buildEnd());
});
