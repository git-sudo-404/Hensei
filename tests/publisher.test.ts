import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Publisher,command,type Command} from '../src/publisher';
import {WorktreeManager} from '../src/worktrees';
import type {Task,TaskPlan} from '../src/planner';
import {contentVersion} from '../src/inventory';
import {Evaluator} from '../src/evaluator';
import {Journal} from '../src/journal';
const git=(cwd:string,args:string[])=>command(['git','-c','user.name=Test','-c','user.email=test@localhost','-c','commit.gpgsign=false',...args],cwd);
async function fixture(run:(root:string,bare:string,source:string,transport:Command,prs:any[],created:string[])=>Promise<void>,options:{empty?:boolean;missing?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'hensei-publish-')),bare=join(root,'remote.git'),source=join(root,'source'),merger=join(root,'merger');
 try {
  await mkdir(source);await git(source,['init','-b','main']);await Bun.write(join(source,'original.ts'),'export const old=1;');await git(source,['add','.']);await git(source,['commit','-m','Source baseline']);if(options.empty)await git(root,['init','--bare','-b','main',bare]);else await git(root,['clone','--bare',source,bare]);await git(root,['clone',bare,merger]);const prs:any[]=[],created:string[]=[];let exists=!options.missing;
  const transport:Command=async(args,cwd)=>{
   if(args[0]==='git'){
    if(args.includes('get-url'))return 'https://github.com/me/project.git';
    return command(args.map(a=>a==='https://github.com/me/project.git'?bare:a),cwd);
   }
   const a=args.slice(1);
   if(a[0]==='repo'&&a[1]==='view'){if(!exists)throw new Error('Repository missing');return JSON.stringify({isEmpty:!(await git(bare,['for-each-ref','refs/heads'])),defaultBranchRef:{name:'main'}});}
   if(a[0]==='repo'&&a[1]==='create'){exists=true;created.push(a[2]);expect(a).toContain('--private');return '';}
   if(a[0]==='pr'&&a[1]==='list'){const head=a[a.indexOf('--head')+1];return JSON.stringify(prs.filter(p=>p.head===head).map(p=>({url:p.url})));}
   if(a[0]==='pr'&&a[1]==='create'){const head=a[a.indexOf('--head')+1],base=a[a.indexOf('--base')+1];const sha=await git(bare,['rev-parse',head]);const p={url:`https://github.com/me/project/pull/${prs.length+1}`,head,base,sha,state:'OPEN'};prs.push(p);return p.url;}
   if(a[0]==='pr'&&a[1]==='view'){const p=prs.find(p=>p.url===a[2]);return JSON.stringify({state:p.state,baseRefName:p.base,headRefOid:p.sha,mergeCommit:p.merge?{oid:p.merge}:null});}
   if(a[0]==='pr'&&a[1]==='merge'){const p=prs.find(p=>p.url===a[2]);expect(a[a.indexOf('--match-head-commit')+1]).toBe(p.sha);await git(merger,['fetch','origin']);await git(merger,['checkout','--detach',`origin/${p.base}`]);await git(merger,['merge','--no-ff','--no-edit',`origin/${p.head}`]);p.merge=await git(merger,['rev-parse','HEAD']);await git(merger,['push','origin',`HEAD:refs/heads/${p.base}`]);p.state='MERGED';return '';}
   throw new Error('Unexpected command '+args.join(' '));
  };
  await run(root,bare,source,transport,prs,created);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('source-mode publication creates and merges an exact checked PR while preserving original main',async()=>fixture(async(root,bare,source,transport,prs)=>{
 const runDir=join(root,'run');await mkdir(runDir);const publisher=new Publisher(runDir,source,{mode:'source',migrationBranch:'hensei/test'},transport);
 await publisher.initialize();const baseline=await git(bare,['rev-parse','main']);const manager=new WorktreeManager(runDir);await manager.initialize();const task:Task={id:'task_a',groupId:'g',layer:0,goal:'x',prompt:'x',files:[{path:'old.js',version:contentVersion('x')}],outputPaths:['converted.ts'],dependsOn:[]};
 const checkout=await manager.create(task,[]),candidate=await manager.submit(checkout,{taskId:task.id,summary:'Converted source',files:[{path:'converted.ts',content:'export const value=7;',sourcePaths:['old.js']}]});let publication:any;
 await manager.integrate(candidate,async()=>{},async(commit,path)=>{publication=await publisher.publish(commit,path,[candidate],{approved:true,reasons:['Review']},[0,1].map(()=>({command:['fixture'],passed:true,exitCode:0,timedOut:false,output:''})),manager.repo);});
 expect(prs.length).toBe(1);expect(prs[0].state).toBe('MERGED');expect(publication.baseBranch).toBe('hensei/test');expect(await git(bare,['rev-parse','main'])).toBe(baseline);expect(await git(bare,['show','hensei/test:migration/converted.ts'])).toBe('export const value=7;');expect(await git(bare,['show','hensei/test:original.ts'])).toContain('old=1');
 await publisher.audit(await manager.tree());const recovered=await publisher.recover(publication.checkedCommit);expect(recovered?.url).toBe(publication.url);
 const equivalent=await git(manager.repo,['commit-tree',await manager.tree(),'-p',publication.checkedCommit,'-m','Equivalent re-evaluation']);
 const reused=await publisher.publish(equivalent,manager.repo,[candidate],{approved:true,reasons:['Review']},[0,1].map(()=>({command:['fixture'],passed:true,exitCode:0,timedOut:false,output:''})),manager.repo);
 expect(reused.checkedCommit).toBe(equivalent);expect((await publisher.recover(equivalent))?.checkedCommit).toBe(equivalent);expect(prs.length).toBe(1);
}));
test('new mode uses configured target repo and does not create one without create:true',async()=>fixture(async(root,_bare,source,transport,_prs,created)=>{
 const runDir=join(root,'run-new');await mkdir(runDir);const publisher=new Publisher(runDir,source,{mode:'new',url:'me/project',migrationBranch:'hensei/new',outputDirectory:'converted'},transport);await publisher.initialize();expect(created.length).toBe(0);expect(publisher.summary().repository).toBe('https://github.com/me/project');
}));
test('existing output paths and source-origin mismatches fail before publishing',async()=>fixture(async(root,_bare,source,transport,prs)=>{
 const runDir=join(root,'run-unsafe');await mkdir(runDir);
 await expect(new Publisher(runDir,source,{mode:'source',url:'other/project'},transport).initialize()).rejects.toThrow('differs');expect(prs.length).toBe(0);
  await expect(new Publisher(runDir,source,{mode:'source',outputDirectory:'original.ts'},transport).initialize()).rejects.toThrow('not empty');expect(prs.length).toBe(0);
 await expect(new Publisher(runDir,source,{mode:'source',outputDirectory:'original.ts/nested'},transport).initialize()).rejects.toThrow('ancestor');expect(prs.length).toBe(0);
}));
test('create:true initializes a private empty repository and keeps migration on a separate branch',async()=>fixture(async(root,bare,source,transport,_prs,created)=>{
 const runDir=join(root,'run-created');await mkdir(runDir);const config={mode:'new' as const,url:'me/project',create:true,migrationBranch:'hensei/new'};
 const publisher=new Publisher(runDir,source,config,transport);await publisher.initialize();expect(created).toEqual(['me/project']);expect(await git(bare,['rev-parse','main'])).toBe(await git(bare,['rev-parse','hensei/new']));expect(publisher.summary().outputDirectory).toBe('.');
 await new Publisher(runDir,source,config,transport).initialize();expect(created.length).toBe(1);
}, {empty:true,missing:true}));
test('empty-repository initialization retries a failed first push before its state checkpoint',async()=>fixture(async(root,bare,source,transport)=>{
 const runDir=join(root,'run-init-retry');await mkdir(runDir);const config={mode:'new' as const,url:'me/project',migrationBranch:'hensei/init-retry'};let fail=true;
 const interrupted:Command=(args,cwd)=>{if(fail&&args[0]==='git'&&args.includes('push')){fail=false;return Promise.reject(new Error('Interrupted initial push'));}return transport(args,cwd);};
 await expect(new Publisher(runDir,source,config,interrupted).initialize()).rejects.toThrow('Interrupted');expect(await Bun.file(join(runDir,'publication','state.json')).exists()).toBe(false);
 await new Publisher(runDir,source,config,interrupted).initialize();expect(await git(bare,['rev-parse','main'])).toBe(await git(bare,['rev-parse','hensei/init-retry']));
}, {empty:true}));
test('a merged remote PR recovers after a crash before local promotion',async()=>fixture(async(root,bare,source,transport,prs)=>{
 const runDir=join(root,'run-crash');await mkdir(runDir);const publisher=new Publisher(runDir,source,{mode:'source',migrationBranch:'hensei/crash'},transport);await publisher.initialize();const manager=new WorktreeManager(runDir);await manager.initialize();const before=await manager.head();
 const task:Task={id:'task_crash',groupId:'g',layer:0,goal:'x',prompt:'x',files:[{path:'old.js',version:contentVersion('x')}],outputPaths:['converted.ts'],dependsOn:[]};
 const checkout=await manager.create(task,[]),candidate=await manager.submit(checkout,{taskId:task.id,summary:'Converted',files:[{path:'converted.ts',content:'export const value=8;',sourcePaths:['old.js']}]});let checked='';
 await expect(manager.integrate(candidate,async()=>{},async(commit,path)=>{checked=commit;await publisher.publish(commit,path,[candidate],{approved:true,reasons:['Review']},[0,1].map(()=>({command:['fixture'],passed:true,exitCode:0,timedOut:false,output:''})),manager.repo);throw new Error('Simulated crash');})).rejects.toThrow('Simulated crash');
 expect(await manager.head()).toBe(before);expect(prs[0].state).toBe('MERGED');expect(await git(bare,['show','hensei/crash:migration/converted.ts'])).toContain('value=8');expect((await publisher.recover(checked))?.checkedCommit).toBe(checked);
 await manager.promoteEvaluated(checked);await publisher.audit(await manager.tree());
}));
test('merge refusal does not promote local code or report an open PR as accepted',async()=>fixture(async(root,bare,source,transport,prs)=>{
 const runDir=join(root,'run-protected');await mkdir(runDir);const guarded:Command=(args,cwd)=>args[0]==='gh'&&args[1]==='pr'&&args[2]==='merge'?Promise.reject(new Error('Branch protection rejected merge')):transport(args,cwd);
 const publisher=new Publisher(runDir,source,{mode:'source',migrationBranch:'hensei/protected'},guarded);await publisher.initialize();const manager=new WorktreeManager(runDir);await manager.initialize();const before=await manager.head(),remoteBefore=await git(bare,['rev-parse','hensei/protected']);
 const task:Task={id:'task_protected',groupId:'g',layer:0,goal:'x',prompt:'x',files:[{path:'old.js',version:contentVersion('x')}],outputPaths:['converted.ts'],dependsOn:[]};const checkout=await manager.create(task,[]),candidate=await manager.submit(checkout,{taskId:task.id,summary:'Converted',files:[{path:'converted.ts',content:'export const value=9;',sourcePaths:['old.js']}]});let checked='';
 await expect(manager.integrate(candidate,async()=>{},async(commit,path)=>{checked=commit;await publisher.publish(commit,path,[candidate],{approved:true,reasons:['Review']},[0,1].map(()=>({command:['fixture'],passed:true,exitCode:0,timedOut:false,output:''})),manager.repo);})).rejects.toThrow('protection');
 expect(await manager.head()).toBe(before);expect(await git(bare,['rev-parse','hensei/protected'])).toBe(remoteBefore);expect(prs[0].state).toBe('OPEN');expect(await publisher.recover(checked)).toBeUndefined();
}));
test('evaluator recovers remote merge, local promotion, journal acceptance and file versions from its receipt',async()=>fixture(async(root,_bare,source,transport,prs)=>{
 class CrashPublisher extends Publisher {async publish(...args:Parameters<Publisher['publish']>):ReturnType<Publisher['publish']>{await super.publish(...args);throw new Error('Crash after remote merge');}}
 const runDir=join(root,'run-receipt');await mkdir(runDir);const publisher=new CrashPublisher(runDir,source,{mode:'source',migrationBranch:'hensei/receipt'},transport);await publisher.initialize();const manager=new WorktreeManager(runDir);await manager.initialize();const before=await manager.head();
 const task:Task={id:'task_receipt',groupId:'g',layer:0,goal:'Translate',prompt:'Translate',files:[{path:'original.ts',version:contentVersion(await Bun.file(join(source,'original.ts')).bytes())}],outputPaths:['converted.ts'],dependsOn:[]};
 const plan:TaskPlan={schemaVersion:1,sourceRoot:source,targetLanguage:'TypeScript',model:'fixture',createdAt:'fixture',graphVersion:'fixture',warnings:[],tasks:[task]};
 const journal=new Journal(runDir);try{
  journal.add([task]);await mkdir(join(runDir,'tasks',task.id),{recursive:true});const checkout=await manager.create(task,[]),candidate=await manager.submit(checkout,{taskId:task.id,summary:'Converted',files:[{path:'converted.ts',content:'export const old=1;',sourcePaths:['original.ts']}]});
  const evaluator=new Evaluator(plan,runDir,{build:[process.execPath,'-e','await import("./converted.ts")'],test:[process.execPath,'-e','const m=await import("./converted.ts");if(m.old!==1)throw new Error("Wrong behavior")'],maxAttempts:2,timeoutSeconds:30},async()=>({content:'{"approved":true,"reasons":["Fixture review"]}'}),manager,journal,undefined,publisher);
  const result=await evaluator.evaluate(task,candidate,1);expect(result.approved).toBe(false);expect(await manager.head()).toBe(before);expect(journal.accepted().length).toBe(0);expect(prs[0].state).toBe('MERGED');
  const receipt=await Bun.file(join(runDir,'integration-receipts',task.id+'.json')).json();expect(receipt.publicationRequired).toBe(true);expect(receipt.publication).toBeUndefined();
  await evaluator.recover();expect(journal.statuses()[task.id]).toBe('SUCCEEDED');expect(await manager.head()).toBe(receipt.commit);const versions=await Bun.file(join(runDir,'file-versions.json')).json();expect(versions.files['converted.ts'].commit).toBe(receipt.commit);expect(versions.files['converted.ts'].version).toBe(contentVersion('export const old=1;'));
  await evaluator.recover();expect(journal.accepted().length).toBe(1);expect(prs.length).toBe(1);
 }finally{journal.close();}
}));
