import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const delay=ms=>new Promise(done=>setTimeout(done,ms));
export async function runObservationSmoke(driver) {
	const base=join(driver.root,'.local/m2-smoke',driver.runId),path=join(base,'Spherewright.Mcp.exe');
	await mkdir(base,{recursive:true});await writeFile(path,'OWNED_M2_SYNTHETIC_FIXTURE');
	const state=()=>driver.api('bridge',{action:'snapshot'}),evaluate=source=>driver.testCommand('evaluate',{source});
	async function until(predicate,label){const end=Date.now()+8000;while(!await predicate()){assert.ok(Date.now()<end,label);await delay(60);}}
	assert.deepEqual((await state()).observationPolicy,{maxToolRequests:12,maxDurationMs:10000});
	for(const action of ['catalog','start','stop','reconcile','reprepare'])await assert.rejects(driver.api('game',{action,args:{}}),/READ_ONLY_OBSERVATION_MODE/);
	for(const action of ['agent','check','save','revert','grants','attach-reference','add'])await assert.rejects(driver.api('workbench',{action,args:{}}),/READ_ONLY_OBSERVATION_MODE/);
	await assert.rejects(driver.api('probe',{mode:'offline'}),/READ_ONLY_OBSERVATION_MODE/);
	await assert.rejects(driver.api('game-confirmed',{nonce:'invented'}),/READ_ONLY_OBSERVATION_MODE/);
	assert.equal((await driver.api('game',{action:'snapshot'})).readOnlyObservation,true);
	await driver.api('bridge-select',path);await driver.api('bridge',{action:'refresh'});
	await until(async()=>(await state()).observation?.production.data?.coverage.complete===true,'OBSERVATION_INITIAL_READ');
	assert.equal((await state()).metadata.researchAvailable,false);const pid=driver.getBridgePid();
	await driver.testCommand('show-ui');await evaluate("[...document.querySelectorAll('header button')].find(button=>button.textContent==='只读舰桥').click()");
	await until(async()=>(await evaluate('document.body.innerText')).includes('本次限时只读观测'),'OBSERVATION_BANNER');
	const end=Date.now()+8000;
	while((await state()).requestPerformance?.observationLimit?.stopReason===null){assert.ok(Date.now()<end,'OBSERVATION_LIMIT_NOT_REACHED');await driver.api('bridge',{action:'refresh'});await delay(100);}
	await until(async()=>(await state()).requestPerformance?.lifetime.state==='exit_observed','OBSERVATION_EXIT');
	const ended=await state();assert.equal(ended.requestPerformance.observationLimit.toolRequests,12);assert.equal(ended.requestPerformance.observationLimit.remainingToolRequests,0);assert.equal(ended.requestPerformance.observationLimit.stopReason,'MCP_OBSERVATION_REQUEST_LIMIT');assert.equal(ended.observation.connected,false);assert.equal(driver.bridgeExitConfirmed(),true);
	await assert.rejects(driver.api('bridge',{action:'connect'}),/OBSERVATION_SCOPE_CONSUMED/);await assert.rejects(driver.api('bridge-select',path),/OBSERVATION_SCOPE_CONSUMED/);assert.equal(driver.getBridgePid(),pid);
	await until(async()=>(await evaluate('document.body.innerText')).includes('已达请求上限'),'OBSERVATION_END_DISPLAY');
	const game=await driver.api('game',{action:'snapshot'});assert.equal(game.tasks.length,0);assert.equal(game.unresolved.length,0);
	await writeFile(join(driver.root,'.local/desktop-smoke-observation.json'),JSON.stringify({runId:driver.runId,syntheticOnly:true,readOnlyEnforced:true,oneClientOnly:true,toolRequests:12,requestLimitEnforced:true,reconnectCannotReset:true,ownServerExitConfirmed:true,noGameTasksCreated:true,gameCalls:0,modelRequests:0,measurement:ended.requestPerformance},null,2));
}
