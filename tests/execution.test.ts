import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {executeTasks} from '../src/execution';
import {validateCandidate} from '../src/worker';
import type {Task,TaskPlan,Complete} from '../src/planner';
test('execution creates isolated candidates and truthful concurrency report from configured YAML',async()=> {
  const root=await mkdtemp(join(tmpdir(),'hensei-exec-'));
  try {
    const destination=join(root,'dest');await mkdir(destination);
    await Bun.write(join(destination,'hensei.yaml'),'target:\n  language: Go\nagents:\n  workers: 2');
    const tasks:Task[]=[];
    for (const id of ['task_a','task_b','task_c']) {
      const content=`export const ${id}=1;`,path=`${id}.ts`;
      await Bun.write(join(root,path),content);
      tasks.push({id,groupId:id,layer:id==='task_c'?1:0,goal:'Translate',prompt:'Migrate to Go',dependsOn:id==='task_c'?['task_a','task_b']:[],files:[{path,version:`sha256:${createHash('sha256').update(content).digest('hex')}`}]});
    }
    const plan:TaskPlan={schemaVersion:1,sourceRoot:root,targetLanguage:'Go',model:'test',createdAt:'test',graphVersion:'test',warnings:[],tasks};
    await Bun.write(join(destination,'tasks.json'),JSON.stringify(plan));
    let calls=0,active=0,peak=0;
    const complete:Complete=async(_s,u)=> {
      const context=JSON.parse(u.split('\n')[0]); calls++;active++;peak=Math.max(peak,active);
      expect(context.sources[0].content).toContain('export const');
      if(context.task.id==='task_c')expect(context.dependencies.length).toBe(2);
      await new Promise(r=>setTimeout(r,10));active--;
      return {content:JSON.stringify({taskId:context.task.id,summary:'Candidate',files:[{path:`${context.task.id}.go`,content:'package migrated\n',sourcePaths:context.task.files.map((f:{path:string})=>f.path)}]})};
    };
    const {report,runDir}=await executeTasks(destination,{complete});
    expect(calls).toBe(3);expect(peak).toBe(2);expect(report.limit).toBe(2);expect(report.parallelObserved).toBe(true);
    expect((await Bun.file(join(runDir,'events.jsonl')).text()).trim().split('\n').length).toBe(6);
    expect((await Bun.file(join(runDir,'report.json')).json()).candidateOnly).toBe(true);
    for(const task of tasks)expect(await Bun.file(join(runDir,'tasks',task.id,'files',`${task.id}.go`)).exists()).toBe(true);
    expect(await Bun.file(join(destination,'task_a.go')).exists()).toBe(false);
    await Bun.write(join(root,'task_a.ts'),'changed');
    await expect(executeTasks(destination,{complete})).rejects.toThrow('version changed');expect(calls).toBe(3);
  } finally {await rm(root,{recursive:true,force:true});}
});
test('candidate validation rejects traversal, omitted sources and reserved outputs',()=> {
  const task:Task={id:'task_a',groupId:'g',layer:0,goal:'x',prompt:'x',dependsOn:[],files:[{path:'a.ts',version:'x'}]};
  const draft=(path:string,sourcePaths:string[])=>JSON.stringify({taskId:task.id,summary:'x',files:[{path,content:'code',sourcePaths}]});
  for(const path of ['../escape.go','/tmp/escape.go','.env','hensei.yaml'])expect(()=>validateCandidate(draft(path,['a.ts']),task)).toThrow();
  expect(()=>validateCandidate(draft('a.go',['other.ts']),task)).toThrow();
});
