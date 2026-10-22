import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,symlink} from 'node:fs/promises';
import {join,dirname,basename,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareCommandHost} from '../apps/desktop/command-host.mjs';
import {commandHostFiles,commandManifestName,commandHash,sealCommandHost} from '../apps/desktop/command-cohort.mjs';
async function fixture(t,selfContained=true){
	const root=await mkdtemp(join(tmpdir(),'commanddeck-cohort-'));t.after(async()=>{const path=await realpath(resolve(root));assert.equal(dirname(path).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(path).startsWith('commanddeck-cohort-'));await rm(path,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
	const source=join(root,'source'),cache=join(root,'cache');await mkdir(source);
	for(const name of commandHostFiles)await writeFile(join(source,name),name.endsWith('runtimeconfig.json')?JSON.stringify({runtimeOptions:selfContained?{includedFrameworks:[{name:'Microsoft.NETCore.App',version:'8.0.0'}]}:{framework:{name:'Microsoft.NETCore.App',version:'8.0.0'}}}):name.endsWith('deps.json')?JSON.stringify({runtimeTarget:{name:'.NETCoreApp,Version=v8.0/win-x64'}}):name);
	if(selfContained)for(const name of ['hostfxr.dll','hostpolicy.dll','coreclr.dll','System.Private.CoreLib.dll','runtime-extra.dll'])await writeFile(join(source,name),name+' fixture');
	return {root,source,cache};
}
test('legacy framework-dependent cohorts retain their exact four-file identity and behavior',async t=>{
	const f=await fixture(t,false),expected=commandHash(Buffer.concat(await Promise.all(commandHostFiles.map(name=>readFile(join(f.source,name))))));
	const result=await prepareCommandHost(f.source,f.cache);assert.equal(result.identity,expected);assert.equal(result.selfContained,false);assert.equal(result.fileCount,4);assert.equal((await readdir(dirname(result.executable))).length,4);
});
test('self-contained helpers require a sealed complete runtime and freeze every listed byte',async t=>{
	const f=await fixture(t);await assert.rejects(prepareCommandHost(f.source,f.cache),/SELF_CONTAINED_COMMAND_HOST_MANIFEST_REQUIRED/);
	const manifest=await sealCommandHost(f.source,'a'.repeat(40));await assert.rejects(sealCommandHost(f.source,'a'.repeat(40)),/ALREADY_EXISTS/);
	const first=await prepareCommandHost(f.source,f.cache);assert.equal(first.selfContained,true);assert.equal(first.fileCount,manifest.files.length+1);
	for(const file of manifest.files)assert.equal(commandHash(await readFile(join(dirname(first.executable),file.name))),file.sha256);
	await writeFile(join(f.source,'runtime-extra.dll'),'new coherent build');const next=structuredClone(manifest),row=next.files.find(file=>file.name==='runtime-extra.dll');row.bytes=18;row.sha256=commandHash(Buffer.from('new coherent build'));await writeFile(join(f.source,commandManifestName),JSON.stringify(next));
	const second=await prepareCommandHost(f.source,f.cache);assert.notEqual(first.identity,second.identity);assert.equal((await readFile(join(dirname(first.executable),'runtime-extra.dll'),'utf8')),'runtime-extra.dll fixture');
});
test('missing, replaced, added or corrupt cached runtime files cannot silently launch a partial cohort',async t=>{
	const f=await fixture(t),manifest=await sealCommandHost(f.source,'a'.repeat(40));const ready=await prepareCommandHost(f.source,f.cache);
	await writeFile(join(dirname(ready.executable),'hostpolicy.dll'),'changed cached runtime');await assert.rejects(prepareCommandHost(f.source,f.cache),/COHORT_(CHANGED|INVALID)/);
	const other=await fixture(t);await sealCommandHost(other.source,'a'.repeat(40));await writeFile(join(other.source,'not-listed.dll'),'extra');await assert.rejects(prepareCommandHost(other.source,other.cache),/COHORT_CHANGED/);
	const missing=await fixture(t);await sealCommandHost(missing.source,'a'.repeat(40));await rm(join(missing.source,'coreclr.dll'));await assert.rejects(prepareCommandHost(missing.source,missing.cache),/COHORT_CHANGED/);
	assert.ok(manifest.files.length>4);
});
test('manifest paths, duplicate Windows names, unsafe runtime mode and missing dependencies are rejected',async t=>{
	const f=await fixture(t),original=await sealCommandHost(f.source,'a'.repeat(40));
	for(const bad of ['../outside.dll','C:\\outside.dll','name:stream','NUL.dll','dir/file.dll']){const value=structuredClone(original);value.files[0].name=bad;await writeFile(join(f.source,commandManifestName),JSON.stringify(value));await assert.rejects(prepareCommandHost(f.source,f.cache),/COHORT_INVALID/);}
	for(const change of [value=>value.files.push({...value.files[0],name:value.files[0].name.toLowerCase()}),value=>{value.selfContained=false;},value=>{value.files=value.files.filter(file=>file.name!=='hostfxr.dll');},value=>{value.files[0].bytes=129*1024*1024;}]){const value=structuredClone(original);change(value);await writeFile(join(f.source,commandManifestName),JSON.stringify(value));await assert.rejects(prepareCommandHost(f.source,f.cache),/COHORT_INVALID/);}
});
test('reparse-point directories and unexpected cache payloads cannot widen a sealed cohort',async t=>{
	const f=await fixture(t);await sealCommandHost(f.source,'a'.repeat(40));const ready=await prepareCommandHost(f.source,f.cache);await writeFile(join(dirname(ready.executable),'surprise.dll'),'extra');await assert.rejects(prepareCommandHost(f.source,f.cache),/COHORT_CHANGED/);
	const linked=await fixture(t);const target=join(linked.root,'outside');await mkdir(target);await symlink(target,join(linked.source,'linked'),process.platform==='win32'?'junction':'dir');await assert.rejects(sealCommandHost(linked.source,'a'.repeat(40)),/COHORT_INVALID/);
});
