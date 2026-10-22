import test from 'node:test';
import assert from 'node:assert/strict';
import {UiPerformance} from '../apps/renderer/src/ui-performance.ts';

function fixture(visible=true){
	let now=0, sequence=0;const callbacks=new Map(),cancelled=[];
	const meter=new UiPerformance({visible,now:()=>now,requestFrame:callback=>{callbacks.set(++sequence,callback);return sequence;},cancelFrame:id=>cancelled.push(id)});
	return {meter,cancelled,at:value=>{now=value;},last:()=>sequence,fire:id=>{const callback=callbacks.get(id);callbacks.delete(id);assert.ok(callback);callback();}};
}
test('UI measurement separates snapshot receipt, React commit and the following frame callback',()=>{
	const f=fixture(),m=f.meter;assert.equal(m.snapshot().rpc.durationMs,null);assert.equal(m.snapshot().frame.totalMs,null);
	const probe=m.beginSnapshot();f.at(10);const id=probe.received();assert.equal(m.snapshot().rpc.durationMs.meanMs,10);assert.equal(m.snapshot().frame.sampleCount,0);
	f.at(14);m.committed(id);f.at(30);f.fire(f.last());
	const value=m.snapshot();assert.equal(value.started,1);assert.equal(value.received,1);assert.equal(value.pending,0);assert.equal(value.frames,1);
	assert.equal(value.frame.commitMs.meanMs,4);assert.equal(value.frame.nextFrameMs.meanMs,16);assert.equal(value.frame.totalMs.meanMs,30);assert.equal(value.frame.windowDurationMs,30);
	value.rpc.durationMs.meanMs=999;assert.equal(m.snapshot().rpc.durationMs.meanMs,10);
});
test('hidden requests and visibility transitions cannot become foreground latency samples',()=>{
	const f=fixture(false),m=f.meter,hidden=m.beginSnapshot();f.at(100);assert.equal(hidden.received(),null);
	f.at(200);m.setVisible(true);const crossing=m.beginSnapshot();f.at(210);m.setVisible(false);f.at(220);m.setVisible(true);f.at(230);assert.equal(crossing.received(),null);
	f.at(240);const visible=m.beginSnapshot();f.at(250);const id=visible.received();f.at(260);m.committed(id);const callback=f.last();f.at(270);m.setVisible(false);f.at(330);f.fire(callback);
	const value=m.snapshot();assert.equal(value.hiddenOrTransition,2);assert.equal(value.rpc.sampleCount,1);assert.equal(value.frame.sampleCount,0);assert.equal(value.interrupted,1);assert.deepEqual(f.cancelled,[callback]);
});
test('a newer delivery coalesces one pending frame and a cancelled callback cannot erase its replacement',()=>{
	const f=fixture(),m=f.meter,a=m.beginSnapshot();f.at(5);const first=a.received();f.at(6);m.committed(first);const old=f.last();
	f.at(7);const b=m.beginSnapshot();f.at(8);const second=b.received();f.at(9);m.committed(second);const current=f.last();
	f.at(10);f.fire(old);m.committed(second);assert.equal(f.last(),current);f.at(25);f.fire(current);
	const value=m.snapshot();assert.equal(value.coalesced,1);assert.equal(value.rpc.sampleCount,2);assert.equal(value.frames,1);assert.equal(value.frame.totalMs.meanMs,18);assert.deepEqual(f.cancelled,[old]);
});
test('failed and discarded snapshots settle once without inventing successful timing samples',()=>{
	const f=fixture(),m=f.meter,failed=m.beginSnapshot();f.at(5);failed.failed();failed.failed();
	f.at(10);const stale=m.beginSnapshot();f.at(20);stale.discarded();assert.equal(stale.received(),null);
	const value=m.snapshot();assert.equal(value.started,2);assert.equal(value.failed,1);assert.equal(value.discarded,1);assert.equal(value.pending,0);assert.equal(value.rpc.durationMs,null);assert.equal(value.frame.totalMs,null);
});
test('UI windows stay bounded while a long visible frame wait remains in the measurements',()=>{
	const f=fixture(),m=f.meter;
	for(let index=1;index<=140;index++){f.at(index*1000);const probe=m.beginSnapshot();f.at(index*1000+2);const id=probe.received();f.at(index*1000+3);m.committed(id);f.at(index*1000+20);f.fire(f.last());}
	f.at(200000);const slow=m.beginSnapshot();f.at(200002);const id=slow.received();f.at(200003);m.committed(id);f.at(205003);f.fire(f.last());
	const value=m.snapshot();assert.equal(value.started,141);assert.equal(value.frames,141);assert.equal(value.rpc.sampleCount,128);assert.equal(value.frame.sampleCount,128);assert.equal(value.frame.nextFrameMs.maxMs,5000);assert.equal(value.frame.totalMs.maxMs,5003);
});
test('unavailable frame scheduling leaves the snapshot receipt usable and records missing coverage',()=>{
	let now=0;const m=new UiPerformance({now:()=>now,requestFrame:()=>{throw new Error('unavailable');}}),probe=m.beginSnapshot();now=2;const id=probe.received();
	now=3;assert.doesNotThrow(()=>m.committed(id));const value=m.snapshot();assert.equal(value.frameUnavailable,1);assert.equal(value.rpc.sampleCount,1);assert.equal(value.frame.totalMs,null);assert.equal(value.frames,0);
});
