import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,realpath,rm,readdir} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir,devNull} from 'node:os';
import {Workbench} from '../apps/desktop/workbench.mjs';

function git(cwd,...args){return execFileSync('git',['-c',`core.hooksPath=${devNull}`,'-c','core.fsmonitor=false','-c','user.name=CommandDeck fixture','-c','user.email=fixture@invalid.example',...args],{cwd,windowsHide:true,encoding:'utf8',stdio:'pipe'}).trim();}
async function fixture(t){
	const base=await mkdtemp(join(tmpdir(),'commanddeck-history-')), repo=join(base,'source'), directory=join(base,'private');
	await mkdir(repo); git(repo,'init','-q'); await writeFile(join(repo,'code.mjs'),'export const value = 1;\n'); await writeFile(join(repo,'index.md'),'original evidence\n');
	git(repo,'add','--','code.mjs','index.md');git(repo,'commit','-qm','fixture baseline');
	const workbench=new Workbench({directory,helperSource:join(base,'unused-helper')}), instances=[workbench];
	await workbench.add({path:repo,label:'source',canWrite:true,canExecute:false}); const rootId=workbench.state().roots[0].id;
	t.after(async()=>{for(const w of instances)if(!w.closing)await w.close();const canonical=await realpath(base);assert.equal(dirname(canonical).toLowerCase(),(await realpath(tmpdir())).toLowerCase());assert.ok(basename(canonical).startsWith('commanddeck-history-'));await rm(canonical,{recursive:true,force:true});});
	return {base,repo,directory,workbench,rootId,instances};
}
async function edit(f,path='code.mjs',content='export const value = 2;\n'){
	let sha=null;try{sha=(await f.workbench.request('read',{rootId:f.rootId,path})).sha256;}catch(error){if(error.message!=='WORKSPACE_FILE_NOT_FOUND')throw error;}
	const task=await f.workbench.request('save',{rootId:f.rootId,path,expectedSha256:sha,content});await f.workbench.operation?.done;
	const result=await f.workbench.request('task',{taskId:task.id});assert.equal(result.state,'succeeded');return result;
}

test('original task diff survives commit, later disk edits and a complete workbench restart without replay',async t=>{
	const f=await fixture(t), task=await edit(f), args={taskId:task.id,changeId:task.changes[0].id};
	git(f.repo,'add','--','code.mjs');git(f.repo,'commit','-qm','apply real edit');
	assert.equal((await f.workbench.request('diff',{rootId:f.rootId,path:'code.mjs'})).text,'');
	const first=await f.workbench.request('change-diff',args);
	assert.match(first.text,/-export const value = 1;/);assert.match(first.text,/\+export const value = 2;/);assert.ok(!first.text.includes(f.base));
	await writeFile(join(f.repo,'code.mjs'),'later external edit\n');assert.deepEqual(await f.workbench.request('change-diff',args),first);
	await f.workbench.close();const reopened=new Workbench({directory:f.directory,helperSource:join(f.base,'unused-helper')});f.instances.push(reopened);
	assert.deepEqual(await reopened.request('change-diff',args),first);assert.equal((await reopened.request('task',{taskId:task.id})).invocations.length,0);
	assert.equal(await readFile(join(f.repo,'code.mjs'),'utf8'),'later external edit\n');assert.deepEqual(await readdir(join(f.directory,'history')),[]);
});
test('created-file diff remains readable after an explicit revert, and failed or corrupt history refuses',async t=>{
	const f=await fixture(t), task=await edit(f,'created.md','new source\n'), args={taskId:task.id,changeId:task.changes[0].id};
	const first=await f.workbench.request('change-diff',args);assert.match(first.text,/^--- \/dev\/null/m);
	await f.workbench.request('revert',{sourceTaskId:task.id,changeId:task.changes[0].id});await f.workbench.operation?.done;
	const reverted=await f.workbench.request('change-diff',args);assert.equal(reverted.text,first.text);assert.equal(reverted.state,'reverted');
	await assert.rejects(f.workbench.request('change-diff',{taskId:task.id,changeId:'another-change'}),/TASK_CHANGE_NOT_FOUND/);
	f.workbench.store.db.prepare('UPDATE changes SET after_text=? WHERE id=?').run('tampered',args.changeId);
	await assert.rejects(f.workbench.request('change-diff',args),/TASK_CHANGE_HISTORY_CORRUPT/);
	f.workbench.store.db.prepare("UPDATE changes SET state='unknown' WHERE id=?").run(args.changeId);
	await assert.rejects(f.workbench.request('change-diff',args),/TASK_CHANGE_NOT_VERIFIED/);
});
test('creating an empty file is retained as a real file addition',async t=>{
	const f=await fixture(t), task=await edit(f,'empty.md','');
	const diff=await f.workbench.request('change-diff',{taskId:task.id,changeId:task.changes[0].id});
	assert.match(diff.text,/new file mode 100644/);assert.equal(diff.beforeHash,null);assert.ok(diff.text.includes('empty.md'));
});
test('a cross-repository reference is pinned to the committed blob, persists and never follows later working files',async t=>{
	const f=await fixture(t), task=await edit(f), lab=join(f.base,'lab');await mkdir(lab);git(lab,'init','-q');await writeFile(join(lab,'acceptance.md'),'original Lab result\n');git(lab,'add','--','acceptance.md');git(lab,'commit','-qm','Lab baseline');
	await f.workbench.add({path:lab,label:'Lab',canWrite:false,canExecute:false});const root=f.workbench.state().roots.find(r=>r.label==='Lab');
	await writeFile(join(lab,'acceptance.md'),'uncommitted different text\n');
	const args={taskId:task.id,rootId:root.id,path:'acceptance.md',revision:root.metadata.sha,label:'Lab acceptance index'};
	const reference=await f.workbench.request('attach-reference',args);assert.equal((await f.workbench.request('attach-reference',args)).id,reference.id);assert.equal((await f.workbench.request('task',{taskId:task.id})).references.length,1);
	const readArgs={taskId:task.id,referenceId:reference.id}, first=await f.workbench.request('read-reference',readArgs);assert.equal(first.fullText,'original Lab result\n');
	git(lab,'add','--','acceptance.md');git(lab,'commit','-qm','later evidence');assert.equal((await f.workbench.request('read-reference',readArgs)).fullText,first.fullText);
	await assert.rejects(f.workbench.request('attach-reference',{...args,path:'.env'}),/REFERENCE_REVISION_CHANGED/);
	await f.workbench.close();const reopened=new Workbench({directory:f.directory,helperSource:join(f.base,'unused-helper')});f.instances.push(reopened);
	assert.equal((await reopened.request('read-reference',readArgs)).sha256,reference.sha256);assert.equal(reopened.store.references(task.id).length,1);
	reopened.store.setRootGrants(root.id,{canWrite:false,canExecute:false,enabled:false});await assert.rejects(reopened.request('read-reference',readArgs),/WORKSPACE_ROOT_DISABLED/);
});
test('history and revision reads do not execute configured diff or filter programs',async t=>{
	const f=await fixture(t), task=await edit(f), marker=join(f.base,'unexpected-execution'), script=join(f.base,'unsafe-filter.cjs');
	await writeFile(script,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'BAD');`);
	const command=`"${process.execPath}" "${script}"`;
	git(f.repo,'config','diff.external',command);git(f.repo,'config','diff.fixture.textconv',command);git(f.repo,'config','filter.fixture.clean',command);git(f.repo,'config','filter.fixture.smudge',command);
	await writeFile(join(f.repo,'.gitattributes'),'*.mjs diff=fixture filter=fixture\n*.md diff=fixture filter=fixture\n');
	await f.workbench.request('change-diff',{taskId:task.id,changeId:task.changes[0].id});
	const revision=git(f.repo,'rev-parse','HEAD');const ref=await f.workbench.request('attach-reference',{taskId:task.id,rootId:f.rootId,path:'index.md',revision,label:'fixed source'});
	assert.equal((await f.workbench.request('read-reference',{taskId:task.id,referenceId:ref.id})).fullText,'original evidence\n');await assert.rejects(readFile(marker),{code:'ENOENT'});
});
test('reference attachment cannot bypass game reservation, private paths, symlink blobs or blob size limits',async t=>{
	const f=await fixture(t), task=await edit(f);const args={taskId:task.id,rootId:f.rootId,path:'index.md',revision:git(f.repo,'rev-parse','HEAD'),label:'result'};
	f.workbench.gameWritesFrozen=false;await assert.rejects(f.workbench.request('attach-reference',args),/REFERENCE_ATTACHMENT_BUSY/);f.workbench.gameWritesFrozen=true;
	await assert.rejects(f.workbench.request('attach-reference',{...args,path:'.local/secret.md'}),/PRIVATE_WORKSPACE_PATH/);
	const link=execFileSync('git',['hash-object','-w','--stdin'],{cwd:f.repo,input:'../outside\n',encoding:'utf8',windowsHide:true}).trim();git(f.repo,'update-index','--add','--cacheinfo',`120000,${link},link.md`);
	await writeFile(join(f.repo,'large.md'),'x'.repeat(1024*1024+1));git(f.repo,'add','--','large.md');git(f.repo,'commit','-qm','bounded rejection fixtures');const revision=git(f.repo,'rev-parse','HEAD');
	await assert.rejects(f.workbench.request('attach-reference',{...args,revision,path:'link.md'}),/REFERENCE_REGULAR_TRACKED_FILE_REQUIRED/);
	await assert.rejects(f.workbench.request('attach-reference',{...args,revision,path:'large.md'}),/WORKSPACE_FILE_TOO_LARGE/);assert.equal(f.workbench.store.references(task.id).length,0);
});
