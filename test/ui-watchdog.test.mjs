import test from "node:test";
import assert from "node:assert/strict";
import { createUiWatchdog } from "../apps/desktop/ui-watchdog.mjs";

test("a native timeout from before suspend cannot replace the UI after wake", async () => {
	let finish, generation = 0, recovered = 0;
	const record = { loaded: true, lastHeartbeat: 0, lastBeatSequence: 1 };
	const check = createUiWatchdog({ current: () => record, unavailable: () => false, generation: () => generation, now: () => 2000, inspect: () => new Promise(resolve => { finish = resolve; }), recover: async () => { recovered++; } });
	const pending = check(); assert.equal(record.nativeProbePending, true);
	generation++; finish({ exists: true, pidMatches: true, probeStatus: "timeout", responding: false }); await pending;
	assert.equal(recovered, 0); assert.equal(record.nativeProbePending, false);
});

function fixture(inspect) {
	let time = 1100, record = { loaded: true, lastHeartbeat: 0 };
	const recovered = [], notices = [];
	const check = createUiWatchdog({ current: () => record, unavailable: () => false, inspect, recover: async (reason) => recovered.push(reason), notice: (value) => notices.push(value), now: () => time });
	return { check, recovered, notices, record, advance: (value) => { time = value; }, replace: () => { record = { loaded: true, lastHeartbeat: time }; } };
}

test("a responsive native modal loop is preserved without fabricating a heartbeat", async () => {
	const f = fixture(async () => ({ exists: true, pidMatches: true, responding: true, probeStatus: "responsive" }));
	await f.check(); f.advance(2500); await f.check();
	assert.equal(f.recovered.length, 0); assert.equal(f.record.lastHeartbeat, 0); assert.equal(f.notices.length, 1);
	f.record.lastHeartbeat = 2600; f.advance(2700); await f.check();
	assert.equal(f.record.nativeResponsiveSince, undefined);
});
test("stale JavaScript and an unresponsive native thread trigger the original recovery", async () => {
	const f = fixture(async () => ({ exists: true, pidMatches: true, responding: false, probeStatus: "timeout" }));
	await f.check(); assert.deepEqual(f.recovered, ["ui-heartbeat-timeout"]);
});
test("a late native probe cannot replace a recovered UI or override a fresh heartbeat", async () => {
	let finish;
	const f = fixture(() => new Promise((done) => { finish = done; }));
	const pending = f.check(); f.record.lastHeartbeat = 1100; finish({ responding: false }); await pending;
	assert.equal(f.recovered.length, 0);
	f.advance(2500); const stale = f.check(); f.replace(); finish({ responding: false }); await stale;
	assert.equal(f.recovered.length, 0);
});
test("long responsive native operations are preserved and a later real hang still recovers", async () => {
	let calls = 0, finish;
	const f = fixture(() => { calls++; return new Promise((done) => { finish = done; }); });
	const first = f.check(); await f.check(); assert.equal(calls, 1);
	finish({ exists: true, pidMatches: true, responding: true, probeStatus: "responsive" }); await first;
	f.advance(16200); const expired = f.check(); finish({ exists: true, pidMatches: true, responding: true, probeStatus: "responsive" }); await expired;
	assert.deepEqual(f.recovered, []); assert.equal(f.notices.at(-1).prolonged, true);
	f.advance(17000); const hang = f.check(); finish({ exists: true, pidMatches: true, responding: false, probeStatus: "timeout" }); await hang;
	assert.deepEqual(f.recovered, ["ui-heartbeat-timeout"]);
});
test("unknown probes and mismatched identity stop automatic replacement without claiming a hang", async () => {
	const f = fixture(async () => ({ exists: true, pidMatches: false, responding: true, probeStatus: "identity_changed" }));
	await f.check(); f.advance(1800); await f.check(); f.advance(4000); await f.check();
	assert.equal(f.recovered.length, 0); assert.equal(f.record.nativeProbeUnknowns, 2); assert.equal(f.record.nativeProbePending, true);
	assert.equal(f.notices.at(-1).blocked, true);
});
