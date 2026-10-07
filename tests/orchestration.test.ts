import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {executeTasks} from '../src/execution';
import {contentVersion} from '../src/inventory';
import type {TaskPlan,Complete} from '../src/planner';
const approve:Complete=async()=>({content:'{"approved":true,"reasons":["Scripted fixture review"]}'});
async function setup(run:(source:string,dest:string,plan:TaskPlan)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'hensei-audit-')),source=join(root,'src'),dest=join(root,'dest');
  try {
    await mkdir(source);await mkdir(dest);const content='export function value(){return 7;}';await Bun.write(join(source,'value.ts'),content);
    const plan:TaskPlan={schemaVersion:1,sourceRoot:source,targetLanguage:'TypeScript',model:'test',createdAt:'test',graphVersion:'test',warnings:[],tasks:[{id:'task_0001',groupId:'g',layer:0,goal:'Migrate value',prompt:'Preserve behavior',dependsOn:[],outputPaths:['value.ts'],steps:['Translate behavior'],files:[{path:'value.ts',version:contentVersion(content)}]}]};
    await Bun.write(join(dest,'tasks.json'),JSON.stringify(plan));
    await Bun.write(join(dest,'hensei.yaml'),JSON.stringify({target:{language:'TypeScript'},agents:{workers:2},evaluation:{build:[process.execPath,'-e','const f=[...new Bun.Glob("**/*.ts").scanSync(".")];const r=await Bun.build({entrypoints:f.map(p=>"./"+p),target:"bun"});if(!r.success)process.exit(1);'],test:[process.execPath,'--version'],timeoutSeconds:5},orchestration:{maxRounds:2}}));
    await run(source,dest,plan);
  }finally{await rm(root,{recursive:true,force:true});}
}
const worker:Complete=async(_s,user)=> {const c=JSON.parse(user.split('\n')[0]);return {content:JSON.stringify({taskId:c.task.id,summary:'candidate',files:c.task.files.map((f:{path:string})=>({path:f.path,content:f.path==='value.ts'?'export function value(){return 7;}':'export const missed=2;',sourcePaths:[f.path]}))})};};
const orchestrator:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]);return {content:JSON.stringify({goal:'Complete missing coverage',prompt:'Preserve behavior',outputPaths:c.fixedOutputPaths??[c.file.path],steps:['Translate interfaces','Check behavior']})};};
test('audit discovers unplanned files, copies binary assets and excludes secrets explicitly',async()=>setup(async(source,dest)=>{
  await Bun.write(join(source,'missed.ts'),'export const missed=2;');const asset=new Uint8Array([0,255,1,2]);await Bun.write(join(source,'asset.bin'),asset);await Bun.write(join(source,'.env'),'NEVER_SEND=this');
  const config=await Bun.file(join(dest,'hensei.yaml')).json();config.evaluation.finalTest=[process.execPath,'-e','if(!await Bun.file("missed.ts").exists()||!await Bun.file("asset.bin").exists())process.exit(1);'];await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));
  const {report,runDir}=await executeTasks(dest,{complete:worker,evaluatorComplete:approve,orchestratorComplete:orchestrator});
  expect(report.finalAudit.complete).toBe(true);expect(report.finalAudit.coveragePercent).toBe(100);expect(report.finalAudit.totalFiles).toBe(3);expect(report.rounds).toBe(1);
  expect(report.finalAudit.excluded.some(e=>e.path==='.env')).toBe(true);
  expect(new Uint8Array(await Bun.file(join(runDir,'repo','asset.bin')).arrayBuffer())).toEqual(asset);
  expect((await Bun.file(join(runDir,'tasks.json')).json()).tasks.length).toBe(3);
}));
test('final suite failure creates a scoped repair task and only then marks completion',async()=>setup(async(_source,dest)=>{
  const config=await Bun.file(join(dest,'hensei.yaml')).json();config.evaluation.finalTest=[process.execPath,'-e','const {value}=await import("./value.ts");if(value()!==7)process.exit(1);'];await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));
  const complete:Complete=async(_s,user)=>{const c=JSON.parse(user.split('\n')[0]);return {content:JSON.stringify({taskId:c.task.id,summary:'candidate',files:[{path:'value.ts',content:`export function value(){return ${c.task.kind==='repair'?7:999};}`,sourcePaths:['value.ts']}]})};};
  const planner:Complete=async(s,u)=>s.includes('breakdown')?orchestrator(s,u):({content:'{"goal":"Fix value behavior","prompt":"Return exactly 7 without changing tests","sourcePaths":["value.ts"],"targetPaths":["value.ts"]}'});
  const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:approve,orchestratorComplete:planner});
  expect(report.finalAudit.complete).toBe(true);expect(report.rounds).toBe(1);expect((await Bun.file(join(runDir,'tasks.json')).json()).tasks[1].kind).toBe('repair');expect(await Bun.file(join(runDir,'repo','value.ts')).text()).toContain('return 7');
}));
test('resume skips accepted tasks and recovers journal from persisted integration receipts',async()=>setup(async(_source,dest)=>{
  const first=await executeTasks(dest,{complete:worker,evaluatorComplete:approve,orchestratorComplete:orchestrator});expect(first.report.finalAudit.complete).toBe(true);
  const {Database}=await import('bun:sqlite');const db=new Database(join(first.runDir,'state.sqlite'));db.exec("DELETE FROM integrations; UPDATE tasks SET status='RUNNING'");db.close();
  let calls=0;const unexpected:Complete=async()=>{calls++;throw new Error('Resume should not call model');};
  const resumed=await executeTasks(dest,{resume:basename(first.runDir),complete:unexpected,evaluatorComplete:unexpected,orchestratorComplete:unexpected});
  expect(calls).toBe(0);expect(resumed.report.finalAudit.complete).toBe(true);expect(resumed.runDir).toBe(first.runDir);
}));
test('unresolved failures stop at round limit with incomplete audit',async()=>setup(async(_source,dest)=>{
  const failed:Complete=async()=>{throw new Error('Provider unavailable');};
  const {report}=await executeTasks(dest,{complete:failed,evaluatorComplete:approve,orchestratorComplete:orchestrator});
  expect(report.finalAudit.complete).toBe(false);expect(report.rounds).toBe(2);expect(report.stopReason).toContain('limit');expect(report.finalAudit.missingFiles).toEqual(['value.ts']);
}));
test('source additions during a run invalidate coverage and stop automatic continuation',async()=>setup(async(source,dest)=>{
  const mutating:Complete=async(s,u)=>{await Bun.write(join(source,'new.ts'),'export const newFile=1;');return worker(s,u);};
  const {report}=await executeTasks(dest,{complete:mutating,evaluatorComplete:approve,orchestratorComplete:orchestrator});
  expect(report.finalAudit.complete).toBe(false);expect(report.finalAudit.sourceStable).toBe(false);expect(report.stopReason).toContain('Source changed');
}));
test('three repair returns terminate the old worker and a freshly decomposed task can finish',async()=>setup(async(_source,dest)=>{
 const config=await Bun.file(join(dest,'hensei.yaml')).json();config.agents.maxRetries=3;config.orchestration.maxRounds=1;await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));
 const attempts:Record<string,number>={};
 const complete:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]);attempts[c.task.id]=(attempts[c.task.id]??0)+1;return {content:JSON.stringify({taskId:c.task.id,summary:'Versioned candidate',files:[{path:'value.ts',content:`export function value(){return 7;} // attempt ${c.attempt}`,sourcePaths:['value.ts']}]})};};
 const evaluate:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]);return {content:JSON.stringify({approved:!!c.task.parentId,reasons:[c.task.parentId?'Replacement reviewed':'Fixture forces initial worker exhaustion']})};};
 const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:evaluate,orchestratorComplete:orchestrator});expect(report.finalAudit.complete).toBe(true);expect(attempts.task_0001).toBe(4);expect(report.events.filter(e=>e.type==='returned'&&e.taskId==='task_0001').length).toBe(3);
 const plan=await Bun.file(join(runDir,'tasks.json')).json(),replacement=plan.tasks[1];expect(replacement.parentId).toBe('task_0001');expect(replacement.files.length).toBe(1);expect(replacement.steps.length).toBeGreaterThan(1);
 const candidate=await Bun.file(join(runDir,'tasks',replacement.id,'candidate.json')).json();expect(candidate.branch).toBe(replacement.id);expect(candidate.branch).not.toBe('task_0001');expect(await Bun.file(join(runDir,'tasks','task_0001','candidate-4.json')).exists()).toBe(true);
}));
test('a large file is read and generated in pages without one oversized model response',async()=>setup(async(source,dest,plan)=>{
 const content='export function value(){return 7;}\n'+Array.from({length:1000},(_,i)=>`export function f${i}(){return ${i};}`).join('\n')+'\n';await Bun.write(join(source,'value.ts'),content);plan.tasks[0].files[0].version=contentVersion(content);await Bun.write(join(dest,'tasks.json'),JSON.stringify(plan));
 const config=await Bun.file(join(dest,'hensei.yaml')).json();config.runtime={maxInputBytes:32000,maxTurns:20};config.orchestration.maxRounds=0;await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));
 let read=0,written=0,calls=0;
 const complete:Complete=async(_s,u)=>{calls++;expect(Buffer.byteLength(u)).toBeLessThan(32000);if(read<content.length){const offset=read;read=Math.min(content.length,read+12000);return {content:JSON.stringify({action:'read_source',path:'value.ts',offset,length:read-offset}),inputTokens:1,outputTokens:1};}if(written<content.length){const offset=written;written=Math.min(content.length,written+12000);return {content:JSON.stringify({action:'write_target',path:'value.ts',offset,content:content.slice(offset,written)}),inputTokens:1,outputTokens:1};}return {content:JSON.stringify({taskId:'task_0001',summary:'Chunked implementation',files:[{path:'value.ts',sourcePaths:['value.ts']}]}),inputTokens:1,outputTokens:1};};
 let reviewOffset=0,reviewTarget=0;const review:Complete=async(_s,u)=>{if(reviewOffset<content.length){const offset=reviewOffset;reviewOffset=Math.min(content.length,reviewOffset+12000);return {content:JSON.stringify({action:'read_source',path:'value.ts',offset,length:reviewOffset-offset}),inputTokens:1,outputTokens:1};}if(reviewTarget<content.length){const offset=reviewTarget;reviewTarget=Math.min(content.length,reviewTarget+12000);return {content:JSON.stringify({action:'read_target',path:'value.ts',offset,length:reviewTarget-offset}),inputTokens:1,outputTokens:1};}return {content:'{"approved":true,"reasons":["Fixture paged review"]}',inputTokens:1,outputTokens:1};};
 const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:review});expect(report.finalAudit.complete).toBe(true);expect(calls).toBeGreaterThan(4);expect(await Bun.file(join(runDir,'repo','value.ts')).text()).toBe(content);
}));
test('resume recovers an orphan task worktree and missing JSON checkpoint from SQLite',async()=>setup(async(source,dest,plan)=>{
 const {Journal}=await import('../src/journal'),{WorktreeManager}=await import('../src/worktrees'),{inventory}=await import('../src/inventory'),{loadConfig}=await import('../src/config');
 const runDir=join(dest,'.hensei','runs','orphan');await mkdir(runDir,{recursive:true});const journal=new Journal(runDir);journal.initialize(plan,await inventory(source),await loadConfig(dest));journal.status('task_0001','RUNNING');journal.set('attempts',{task_0001:1});journal.close();
 const manager=new WorktreeManager(runDir);await manager.initialize();const checkout=await manager.create(plan.tasks[0],[]);await Bun.write(join(checkout.path,'value.ts'),'unfinished work before crash');
 const {report}=await executeTasks(dest,{resume:'orphan',complete:worker,evaluatorComplete:approve,orchestratorComplete:orchestrator});expect(report.finalAudit.complete).toBe(true);expect(await Bun.file(join(runDir,'repo','value.ts')).text()).toContain('return 7');
}));
test('resume never resets exhausted worker repair attempts',async()=>setup(async(source,dest,plan)=>{
 const {Journal}=await import('../src/journal'),{WorktreeManager}=await import('../src/worktrees'),{inventory}=await import('../src/inventory'),{loadConfig}=await import('../src/config');
 const config=await Bun.file(join(dest,'hensei.yaml')).json();config.orchestration.maxRounds=0;await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));const runDir=join(dest,'.hensei','runs','exhausted');await mkdir(runDir,{recursive:true});const journal=new Journal(runDir);journal.initialize(plan,await inventory(source),await loadConfig(dest));journal.status('task_0001','RUNNING');journal.set('attempts',{task_0001:4});journal.close();const manager=new WorktreeManager(runDir);await manager.initialize();let calls=0;
 const unexpected:Complete=async()=>{calls++;throw new Error('Exhausted identity must not run');};const {report}=await executeTasks(dest,{resume:'exhausted',complete:unexpected,evaluatorComplete:unexpected});expect(calls).toBe(0);expect(report.statuses.task_0001).toBe('FAILED');expect(report.finalAudit.complete).toBe(false);
}));
