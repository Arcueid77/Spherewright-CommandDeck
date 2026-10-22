import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePerformanceDatum } from '../apps/desktop/runtime-performance.mjs';
import { runtimePerformanceFixture } from './fixtures/runtime-performance.mjs';

test('runtime statistics retain source, bounded coverage, units and native sample age without private fields', () => {
	const value = runtimePerformanceDatum(runtimePerformanceFixture(), 1000);
	assert.equal(value.state, 'observed'); assert.equal(value.receivedAt, 997);
	assert.equal(value.data.updateInterval.p95Ms, 18); assert.equal(value.data.bridgePump.maxMs, 1.5);
	assert.equal(value.data.pendingMainThreadRequests, 2); assert.equal(value.data.sampleCount, 60);
	assert.ok(!JSON.stringify(value).includes('PRIVATE_SYNTHETIC'));
});
test('legacy and unknown runtime contracts are unsupported instead of zero', () => {
	for (const value of [undefined, null, { version: 2 }, { source: 'future' }]) {
		const actual = runtimePerformanceDatum(value, 1000);
		assert.equal(actual.state, 'unsupported'); assert.equal(actual.data, null); assert.equal(actual.receivedAt, null);
	}
});
test('unstarted sampler reports warming with unknown durations and age', () => {
	const value = runtimePerformanceFixture(); Object.assign(value, { state:'warming_up', completedUpdates:0, sampleCount:0, windowDurationMs:0, sampleAgeMs:null, updateInterval:null, bridgePump:null });
	const result = runtimePerformanceDatum(value, 1000);
	assert.equal(result.state, 'warming_up'); assert.equal(result.data.updateInterval, null); assert.equal(result.data.sampleAgeMs, null);
	value.updateInterval = { meanMs:0, p95Ms:0, maxMs:0 }; assert.equal(runtimePerformanceDatum(value, 1000).state, 'unavailable');
});
test('malformed runtime metrics do not disable other observation sources or invent timings', () => {
	for (const mutate of [v=>v.sampleCount=601, v=>v.sampleCapacity=0, v=>v.pendingMainThreadRequests=33,
		v=>v.lastProcessedMainThreadRequests=5, v=>v.mainThreadBudgetMs=0, v=>v.windowDurationMs=Infinity,
		v=>v.completedUpdates=1, v=>v.sampleAgeMs=null, v=>v.state='warming_up', v=>v.scope='world',
		v=>v.source='gpu-fps', v=>v.updateInterval.maxMs=1, v=>v.bridgePump.meanMs=NaN]) {
		const value=runtimePerformanceFixture(); mutate(value);
		const result=runtimePerformanceDatum(value,1000); assert.equal(result.state,'unavailable'); assert.equal(result.data,null);
	}
});
