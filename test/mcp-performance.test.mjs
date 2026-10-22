import test from 'node:test';
import assert from 'node:assert/strict';
import {McpPerformance} from '../apps/desktop/mcp-performance.mjs';

test('client timings keep empty durations unknown and account for overlapping requests once',()=>{
	let now=100;const meter=new McpPerformance({now:()=>now});
	assert.equal(meter.snapshot().durationMs,null);assert.equal(meter.snapshot().windowDurationMs,null);
	const first=meter.begin('tool');now=110;const second=meter.begin('metadata');
	assert.equal(meter.snapshot().pending,2);assert.equal(meter.snapshot().peakPending,2);
	now=130;second('rpcErrors');now=150;first('responses');first('aborted');
	const aborted=meter.begin('resource');now=1000;aborted('aborted');
	const snapshot=meter.snapshot();assert.equal(snapshot.started,3);assert.equal(snapshot.responses,1);assert.equal(snapshot.rpcErrors,1);assert.equal(snapshot.aborted,1);assert.equal(snapshot.pending,0);
	assert.deepEqual(snapshot.durationMs,{meanMs:35,p95Ms:50,maxMs:50});assert.equal(snapshot.windowDurationMs,900);assert.equal(snapshot.roundTripSampleCount,2);
	assert.deepEqual(snapshot.byKind.tool.durationMs,{meanMs:50,p95Ms:50,maxMs:50});assert.equal(snapshot.byKind.resource.durationMs,null);
	snapshot.byKind.tool.started=999;assert.equal(meter.snapshot().byKind.tool.started,1);
});
test('the client sample window is bounded while lifetime counts retain overwritten observations',()=>{
	let now=0;const meter=new McpPerformance({now:()=>now,startedAt:0});
	for(let index=1;index<=130;index++){now=index*1000;const finish=meter.begin('tool');now+=index;finish('responses');}
	now+=500;const snapshot=meter.snapshot();
	assert.equal(snapshot.started,130);assert.equal(snapshot.sampleCount,128);assert.equal(snapshot.sampleCapacity,128);
	assert.deepEqual(snapshot.durationMs,{meanMs:66.5,p95Ms:124,maxMs:130});assert.equal(snapshot.windowDurationMs,127130);assert.equal(snapshot.lastCompletedAgeMs,500);
	assert.equal(snapshot.lifetime.basis,'launch_request');
});
test('only an observed exit freezes the client lifetime, with its original measurement origin',()=>{
	let now=10;const meter=new McpPerformance({now:()=>now});const finish=meter.begin('tool');
	now=20;finish('aborted');assert.equal(meter.snapshot().lifetime.state,'running');
	assert.equal(meter.snapshot().durationMs,null);assert.equal(meter.snapshot().roundTripSampleCount,0);
	now=40;meter.endLifetime('exit_observed');now=100;meter.endLifetime('launch_failed');
	assert.deepEqual(meter.snapshot().lifetime,{state:'exit_observed',basis:'client_attachment',durationMs:30,endedAgeMs:60});
	assert.equal(meter.snapshot().aborted,1);assert.throws(()=>meter.begin('tool'),/MEASUREMENT_CLOSED/);
	const failed=new McpPerformance({now:()=>now});failed.endLifetime('launch_failed');assert.equal(failed.snapshot().lifetime.state,'launch_failed');
});
