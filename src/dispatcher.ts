import {safePath} from './paths';
import type {Task, TaskPlan} from './planner';
export type Status = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export interface DispatchEvent { type:'started'|'submitted'|'returned'|'succeeded'|'failed'|'blocked'; taskId:string; workerId?:number; timestamp:string; activeWorkers:number; elapsedMs:number; error?:string }
export interface DispatchReport { limit:number; peakActiveWorkers:number; parallelObserved:boolean; durationMs:number; statuses:Record<string,Status>; events:DispatchEvent[] }
export type Worker = (task:Task, workerId:number, prerequisites:Task[]) => Promise<void>;

export function validateTasks(plan:TaskPlan,initial:Record<string,Status>={}): void {
  if (![1,2].includes(plan.schemaVersion) || !Array.isArray(plan.tasks) || !plan.tasks.length || typeof plan.sourceRoot !== 'string' || !plan.sourceRoot || typeof plan.targetLanguage !== 'string' || !plan.targetLanguage) throw new Error('Invalid or empty task plan');
  const ids=new Set<string>(), ownership=new Set<string>(),outputOwnership=new Set<string>();
  for (const task of plan.tasks) {
    if (!/^task_[a-zA-Z0-9_-]+$/.test(task.id) || ids.has(task.id) || typeof task.goal!=='string' || !task.goal.trim() || typeof task.prompt!=='string' || !task.prompt.trim() || !Array.isArray(task.dependsOn) || !Array.isArray(task.files) || !task.files.length) throw new Error('Invalid or duplicate task');
    if(task.kind!==undefined&&!['migrate','repair','copy'].includes(task.kind))throw new Error('Unknown task kind');
    if(new Set(task.dependsOn).size!==task.dependsOn.length)throw new Error('Duplicate task dependency');
    if(task.targetFiles!==undefined&&(!Array.isArray(task.targetFiles)||task.targetFiles.some(f=>typeof f.path!=='string'||!safePath(f.path)||(task.outputPaths&&!task.outputPaths.includes(f.path))||!/^sha256:[a-f0-9]{64}$/.test(f.version))))throw new Error('Invalid target file versions');
    if(plan.schemaVersion===2&&(task.files.length!==1||!Array.isArray(task.outputPaths)||!task.outputPaths.length))throw new Error('Version 2 requires one source file and explicit outputPaths');
    if(task.outputPaths)for(const path of task.outputPaths){if(typeof path!=='string'||!safePath(path)||['hensei.yml','hensei.yaml','tasks.json'].includes(path))throw new Error('Unsafe output scope');if(!initial[task.id]||['PENDING','RUNNING'].includes(initial[task.id])){if(outputOwnership.has(path))throw new Error('Overlapping target output ownership');outputOwnership.add(path);}}
    if(task.semanticPeers!==undefined&&(!Array.isArray(task.semanticPeers)||task.semanticPeers.some(p=>!safePath(p))))throw new Error('Unsafe semantic peer path');
    ids.add(task.id);
    for (const file of task.files) {
      if (typeof file.path!=='string' || !safePath(file.path) || !/^sha256:[a-f0-9]{64}$/.test(file.version) || (ownership.has(file.path)&&(!initial[task.id]||initial[task.id]==='PENDING'||initial[task.id]==='RUNNING'))) throw new Error('Invalid version or overlapping file ownership');
      if((!initial[task.id]||initial[task.id]==='PENDING'||initial[task.id]==='RUNNING'))ownership.add(file.path);
    }
  }
  const pending=new Map(plan.tasks.map(t=>[t.id,t.dependsOn.length])),consumers=new Map(plan.tasks.map(t=>[t.id,[] as string[]]));
  for(const task of plan.tasks)for(const dep of task.dependsOn){if(!ids.has(dep)||dep===task.id)throw new Error('Unknown or self task dependency');consumers.get(dep)!.push(task.id);}
  const ready=plan.tasks.filter(t=>!t.dependsOn.length).map(t=>t.id);let count=0;
  for(let index=0;index<ready.length;index++){const id=ready[index];count++;for(const consumer of consumers.get(id)!){const n=pending.get(consumer)!-1;pending.set(consumer,n);if(n===0)ready.push(consumer);}}
  if(count!==plan.tasks.length)throw new Error('Task dependencies contain a cycle');

}

/** The controller owns admission; model responses never decide worker counts or dependencies. */
export async function dispatch(plan:TaskPlan,limit:number,worker:Worker,onEvent?:(event:DispatchEvent)=>void,initial:Record<string,Status>={}): Promise<DispatchReport> {
  if (!Number.isInteger(limit)||limit<1||limit>64) throw new Error('agents.workers must be an integer from 1 to 64');
  validateTasks(plan,initial);
  const started=performance.now(),events:DispatchEvent[]=[],statuses:Record<string,Status>=Object.fromEntries(plan.tasks.map(t=>[t.id,initial[t.id]??'PENDING']));
  const byId=new Map(plan.tasks.map(t=>[t.id,t])),consumers=new Map(plan.tasks.map(t=>[t.id,[] as string[]]));
  for(const task of plan.tasks)for(const dep of task.dependsOn)consumers.get(dep)!.push(task.id);
  const remaining=new Map(plan.tasks.map(t=>[t.id,t.dependsOn.filter(dep=>statuses[dep]!=='SUCCEEDED').length]));
  const ready:string[]=[],running=new Map<string,Promise<void>>(),free=Array.from({length:limit},(_,i)=>i+1);
  let active=0,peak=0;
  const emit=(type:DispatchEvent['type'],taskId:string,workerId?:number,error?:string)=>{const event:DispatchEvent={type,taskId,workerId,timestamp:new Date().toISOString(),activeWorkers:active,elapsedMs:performance.now()-started,...(error?{error}:{})};events.push(event);onEvent?.(event);};
  const block=(id:string)=>{const stack=[id];while(stack.length){const current=stack.pop()!;if(statuses[current]!=='PENDING')continue;statuses[current]='BLOCKED';emit('blocked',current);stack.push(...consumers.get(current)!);}};
  for(const task of plan.tasks)if(statuses[task.id]==='PENDING'&&task.dependsOn.some(dep=>['FAILED','BLOCKED'].includes(statuses[dep])))block(task.id);
  for(const task of plan.tasks)if(statuses[task.id]==='PENDING'&&remaining.get(task.id)===0)ready.push(task.id);
  while(ready.length||running.size) {
    while(free.length&&ready.length) {
      const id=ready.shift()!,task=byId.get(id)!;if(statuses[id]!=='PENDING')continue;
      const workerId=free.shift()!;statuses[id]='RUNNING';active++;peak=Math.max(peak,active);emit('started',id,workerId);
      const promise=Promise.resolve().then(()=>worker(task,workerId,task.dependsOn.map(dep=>byId.get(dep)!)))
      .then(()=>{statuses[id]='SUCCEEDED';active--;emit('succeeded',id,workerId);for(const consumer of consumers.get(id)!){const n=remaining.get(consumer)!-1;remaining.set(consumer,n);if(!n&&statuses[consumer]==='PENDING')ready.push(consumer);}},error=>{statuses[id]='FAILED';active--;emit('failed',id,workerId,error instanceof Error?error.message:'Worker failed');for(const consumer of consumers.get(id)!)block(consumer);})
      .finally(()=>{running.delete(id);free.push(workerId);free.sort((a,b)=>a-b);});running.set(id,promise);
    }
    if(running.size)await Promise.race(running.values());
  }
  if(Object.values(statuses).some(s=>s==='PENDING'||s==='RUNNING'))throw new Error('Dispatcher stalled');
  return {limit,peakActiveWorkers:peak,parallelObserved:peak>1,durationMs:performance.now()-started,statuses,events};
}
