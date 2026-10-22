import test from "node:test";
import assert from "node:assert/strict";
import { ageObservation } from "../apps/renderer/src/observation-state.ts";
const fixture = () => {
	const data = { capturedAtGameTick: 1200 }, record = { state: "observed", reason: null, ageMs: 5000, data };
	return { connected: true, refreshing: true, bridge: record, session: record, summary: record, production: record };
};
test("the UI ages cached data even when a supervisor request never completes", () => {
	const original = fixture(), shown = ageObservation(original, 11000);
	assert.equal(shown.summary.state, "stale"); assert.equal(shown.summary.ageMs, 16000); assert.equal(shown.summary.data.capturedAtGameTick, 1200);
	assert.equal(original.summary.state, "observed"); assert.equal(original.summary.ageMs, 5000);
});
test("supervisor disconnect invalidates all old premises immediately", () => {
	const shown = ageObservation(fixture(), 0, true);
	assert.equal(shown.connected, false); assert.equal(shown.refreshing, false);
	for (const key of ["bridge", "session", "summary", "production"]) { assert.equal(shown[key].state, "stale"); assert.equal(shown[key].reason, "UI_CONNECTION_UNAVAILABLE"); }
});
test("missing ages never become fresh and unsupported data is not invented", () => {
	const value = fixture(); value.summary = { ...value.summary, ageMs: null }; value.production = { state: "unsupported", reason: "READ_TOOL_UNSUPPORTED", ageMs: null, data: null };
	const shown = ageObservation(value, 0); assert.equal(shown.summary.state, "stale"); assert.equal(shown.production.state, "unsupported"); assert.equal(shown.production.data, null); assert.equal(ageObservation(null, 1000), null);
});
test("a delayed age-zero RPC snapshot is stale on arrival and only a new snapshot can recover", () => {
	const response = fixture(); for (const key of ["bridge", "session", "summary", "production"]) response[key] = { ...response[key], ageMs: 0 };
	const delayed = ageObservation(response, 20000); assert.equal(delayed.summary.state, "stale"); assert.equal(delayed.summary.ageMs, 20000);
	const fresh = ageObservation(response, 5); assert.equal(fresh.summary.state, "observed"); assert.equal(fresh.summary.ageMs, 5);
});
test("runtime sample ages keep advancing in the UI and disconnect preserves only stale measurements", () => {
	const original={...fixture(),runtimePerformance:{state:'warming_up',reason:null,ageMs:14000,data:{sampleCount:1}}};
	const shown=ageObservation(original,2000); assert.equal(shown.runtimePerformance.ageMs,16000); assert.equal(shown.runtimePerformance.state,'stale');
	assert.equal(original.runtimePerformance.ageMs,14000); assert.equal(original.runtimePerformance.state,'warming_up');
	const disconnected=ageObservation(original,0,true); assert.equal(disconnected.runtimePerformance.state,'stale'); assert.equal(disconnected.runtimePerformance.data.sampleCount,1);
});
