import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const commandHostFiles=['CommandDeck.CommandHost.exe','CommandDeck.CommandHost.dll','CommandDeck.CommandHost.deps.json','CommandDeck.CommandHost.runtimeconfig.json'];
export const commandManifestName='command-host-cohort.json';
const runtimeFiles=['hostfxr.dll','hostpolicy.dll','coreclr.dll','System.Private.CoreLib.dll'];
const maximumFiles=2048,maximumFileBytes=128*1024*1024,maximumTotalBytes=512*1024*1024,maximumManifestBytes=1024*1024;
export const commandHash=value=>createHash('sha256').update(value).digest('hex');
const invalid=()=>new Error('COMMAND_HOST_COHORT_INVALID');
function safeName(name){return typeof name==='string'&&name.length<=180&&/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(name)&&!/[. ]$/.test(name)&&!name.includes('..')&&!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);}
export async function commandFile(directory,name,limit=maximumFileBytes){
	if(!safeName(name))throw invalid();
	const path=join(directory,name),info=await lstat(path);
	if(!info.isFile()||info.isSymbolicLink()||info.size>limit)throw invalid();
	const bytes=await readFile(path);if(bytes.length>limit)throw invalid();return bytes;
}
export async function commandMembership(directory){
	const entries=await readdir(directory,{withFileTypes:true});
	if(entries.length>maximumFiles+1||entries.some(value=>!value.isFile()||value.isSymbolicLink()||!safeName(value.name)))throw invalid();
	const names=entries.map(value=>value.name).sort();
	if(new Set(names.map(value=>value.toLowerCase())).size!==names.length)throw invalid();
	return names;
}
function selfContained(bytes){
	let options;try{options=JSON.parse(bytes.toString('utf8')).runtimeOptions;}catch{throw invalid();}
	if(!options||typeof options!=='object')throw invalid();
	if(options.includedFrameworks!==undefined){
		if(!Array.isArray(options.includedFrameworks)||!options.includedFrameworks.length||options.framework||options.frameworks)throw invalid();
		return true;
	}
	return false;
}
function validateManifest(value){
	if(!value||value.version!==1||value.kind!=='command-host'||value.runtimeIdentifier!=='win-x64'||typeof value.selfContained!=='boolean'||!/^([a-f0-9]{40})$/.test(value.sourceRevision??'')||!Array.isArray(value.files)||value.files.length<4||value.files.length>maximumFiles)throw invalid();
	const names=new Set();let total=0;
	for(const file of value.files){
		if(!file||!safeName(file.name)||file.name.toLowerCase()===commandManifestName||names.has(file.name.toLowerCase())||!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>maximumFileBytes||!/^[a-f0-9]{64}$/.test(file.sha256??''))throw invalid();
		names.add(file.name.toLowerCase());total+=file.bytes;
	}
	if(total>maximumTotalBytes||[...commandHostFiles,...(value.selfContained?runtimeFiles:[])].some(name=>!names.has(name.toLowerCase())))throw invalid();
	return value;
}
export async function readCommandCohort(source){
	const required=await Promise.all(commandHostFiles.map(name=>commandFile(source,name)));
	const standalone=selfContained(required[3]);let manifestBytes;
	if(standalone){let deps;try{deps=JSON.parse(required[2].toString('utf8'));}catch{throw invalid();}if(typeof deps?.runtimeTarget?.name!=='string'||!deps.runtimeTarget.name.endsWith('/win-x64'))throw invalid();}
	try{manifestBytes=await commandFile(source,commandManifestName,maximumManifestBytes);}catch(error){if(error.code!=='ENOENT')throw error;}
	if(!manifestBytes){
		if(standalone)throw new Error('SELF_CONTAINED_COMMAND_HOST_MANIFEST_REQUIRED');
		return {identity:commandHash(Buffer.concat(required)),selfContained:false,files:commandHostFiles.map((name,index)=>({name,bytes:required[index].length,sha256:commandHash(required[index])})),manifestBytes:null};
	}
	let manifest;try{manifest=validateManifest(JSON.parse(manifestBytes.toString('utf8')));}catch{throw invalid();}
	if(manifest.selfContained!==standalone)throw invalid();
	const actual=await commandMembership(source),expected=[...manifest.files.map(file=>file.name),commandManifestName].sort();
	if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('COMMAND_HOST_COHORT_CHANGED');
	for(const [index,name]of commandHostFiles.entries()){
		const file=manifest.files.find(file=>file.name===name);if(!file||file.bytes!==required[index].length||file.sha256!==commandHash(required[index]))throw new Error('COMMAND_HOST_COHORT_CHANGED');
	}
	return {identity:commandHash(Buffer.concat([Buffer.from('command-host-cohort-v1\0'),manifestBytes])),selfContained:standalone,files:manifest.files,manifestBytes};
}

// A build stamp is metadata, not an author signature or permission to execute.
export async function sealCommandHost(source,sourceRevision,build={}){
	if(!/^[a-f0-9]{40}$/.test(sourceRevision))throw invalid();
	if(Object.keys(build).some(key=>key!=='sdkVersion')||build.sdkVersion!==undefined&&!/^[0-9][0-9A-Za-z.+-]{0,79}$/.test(build.sdkVersion))throw invalid();
	const names=await commandMembership(source);if(names.includes(commandManifestName))throw new Error('COMMAND_HOST_MANIFEST_ALREADY_EXISTS');
	const files=[];let total=0;
	for(const name of names){const bytes=await commandFile(source,name);total+=bytes.length;if(total>maximumTotalBytes)throw invalid();files.push({name,bytes:bytes.length,sha256:commandHash(bytes)});}
	const config=await commandFile(source,commandHostFiles[3]);
	if(selfContained(config)){let deps;try{deps=JSON.parse((await commandFile(source,commandHostFiles[2])).toString('utf8'));}catch{throw invalid();}if(typeof deps?.runtimeTarget?.name!=='string'||!deps.runtimeTarget.name.endsWith('/win-x64'))throw invalid();}
	const manifest=validateManifest({version:1,kind:'command-host',runtimeIdentifier:'win-x64',selfContained:selfContained(config),sourceRevision,...build,files});
	await writeFile(join(source,commandManifestName),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
	return manifest;
}
