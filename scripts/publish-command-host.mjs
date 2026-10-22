import {spawn} from 'node:child_process';
import {mkdir,realpath,lstat,access} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,delimiter,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readGit} from '../apps/desktop/workspace.mjs';
import {sealCommandHost} from '../apps/desktop/command-cohort.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
if(process.platform!=='win32'||args.length!==2||args[0]!=='--output')throw new Error('EXPLICIT_WINDOWS_PUBLISH_OUTPUT_REQUIRED');
const artifactRoot=resolve(root,'artifacts'),output=resolve(root,args[1]),name=relative(artifactRoot,output);
if(isAbsolute(name)||!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(name)||name.includes('..')||name.endsWith('.')||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))throw new Error('PUBLISH_OUTPUT_MUST_BE_NEW_ARTIFACT_DIRECTORY');
await mkdir(artifactRoot,{recursive:true});if((await realpath(artifactRoot)).toLowerCase()!==artifactRoot.toLowerCase())throw new Error('PUBLISH_ARTIFACT_ROOT_MUST_NOT_BE_REDIRECTED');
try{await lstat(output);throw new Error('PUBLISH_OUTPUT_ALREADY_EXISTS');}catch(error){if(error.code!=='ENOENT')throw error;}
const revision=(await readGit(root,['rev-parse','HEAD'])).trim();
if(!/^[a-f0-9]{40}$/.test(revision)||(await readGit(root,['status','--porcelain'])).trim())throw new Error('PUBLISH_REQUIRES_CLEAN_COMMITTED_SOURCE');
let dotnet;
const pathValue=Object.entries(process.env).find(([key])=>key.toLowerCase()==='path')?.[1]??'';
for(const directory of pathValue.split(delimiter)){
	if(!isAbsolute(directory))continue;
	try{const candidate=await realpath(join(directory,'dotnet.exe')),name=relative(root,candidate);if(!isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep))continue;await access(candidate);if((await lstat(candidate)).isFile()){dotnet=candidate;break;}}catch{}
}
if(!dotnet)throw new Error('DOTNET_SDK_REQUIRED_FOR_PUBLISH');
async function run(commandArgs,capture=false){return new Promise((resolve,reject)=>{const child=spawn(dotnet,commandArgs,{cwd:root,windowsHide:true,shell:false,stdio:capture?['ignore','pipe','pipe']:'inherit'});let text='';if(capture){child.stdout.on('data',bytes=>{text+=bytes;if(text.length>16384)child.kill();});child.stderr.on('data',()=>{});}child.once('error',()=>reject(new Error('NATIVE_PUBLISH_START_FAILED')));child.once('close',code=>code===0?resolve(text):reject(new Error('NATIVE_PUBLISH_FAILED')));});}
const sdkVersion=(await run(['--version'],true)).trim().split(/\r?\n/).at(-1);
await run(['publish','native/CommandDeck.CommandHost/CommandDeck.CommandHost.csproj','-c','Release','-f','net8.0-windows','-r','win-x64','--self-contained','true','-p:DebugType=None','-p:DebugSymbols=false','--nologo','-o',output]);
if((await readGit(root,['rev-parse','HEAD'])).trim()!==revision||(await readGit(root,['status','--porcelain'])).trim())throw new Error('PUBLISH_SOURCE_CHANGED');
const manifest=await sealCommandHost(output,revision,{sdkVersion});
if(!manifest.selfContained)throw new Error('SELF_CONTAINED_PUBLISH_REQUIRED');
console.log(JSON.stringify({published:true,selfContained:manifest.selfContained,runtimeIdentifier:manifest.runtimeIdentifier,sourceRevision:revision,sdkVersion,fileCount:manifest.files.length}));
