import {test,expect} from 'bun:test';
import {dispatch} from '../src/dispatcher';
import type {Task,TaskPlan} from '../src/planner';
const task=(id:string,dependsOn:string[]=[]):Task=>({id,groupId:id,layer:0,goal:'Migrate',prompt:'Translate',dependsOn,files:[{path:`${id}.ts`,version:`sha256:${'a'.repeat(64)}`}]});
const plan=(tasks:Task[]):TaskPlan=>({schemaVersion:1,sourceRoot:'/source',targetLanguage:'Go',model:'test',createdAt:'test',graphVersion:'test',warnings:[],tasks});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
test('dispatcher fills slots concurrently, respects cap and unlocks dependent after completion',async()=> {
  const first=gate(), second=gate();let active=0,peak=0;
  const started:string[]=[],ended=new Set<string>();
  const running=dispatch(plan([task('task_a'),task('task_b'),task('task_c',['task_a']),task('task_d')]),2,async(t,workerId)=> {
    expect(workerId).toBeGreaterThanOrEqual(1);expect(workerId).toBeLessThanOrEqual(2);
    started.push(t.id);active++;peak=Math.max(peak,active);
    if (t.id==='task_a') await first.promise;
    if (t.id==='task_b') await second.promise;
    if (t.id==='task_c') expect(ended.has('task_a')).toBe(true);
    ended.add(t.id);active--;
  });
  // Both root workers must start before either finishes.
  await new Promise<void>(resolve=>{const poll=()=>started.length===2?resolve():queueMicrotask(poll);poll();});
  expect(started).toEqual(['task_a','task_b']);expect(active).toBe(2);
  first.release();second.release();
  const report=await running;
  expect(peak).toBe(2);expect(report.peakActiveWorkers).toBe(2);expect(report.parallelObserved).toBe(true);
  expect(Object.values(report.statuses).every(s=>s==='SUCCEEDED')).toBe(true);
  expect(report.events.every(e=>e.activeWorkers<=2)).toBe(true);
});
test('one slot serializes workers; failure blocks descendants but independent work completes',async()=> {
  const visited:string[]=[];
  const report=await dispatch(plan([task('task_a'),task('task_b',['task_a']),task('task_c',['task_b']),task('task_d')]),1,async(t)=>{visited.push(t.id);if(t.id==='task_a')throw new Error('failure');});
  expect(visited).toEqual(['task_a','task_d']);
  expect(report.statuses).toEqual({task_a:'FAILED',task_b:'BLOCKED',task_c:'BLOCKED',task_d:'SUCCEEDED'});
  expect(report.parallelObserved).toBe(false);expect(report.peakActiveWorkers).toBe(1);
});
test('invalid limits, dependencies and overlapping ownership reject before invocation',async()=> {
  let calls=0;const worker=async()=>{calls++;};
  for (const limit of [0,-1,1.5,65]) await expect(dispatch(plan([task('task_a')]),limit,worker)).rejects.toThrow();
  await expect(dispatch(plan([task('task_a',['task_b']),task('task_b',['task_a'])]),2,worker)).rejects.toThrow('cycle');
  await expect(dispatch(plan([task('task_a',['task_missing'])]),2,worker)).rejects.toThrow('Unknown');
  await expect(dispatch(plan([task('task_a'),task('task_a')]),2,worker)).rejects.toThrow();
  expect(calls).toBe(0);
});
test('large dependency chains and resumed successes schedule without repeated graph scans',async()=>{
  const tasks=Array.from({length:2000},(_,i)=>task(`task_${i}`,i?[`task_${i-1}`]:[]));let processed=0;
  const initial=Object.fromEntries(tasks.slice(0,1000).map(t=>[t.id,'SUCCEEDED' as const]));
  const report=await dispatch(plan(tasks),5,async()=>{processed++;},undefined,initial);
  expect(processed).toBe(1000);expect(report.peakActiveWorkers).toBe(1);expect(report.statuses.task_1999).toBe('SUCCEEDED');
});
