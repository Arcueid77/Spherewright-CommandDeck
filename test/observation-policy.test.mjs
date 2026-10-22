import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {observationArguments,observationLimits,assertObservationAction} from '../apps/desktop/observation-policy.mjs';
import {ReadOnlyMcpClient,launchMcp} from '../apps/desktop/mcp-client.mjs';
import {BridgeMonitor} from '../apps/desktop/bridge-monitor.mjs';
const selection={path:'owned-fixture/Spherewright.Mcp.exe',cohortHash:'a'.repeat(64),fileCount:1};
function client(t,observation,mode='normal',extra={}){
	const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/mcp-server.mjs',import.meta.url)),mode],{stdio:'pipe',windowsHide:true});
	const value=new ReadOnlyMcpClient(child,{observation,...extra});t.after(()=>value.close());return value;
}
test('observation arguments require one explicit mode and bounded immutable limits',()=>{
	assert.equal(observationArguments(['--workspace','source']),null);
	assert.deepEqual(observationArguments(['--observe-only']),{maxToolRequests:40,maxDurationMs:20000});
	assert.deepEqual(observationArguments(['--observe-max-ms','1000','--observe-only','--observe-max-tools','2']),{maxToolRequests:2,maxDurationMs:1000});
	for(const args of [['--observe-max-ms','1000'],['--observe-only','--observe-only'],['--observe-only=true'],['--observe-only','--observe-max-tools','0'],['--observe-only','--observe-max-ms','999'],['--observe-only','--observe-max-ms','300001'],['--observe-only','--observe-max-tools','257'],['--observe-only','--observe-max-tools','12junk'],['--observe-only','--observe-max-tools'],['--observe-mystery']])assert.throws(()=>observationArguments(args),/OBSERVATION/);
	const raw={maxToolRequests:2,maxDurationMs:1000},limits=observationLimits(raw);raw.maxToolRequests=9;assert.equal(limits.maxToolRequests,2);assert.equal(Object.isFrozen(limits),true);
});
test('the host observation gate refuses model, approval and development execution while preserving readonly UI access',()=>{
	const limits=observationArguments(['--observe-only']);
	for(const action of ['catalog','start','stop','reconcile','reprepare'])assert.throws(()=>assertObservationAction(limits,'game',{action}),/READ_ONLY_OBSERVATION_MODE/);
	for(const action of ['check','agent','save','revert','grants','attach-reference','add'])assert.throws(()=>assertObservationAction(limits,'workbench',{action}),/READ_ONLY_OBSERVATION_MODE/);
	for(const action of ['probe','game-confirmation','game-confirmed','attach','start-fixture'])assert.throws(()=>assertObservationAction(limits,action,{}),/READ_ONLY_OBSERVATION_MODE/);
	for(const action of ['state','task','read','diff','change-diff','read-reference','ui-get','ui-save'])assert.doesNotThrow(()=>assertObservationAction(limits,'workbench',{action}));
	assert.doesNotThrow(()=>assertObservationAction(limits,'game',{action:'snapshot'}));assert.doesNotThrow(()=>assertObservationAction(null,'game',{action:'start'}));
});
test('conflicting writer authority and invalid limits refuse before a process launch',()=>{
	assert.throws(()=>launchMcp(selection,{observation:{maxToolRequests:1,maxDurationMs:1000},researchAuthority:{}}),/OBSERVATION_REQUIRES_READ_ONLY_CLIENT/);
	assert.throws(()=>launchMcp(selection,{observation:{maxToolRequests:0,maxDurationMs:1000}}),/INVALID_OBSERVATION_LIMITS/);
});
test('the last allowed tool response closes its readonly client and cannot admit a replacement request',async t=>{
	const c=client(t,{maxToolRequests:2,maxDurationMs:10000});await c.discover();assert.equal(c.metadata.researchAvailable,false);
	assert.throws(()=>c.researchPort({}),/TRUSTED_RESEARCH_CAPABILITY_REQUIRED/);
	await c.read('spherewright_get_status');await c.read('spherewright_get_session_state');
	await assert.rejects(c.read('spherewright_get_status'),/READ_NOT_SUPPORTED/);await c.close();
	const value=c.requestPerformance();assert.equal(value.byKind.tool.started,2);assert.equal(value.observationLimit.remainingToolRequests,0);assert.equal(value.observationLimit.stopReason,'MCP_OBSERVATION_REQUEST_LIMIT');assert.equal(value.lifetime.state,'exit_observed');
});
test('parallel callers cannot cross the admitted tool-request limit',async t=>{
	const c=client(t,{maxToolRequests:2,maxDurationMs:10000});await c.discover();
	const results=await Promise.allSettled(Array.from({length:5},()=>c.read('spherewright_get_status')));assert.ok(results.some(value=>value.status==='rejected'));
	await c.close();assert.equal(c.requestPerformance().byKind.tool.started,2);assert.equal(c.requestPerformance().observationLimit.toolRequests,2);
});
test('the observation deadline ends stalled discovery rather than renewing a per-request timeout',async t=>{
	const c=client(t,{maxToolRequests:2,maxDurationMs:1000},'stall',{timeoutMs:10000});
	await assert.rejects(c.discover(),/MCP_OBSERVATION_TIME_LIMIT/);await c.close();
	assert.equal(c.requestPerformance().observationLimit.stopReason,'MCP_OBSERVATION_TIME_LIMIT');assert.equal(c.requestPerformance().byKind.tool.started,0);assert.equal(c.exitConfirmed,true);
});
test('an already expired launch interval refuses even metadata before admission',async t=>{
	const c=client(t,{maxToolRequests:2,maxDurationMs:1000},'normal',{startedAt:performance.now()-2000});
	await assert.rejects(c.discover(),/MCP_OBSERVATION_TIME_LIMIT/);await c.close();assert.equal(c.stats.requests,0);
});
test('an idle discovered client still expires without requiring another UI or tool request',async t=>{
	const c=client(t,{maxToolRequests:2,maxDurationMs:1000});await c.discover();await c.exited;
	assert.equal(c.requestPerformance().observationLimit.stopReason,'MCP_OBSERVATION_TIME_LIMIT');assert.equal(c.requestPerformance().byKind.tool.started,0);assert.equal(c.exitConfirmed,true);
});
test('a limited monitor consumes its one launch, strips writer authority and preserves its ended client',async()=>{
	let starts=0,seen;const originalAuthority={},monitor=new BridgeMonitor({observation:{maxToolRequests:2,maxDurationMs:1000},researchAuthority:originalAuthority,fingerprint:async()=>selection,launch(_selection,options){seen=options;starts++;return {closed:false,exitConfirmed:false,stats:{toolCalls:0},async discover(){return {researchAvailable:false,readTools:[]};},supports:()=>false,async close(){this.closed=true;this.exitConfirmed=true;}};}});
	await monitor.select(selection.path);assert.equal(seen.researchAuthority,null);assert.deepEqual(seen.observation,{maxToolRequests:2,maxDurationMs:1000});assert.throws(()=>monitor.acquireResearch(originalAuthority),/RESEARCH_BRIDGE_UNAVAILABLE/);
	await monitor.disconnect();const ended=monitor.telemetry;
	await assert.rejects(monitor.connect(),/OBSERVATION_SCOPE_CONSUMED/);await assert.rejects(monitor.select(selection.path),/OBSERVATION_SCOPE_CONSUMED/);assert.equal(starts,1);assert.equal(monitor.telemetry,ended);await monitor.close();
});
