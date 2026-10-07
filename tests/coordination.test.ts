import {test,expect} from 'bun:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {executeTasks} from '../src/execution';
import {planTasks,type Complete,type TaskPlan} from '../src/planner';
import {contentVersion} from '../src/inventory';
import {validateCandidate} from '../src/worker';
import {validateTasks} from '../src/dispatcher';
const approve:Complete=async()=>({content:'{"approved":true,"reasons":["Fixture contract review"]}'});
async function cycleFixture(run:(source:string,dest:string,plan:TaskPlan)=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'hensei-cycle-')),source=join(root,'src'),dest=join(root,'dest');
 try {
  await mkdir(source);await mkdir(dest);
  const code={a:'import {b} from "./b.ts"; export function a():number{return b()+1;}',b:'import {c} from "./c.ts"; export function b():number{return c()+1;}',c:'import {a} from "./a.ts"; export function c():number{return typeof a==="function"?2:0;}'};
  const tasks=[];
  for(const [index,[name,content]]of Object.entries(code).entries()){await Bun.write(join(source,`${name}.ts`),content);tasks.push({id:`task_${index}`,groupId:'cycle',layer:0,goal:'Translate one module',prompt:'Preserve cyclic contracts',files:[{path:`${name}.ts`,version:contentVersion(content)}],outputPaths:[`${name}.ts`],semanticPeers:Object.keys(code).filter(n=>n!==name).map(n=>`${n}.ts`),steps:['Preserve interface','Implement behavior'],dependsOn:[]});}
  const plan:TaskPlan={schemaVersion:2,sourceRoot:source,targetLanguage:'TypeScript',model:'test',createdAt:'test',graphVersion:'test',warnings:[],tasks};
  await Bun.write(join(dest,'tasks.json'),JSON.stringify(plan));
  await Bun.write(join(dest,'hensei.yaml'),JSON.stringify({target:{language:'TypeScript'},agents:{workers:2,maxRetries:3},orchestration:{maxRounds:0},evaluation:{build:[process.execPath,'-e','const r=await Bun.build({entrypoints:["./a.ts"],target:"bun"});if(!r.success)process.exit(1);'],test:[process.execPath,'-e','const {a}=await import("./a.ts");if(a()!==4)process.exit(1)']}}));
  await run(source,dest,plan);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('three cycle files use two worker actors and merge only as a complete tested bundle',async()=>cycleFixture(async(_source,dest,plan)=>{
 let running=0,peak=0,calls=0,release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const complete:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]);running++;peak=Math.max(peak,running);calls++;if(calls===2)release();if(calls<=2)await gate;running--;const source=c.sources.find((f:{path:string})=>f.path===c.task.files[0].path);return {content:JSON.stringify({taskId:c.task.id,summary:'Preserve module',files:[{path:source.path,content:source.content,sourcePaths:[source.path]}]})};};
 const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:approve});
 expect(report.finalAudit.complete).toBe(true);expect(peak).toBe(2);expect(report.peakActiveWorkers).toBe(2);expect(report.events.every(e=>e.activeWorkers<=2)).toBe(true);
 const versions=await Bun.file(join(runDir,'file-versions.json')).json();expect(new Set(Object.values(versions.files).map((f:any)=>f.commit)).size).toBe(1);
 for(const task of plan.tasks){const review=await Bun.file(join(runDir,'tasks',task.id,'evaluation-1.json')).json();expect(review.bundle.length).toBe(3);expect(review.approved).toBe(true);}
}));
test('a rejected cycle never partially integrates',async()=>cycleFixture(async(_source,dest)=>{
 const complete:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]),path=c.task.files[0].path;return {content:JSON.stringify({taskId:c.task.id,summary:'Incomplete module',files:[{path,content:'export const wrong=0;',sourcePaths:[path]}]})};};
 const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:approve});expect(report.finalAudit.complete).toBe(false);expect(await Bun.file(join(runDir,'repo','a.ts')).exists()).toBe(false);expect(await Bun.file(join(runDir,'file-versions.json')).exists()).toBe(false);
}));
test('scope validation rejects fabricated target files and duplicate ownership before dispatch',async()=>cycleFixture(async(_s,_d,plan)=>{
 const task=plan.tasks[0];expect(()=>validateCandidate(JSON.stringify({taskId:task.id,summary:'x',files:[{path:'unrelated.ts',content:'export const x=1;',sourcePaths:['a.ts']}]}),task)).toThrow('scope');
 plan.tasks[1].outputPaths=['a.ts'];expect(()=>validateTasks(plan)).toThrow('target output');
}));
test('planner recursively decomposes a cyclic task into one-file leaves',async()=>cycleFixture(async(source,dest)=>{
 const graphPath=join(dest,'graph.json');await Bun.write(graphPath,JSON.stringify({nodes:['a','b','c'].map(n=>({id:n,source_file:`${n}.ts`})),edges:[{source:'a',target:'b',relation:'imports'},{source:'b',target:'c',relation:'imports'},{source:'c',target:'a',relation:'imports'}]}));let splits=0;
 const complete:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]);if(c.stage==='outline')return {content:'{"goal":"Migrate cycle","prompt":"Coordinate interfaces and behavior"}'};if(c.stage==='decompose'){splits++;return {content:JSON.stringify({subtasks:[{files:c.files.slice(0,1),goal:'First file',prompt:'Preserve interface'},{files:c.files.slice(1),goal:'Remaining files',prompt:'Coordinate peers'}]})};}return {content:JSON.stringify({id:c.id,files:c.files,goal:'One-file migration',prompt:'Preserve cycle contracts',outputPaths:[c.files[0].path],steps:['Implement interface','Validate behavior']})};};
 const plan=await planTasks({root:source,graphPath,target:'TypeScript',model:'test',output:join(dest,'planned.json'),complete});expect(splits).toBe(2);expect(plan.tasks.length).toBe(3);expect(plan.tasks.every(t=>t.files.length===1)).toBe(true);expect(new Set(plan.tasks.map(t=>t.groupId)).size).toBe(1);validateTasks(plan);
}));

test('cycle receipt recovers all task statuses atomically without model calls',async()=>cycleFixture(async(_source,dest)=>{
 const complete:Complete=async(_s,u)=>{const c=JSON.parse(u.split('\n')[0]),source=c.sources.find((f:{path:string})=>f.path===c.task.files[0].path);return {content:JSON.stringify({taskId:c.task.id,summary:'Module',files:[{path:source.path,content:source.content,sourcePaths:[source.path]}]})};};
 const first=await executeTasks(dest,{complete,evaluatorComplete:approve});expect(first.report.finalAudit.complete).toBe(true);
 const {Database}=await import('bun:sqlite');const db=new Database(join(first.runDir,'state.sqlite'));db.exec("DELETE FROM integrations;UPDATE tasks SET status='RUNNING'");db.close();
 let calls=0;const unexpected:Complete=async()=>{calls++;throw new Error('No model call expected');};const resumed=await executeTasks(dest,{resume:basename(first.runDir),complete:unexpected,evaluatorComplete:unexpected});expect(calls).toBe(0);expect(resumed.report.finalAudit.complete).toBe(true);expect(Object.values(resumed.report.statuses)).toEqual(['SUCCEEDED','SUCCEEDED','SUCCEEDED']);expect(resumed.report.peakActiveWorkers).toBe(2);
}));
