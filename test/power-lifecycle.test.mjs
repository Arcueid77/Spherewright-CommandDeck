import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PowerLifecycle, bindPowerMonitor } from "../apps/desktop/power-lifecycle.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("wake waits for in-flight work, invalidates competing checks and never restores after a newer suspension", async () => {
	const drain = deferred(), check = deferred(); let checks = 0, restores = 0;
	const power = new PowerLifecycle({ quiesce: () => drain.promise, check: async () => { checks++; await check.promise; }, restore: async () => { restores++; } });
	power.suspend(); assert.throws(() => power.assertAction("probe", { mode: "offline" }), /SYSTEM_POWER_PAUSED/);
	assert.throws(() => power.retry(), /SYSTEM_WAKE_NOT_OBSERVED/);
	const first = power.wake(); assert.equal(checks, 0); assert.equal(power.wake(), first);
	drain.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(checks, 1);
	power.suspend(); check.resolve(); await first; assert.equal(restores, 0); assert.equal(power.snapshot().phase, "suspended");
	await power.wake(); assert.equal(restores, 1); assert.equal(power.ready, true);
});

test("failed wake remains blocked until an explicit retry and retains one second of watchdog grace", async () => {
	let attempts = 0, restores = 0, now = 0;
	const power = new PowerLifecycle({ quiesce: async () => {}, check: async () => { if (++attempts === 1) throw new Error("WINDOW_STATE_UNCONFIRMED"); }, restore: async () => { restores++; }, now: () => now });
	await power.wake(); assert.equal(power.snapshot().phase, "blocked"); assert.equal(power.snapshot().canRetry, true);
	assert.equal(attempts, 1); assert.equal(restores, 0);
	for (const [action, args] of [["game-confirmed", {}], ["workbench", { action: "save" }], ["bridge", { action: "refresh" }], ["profiles-manage", { action: "save" }]]) assert.throws(() => power.assertAction(action, args), /SYSTEM_POWER_PAUSED/);
	for (const [action, args] of [["game", { action: "snapshot" }], ["workbench", { action: "ui-save" }], ["close", {}]]) assert.doesNotThrow(() => power.assertAction(action, args));
	await power.retry(); assert.equal(power.ready, true); assert.equal(restores, 1); assert.equal(power.watchdogUnavailable(), true);
	now = 1000; assert.equal(power.watchdogUnavailable(), false);
	let restoreAttempts = 0;
	const interrupted = new PowerLifecycle({ quiesce: async () => {}, check: async () => {}, restore: async () => { if (++restoreAttempts === 1) throw new Error("POWER_RESTORE_DEFERRED"); } });
	await interrupted.wake(); assert.equal(interrupted.snapshot().phase, "blocked"); assert.equal(interrupted.snapshot().error, "POWER_RESTORE_DEFERRED");
	await interrupted.retry(); assert.equal(interrupted.ready, true); assert.equal(restoreAttempts, 2);
});

test("monitor shutdown detaches exact listeners and prevents late restoration", async () => {
	const monitor = new EventEmitter(), check = deferred(); let restores = 0;
	const power = new PowerLifecycle({ quiesce: async () => {}, check: () => check.promise, restore: async () => { restores++; } });
	const close = bindPowerMonitor(monitor, power);
	monitor.emit("suspend"); monitor.emit("resume"); await new Promise(resolve => setImmediate(resolve));
	close(); check.resolve(); await power.operation.promise;
	assert.equal(restores, 0); assert.equal(monitor.listenerCount("suspend"), 0); assert.equal(monitor.listenerCount("resume"), 0);
});

test("wake during a failed close is remembered without reopening admission until an explicit retry", async () => {
	let active = false, restores = 0;
	const monitor = new EventEmitter(), power = new PowerLifecycle({ quiesce: async () => {}, check: async () => {}, restore: async () => { restores++; } });
	const close = bindPowerMonitor(monitor, power, () => active);
	monitor.emit("suspend"); monitor.emit("resume"); await power.drain;
	assert.equal(power.snapshot().phase, "blocked"); assert.equal(restores, 0); assert.equal(power.snapshot().canRetry, true);
	active = true; await power.retry(); assert.equal(power.ready, true); assert.equal(restores, 1); close();
});
