import type {Task, TaskPlan} from './planner';
export type Status = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
export interface DispatchEvent { type:'started'|'succeeded'|'failed'|'blocked'; taskId:string; workerId?:number; timestamp:string; activeWorkers:number; elapsedMs:number; error?:string }
export interface DispatchReport { limit:number; peakActiveWorkers:number; parallelObserved:boolean; durationMs:number; statuses:Record<string,Status>; events:DispatchEvent[] }
export type Worker = (task:Task, workerId:number, prerequisites:Task[]) => Promise<void>;

export function validateTasks(plan:TaskPlan): void {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.tasks) || !plan.tasks.length || typeof plan.sourceRoot !== 'string' || !plan.sourceRoot || typeof plan.targetLanguage !== 'string' || !plan.targetLanguage) throw new Error('Invalid or empty task plan');
  const ids=new Set<string>(), ownership=new Set<string>();
  for (const task of plan.tasks) {
    if (!/^task_[a-zA-Z0-9_-]+$/.test(task.id) || ids.has(task.id) || typeof task.goal!=='string' || !task.goal.trim() || typeof task.prompt!=='string' || !task.prompt.trim() || !Array.isArray(task.dependsOn) || !Array.isArray(task.files) || !task.files.length) throw new Error('Invalid or duplicate task');
    ids.add(task.id);
    for (const file of task.files) {
      if (typeof file.path!=='string' || !file.path || !/^sha256:[a-f0-9]{64}$/.test(file.version) || ownership.has(file.path)) throw new Error('Invalid version or overlapping file ownership');
      ownership.add(file.path);
    }
  }
  const resolved=new Set<string>();
  for (const task of plan.tasks) for (const dep of task.dependsOn) if (!ids.has(dep) || dep===task.id) throw new Error('Unknown or self task dependency');
  while (resolved.size<plan.tasks.length) {
    const ready=plan.tasks.filter(t=>!resolved.has(t.id)&&t.dependsOn.every(dep=>resolved.has(dep)));
    if (!ready.length) throw new Error('Task dependencies contain a cycle');
    for (const task of ready) resolved.add(task.id);
  }
}

/** The controller owns admission; model responses never decide worker counts or dependencies. */
export async function dispatch(plan:TaskPlan,limit:number,worker:Worker,onEvent?:(event:DispatchEvent)=>void): Promise<DispatchReport> {
  if (!Number.isInteger(limit)||limit<1||limit>64) throw new Error('agents.workers must be an integer from 1 to 64');
  validateTasks(plan);
  const started=performance.now(), events:DispatchEvent[]=[], statuses:Record<string,Status>=Object.fromEntries(plan.tasks.map(t=>[t.id,'PENDING']));
  const running=new Map<string,Promise<void>>(), free=Array.from({length:limit},(_,i)=>i+1);
  let active=0,peak=0;
  const emit=(type:DispatchEvent['type'],taskId:string,workerId?:number,error?:string)=> {
    const event:DispatchEvent={type,taskId,workerId,timestamp:new Date().toISOString(),activeWorkers:active,elapsedMs:performance.now()-started,...(error?{error}:{})};
    events.push(event); onEvent?.(event);
  };
  while (Object.values(statuses).some(s=>s==='PENDING')||running.size) {
    // Propagate failures before admitting more work.
    let changed=true;
    while (changed) {
      changed=false;
      for (const task of plan.tasks) if (statuses[task.id]==='PENDING'&&task.dependsOn.some(id=>['FAILED','BLOCKED'].includes(statuses[id]))) {
        statuses[task.id]='BLOCKED'; emit('blocked',task.id); changed=true;
      }
    }
    for (const task of plan.tasks) {
      if (!free.length) break;
      if (statuses[task.id]!=='PENDING'||!task.dependsOn.every(id=>statuses[id]==='SUCCEEDED')) continue;
      const workerId=free.shift()!;
      statuses[task.id]='RUNNING'; active++; peak=Math.max(peak,active); emit('started',task.id,workerId);
      // Defer invocation until the promise is registered, including synchronous failures.
      const promise=Promise.resolve().then(()=>worker(task,workerId,plan.tasks.filter(t=>task.dependsOn.includes(t.id))))
        .then(()=>{statuses[task.id]='SUCCEEDED';active--;emit('succeeded',task.id,workerId);},error=>{statuses[task.id]='FAILED';active--;emit('failed',task.id,workerId,error instanceof Error?error.message:'Worker failed');})
        .finally(()=>{running.delete(task.id);free.push(workerId);free.sort((a,b)=>a-b);});
      running.set(task.id,promise);
    }
    if (running.size) await Promise.race(running.values());
    else if (Object.values(statuses).some(s=>s==='PENDING')) throw new Error('Dispatcher stalled');
  }
  return {limit,peakActiveWorkers:peak,parallelObserved:peak>1,durationMs:performance.now()-started,statuses,events};
}
