import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {executeTasks} from '../src/execution';
import {validateVerdict,runCheck} from '../src/evaluator';
import type {Complete,TaskPlan} from '../src/planner';
async function fixture(action:(dest:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'hensei-eval-')),dest=join(root,'dest');
  try {
    await mkdir(dest);const content='export function value(){return 7;}';await Bun.write(join(root,'value.ts'),content);
    const plan:TaskPlan={schemaVersion:1,sourceRoot:root,targetLanguage:'TypeScript',model:'test',createdAt:'test',graphVersion:'test',warnings:[],tasks:[{id:'task_0001',groupId:'g',layer:0,goal:'Preserve value()',prompt:'Translate value()',dependsOn:[],files:[{path:'value.ts',version:`sha256:${createHash('sha256').update(content).digest('hex')}`}]}]};
    await Bun.write(join(dest,'tasks.json'),JSON.stringify(plan));
    await Bun.write(join(dest,'hensei.yaml'),JSON.stringify({target:{language:'TypeScript'},agents:{workers:2},evaluation:{build:[process.execPath,'-e','await import("./value.ts")'],test:[process.execPath,'-e','const {value}=await import("./value.ts");if(value()!==7)process.exit(1)'],maxAttempts:2}}));
    await action(dest);
  }finally{await rm(root,{recursive:true,force:true});}
}
const review:Complete=async()=>({content:'{"approved":true,"reasons":["Fixture review"]}'});
const code=(value:number):Complete=>async()=>({content:JSON.stringify({taskId:'task_0001',summary:'candidate',files:[{path:'value.ts',content:`export function value(){return ${value};}`,sourcePaths:['value.ts']}]})});
test('real behavior check overrides model approval; repair commits and publishes accepted versions',async()=>fixture(async(dest)=> {
  let calls=0;
  const complete:Complete=async(s,u)=> {
    calls++;if(calls===2)expect(u).toContain('Required check failed');return code(calls===1?999:7)(s,u);
  };
  const {report,runDir}=await executeTasks(dest,{complete,evaluatorComplete:review});
  expect(calls).toBe(2);expect(report.statuses.task_0001).toBe('SUCCEEDED');
  const rejected=await Bun.file(join(runDir,'tasks','task_0001','evaluation-1.json')).json();expect(rejected.approved).toBe(false);expect(rejected.checks[1].passed).toBe(false);
  const accepted=await Bun.file(join(runDir,'tasks','task_0001','evaluation-2.json')).json();expect(accepted.approved).toBe(true);expect(accepted.checks.every((c:{passed:boolean})=>c.passed)).toBe(true);
  const content=await Bun.file(join(runDir,'repo','value.ts')).text();expect(content).toContain('return 7');
  const versions=await Bun.file(join(runDir,'file-versions.json')).json();expect(versions.files['value.ts'].version).toBe(`sha256:${createHash('sha256').update(content).digest('hex')}`);
  expect(versions.files['value.ts'].commit).toBe(accepted.integrationCommit);
}));
test('model rejection prevents merging even otherwise correct code',async()=>fixture(async(dest)=> {
  const {report,runDir}=await executeTasks(dest,{complete:code(7),evaluatorComplete:async()=>({content:'{"approved":false,"reasons":["Missing interface"]}'})});
  expect(report.statuses.task_0001).toBe('FAILED');expect(await Bun.file(join(runDir,'repo','value.ts')).exists()).toBe(false);expect(await Bun.file(join(runDir,'file-versions.json')).exists()).toBe(false);
}));
test('persistent test failure never merges or publishes file versions',async()=>fixture(async(dest)=> {
  const {report,runDir}=await executeTasks(dest,{complete:code(999),evaluatorComplete:review});
  expect(report.statuses.task_0001).toBe('FAILED');expect(await Bun.file(join(runDir,'repo','value.ts')).exists()).toBe(false);expect(await Bun.file(join(runDir,'file-versions.json')).exists()).toBe(false);
}));
test('malformed verdict fails closed and command timeout is enforced',async()=> {
  for(const text of ['{}','{"approved":"true","reasons":["x"]}','{"approved":true,"reasons":[]}'])expect(()=>validateVerdict(text)).toThrow();
  const result=await runCheck([process.execPath,'-e','await Bun.sleep(10000)'],tmpdir(),1);expect(result.timedOut).toBe(true);expect(result.passed).toBe(false);
});
test('checks cannot silently commit changed code and promote an unreviewed tree',async()=>fixture(async(dest)=> {
  const config=await Bun.file(join(dest,'hensei.yaml')).json();
  config.evaluation.test=[process.execPath,'-e','await Bun.write("extra.ts","export const injected=999;");const p=Bun.spawn(["git","-c","user.name=Test","-c","user.email=test@localhost","add","extra.ts"]);await p.exited;const c=Bun.spawn(["git","-c","user.name=Test","-c","user.email=test@localhost","-c","commit.gpgsign=false","commit","-m","unreviewed"]);if(await c.exited)process.exit(1);'];
  await Bun.write(join(dest,'hensei.yaml'),JSON.stringify(config));
  const {report,runDir}=await executeTasks(dest,{complete:code(7),evaluatorComplete:review});
  expect(report.statuses.task_0001).toBe('FAILED');expect(await Bun.file(join(runDir,'repo','extra.ts')).exists()).toBe(false);expect(await Bun.file(join(runDir,'file-versions.json')).exists()).toBe(false);
  expect((await Bun.file(join(runDir,'tasks','task_0001','evaluation-1.json')).json()).feedback).toContain('changed evaluated HEAD');
}));
