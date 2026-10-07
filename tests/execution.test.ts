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
    let calls=0,active=0,peak=0,release!:()=>void;
    const bothWorkers=new Promise<void>(resolve=>release=resolve);
    const complete:Complete=async(_s,u)=> {
      const context=JSON.parse(u.split('\n')[0]); calls++;active++;peak=Math.max(peak,active);
      expect(context.sources[0].content).toContain('export const');
      if(context.task.id==='task_c')expect(context.dependencies.length).toBe(2);
      if(context.task.id!=='task_c') {if(calls===2)release();await bothWorkers;}active--;
      return {content:JSON.stringify({taskId:context.task.id,summary:'Candidate',files:[{path:`${context.task.id}.go`,content:'package migrated\n',sourcePaths:context.task.files.map((f:{path:string})=>f.path)}]})};
    };
    const {report,runDir}=await executeTasks(destination,{complete});
    expect(calls).toBe(3);expect(peak).toBe(2);expect(report.limit).toBe(2);expect(report.parallelObserved).toBe(true);
    expect((await Bun.file(join(runDir,'events.jsonl')).text()).trim().split('\n').length).toBe(6);
    expect((await Bun.file(join(runDir,'report.json')).json()).candidateOnly).toBe(true);
    for(const task of tasks)expect(await Bun.file(join(runDir,'worktrees',task.id,`${task.id}.go`)).exists()).toBe(true);
    expect(await Bun.file(join(destination,'task_a.go')).exists()).toBe(false);
    for (const task of tasks) {
      const candidate=await Bun.file(join(runDir,'tasks',task.id,'candidate.json')).json();
      expect(candidate.branch).toBe(task.id);expect(candidate.commit).toMatch(/^[a-f0-9]{40}$/);
      const check=Bun.spawn(['git','branch','--show-current'],{cwd:candidate.worktree,stdout:'pipe'});
      expect((await new Response(check.stdout).text()).trim()).toBe(task.id);expect(await check.exited).toBe(0);
      const clean=Bun.spawn(['git','status','--porcelain'],{cwd:candidate.worktree,stdout:'pipe'});
      expect((await new Response(clean.stdout).text()).trim()).toBe('');expect(await clean.exited).toBe(0);
    }
    expect(await Bun.file(join(runDir,'worktrees','task_c','task_a.go')).exists()).toBe(true);
    expect(await Bun.file(join(runDir,'worktrees','task_c','task_b.go')).exists()).toBe(true);
    expect(await Bun.file(join(runDir,'worktrees','task_a','task_b.go')).exists()).toBe(false);
    const baseline=Bun.spawn(['git','ls-tree','--name-only','HEAD'],{cwd:join(runDir,'repo'),stdout:'pipe'});
    expect((await new Response(baseline.stdout).text()).trim()).toBe('');expect(await baseline.exited).toBe(0);
    const failed=await executeTasks(destination,{complete:async()=>{throw new Error('Provider failure');}});
    expect(failed.runDir).not.toBe(runDir);
    expect(failed.report.statuses).toEqual({task_a:'FAILED',task_b:'FAILED',task_c:'BLOCKED'});
    expect(await Bun.file(join(failed.runDir,'worktrees','task_a','.git')).exists()).toBe(true);
    expect(await Bun.file(join(failed.runDir,'tasks','task_a','worktree.json')).exists()).toBe(true);
    expect(await Bun.file(join(failed.runDir,'tasks','task_a','candidate.json')).exists()).toBe(false);
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
