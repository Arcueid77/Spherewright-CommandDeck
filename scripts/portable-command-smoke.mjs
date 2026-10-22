import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,realpath,readdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {prepareCommandHost,runManagedCommand} from '../apps/desktop/command-host.mjs';
import {commandManifestName} from '../apps/desktop/command-cohort.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
if(process.platform!=='win32'||args.length!==2||args[0]!=='--source')throw new Error('EXPLICIT_WINDOWS_PORTABLE_SOURCE_REQUIRED');
const source=await realpath(resolve(root,args[1])),manifest=JSON.parse(await readFile(join(source,commandManifestName),'utf8'));
assert.equal(manifest.selfContained,true);
const directory=await mkdtemp(join(tmpdir(),'commanddeck-portable-')),runId=randomUUID(),proofDirectory=join(root,'.local/portable-command',runId);await mkdir(proofDirectory,{recursive:true});
const keys=['PATH','DOTNET_ROOT','DOTNET_ROOT_X64','DOTNET_MULTILEVEL_LOOKUP','DOTNET_DISABLE_GUI_ERRORS','COREHOST_TRACE','COREHOST_TRACEFILE'],saved=new Map(keys.map(key=>[key,process.env[key]]));
try{
	const host=await prepareCommandHost(source,join(directory,'cache')),again=await prepareCommandHost(source,join(directory,'cache'));
	assert.equal(host.identity,again.identity);assert.equal(host.fileCount,manifest.files.length+1);assert.equal((await readdir(dirname(host.executable))).length,host.fileCount);
	const system=process.env.SystemRoot,tracePath=join(proofDirectory,'runtime.trace.private.log');
	Object.assign(process.env,{PATH:join(system,'System32'),DOTNET_ROOT:join(directory,'no-shared-runtime'),DOTNET_ROOT_X64:join(directory,'no-shared-runtime'),DOTNET_MULTILEVEL_LOOKUP:'0',DOTNET_DISABLE_GUI_ERRORS:'1',COREHOST_TRACE:'1',COREHOST_TRACEFILE:tracePath});
	// The controlled child is this existing test runner, addressed absolutely; it
	// is a test fixture, not an end-user Node dependency or a clean-machine claim.
	const command={host:host.executable,executable:process.execPath,cwd:directory};
	const result=await runManagedCommand({...command,args:['-e','process.exitCode=17']});assert.equal(result.exitCode,17);assert.equal(result.reason,'exited');assert.equal(result.treeConfirmed,true);assert.equal(result.streamsDrained,true);
	const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),600);let cancelled;
	try{cancelled=await runManagedCommand({...command,args:['-e','setInterval(()=>{},1000)'],signal:controller.signal});}finally{clearTimeout(timer);}
	assert.equal(cancelled.reason,'cancelled');assert.equal(cancelled.treeConfirmed,true);
	const timeout=await runManagedCommand({...command,args:['-e','setInterval(()=>{},1000)'],timeoutMs:200});assert.equal(timeout.reason,'timeout');assert.equal(timeout.treeConfirmed,true);
	const long=await prepareCommandHost(source,join(directory,'long-'+ 'a'.repeat(90),'nested-'+ 'b'.repeat(90)));assert.ok(long.executable.length>260);
	const longResult=await runManagedCommand({...command,host:long.executable,args:['-e','process.exitCode=23']});assert.equal(longResult.exitCode,23);assert.equal(longResult.treeConfirmed,true);
	const trace=await readFile(tracePath,'utf8');assert.ok(trace.toLowerCase().includes(join(dirname(host.executable),'hostfxr.dll').toLowerCase()));assert.ok(trace.toLowerCase().includes(join(dirname(host.executable),'coreclr.dll').toLowerCase()));
	const proof={runId,sourceRevision:manifest.sourceRevision,selfContained:true,runtimeIdentifier:manifest.runtimeIdentifier,sourceFiles:manifest.files.length,cachedFiles:host.fileCount,warmCacheUnchanged:true,sdkAndDeveloperToolsAbsentFromPath:true,childFixture:'existing-test-runner-at-absolute-path',dotnetRootUnavailable:true,appLocalRuntimeObserved:true,normalExitCode:result.exitCode,normalTreeAndStreamsConfirmed:true,cancellationConfirmed:true,timeoutConfirmed:true,longCachePathSupported:true,gameCalls:0,modelRequests:0,cleanWindowsVmVerified:false,traceSha256:createHash('sha256').update(trace).digest('hex')};
	await writeFile(join(proofDirectory,'proof.json'),JSON.stringify(proof,null,2),{flag:'wx'});await writeFile(join(root,'.local/portable-command-smoke.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({portableCommandSmoke:'passed',cachedFiles:host.fileCount,normalExitCode:17,cancel:true,timeout:true,longCache:true,gameCalls:0,cleanWindowsVmVerified:false}));
}finally{
	for(const [key,value]of saved)value===undefined?delete process.env[key]:process.env[key]=value;
	const absolute=await realpath(resolve(directory));assert.equal(dirname(absolute).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(absolute).startsWith('commanddeck-portable-'));await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
