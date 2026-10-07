import {dispatch,validateTasks,type DispatchEvent,type DispatchReport,type Status} from './dispatcher';
import type {Task,TaskPlan} from './planner';
import type {CandidateRecord} from './worktrees';
import type {Evaluator} from './evaluator';

/** Fixed worker actors. A submitted candidate frees its actor, avoiding SCC > pool-size deadlocks. */
class Pool {
  private free:number[];private waiting:((id:number)=>void)[]=[];
  active=0;peak=0;
  constructor(limit:number){this.free=Array.from({length:limit},(_,i)=>i+1);}
  async run<T>(action:(id:number)=>Promise<T>):Promise<T> {
    const id=this.free.length?this.free.shift()!:await new Promise<number>(resolve=>this.waiting.push(resolve));
    this.active++;this.peak=Math.max(this.peak,this.active);
    try{return await action(id);}finally{this.active--;const next=this.waiting.shift();if(next)next(id);else this.free.push(id);}
  }
}
export interface DispatchCheckpoint {attempts:Record<string,number>;feedback:Record<string,string>;persist:()=>void}
export async function dispatchCoordinated(plan:TaskPlan,limit:number,
  generate:(task:Task,worker:number,attempt:number,feedback:string,peers:CandidateRecord[])=>Promise<CandidateRecord>,
  evaluator:Evaluator,maxAttempts:number,onEvent?:(event:DispatchEvent)=>void,initial:Record<string,Status>={},checkpoint?:DispatchCheckpoint):Promise<DispatchReport> {
  validateTasks(plan,initial);
  const started=performance.now(),pool=new Pool(limit),events:DispatchEvent[]=[],statuses:Record<string,Status>=Object.fromEntries(plan.tasks.map(t=>[t.id,initial[t.id]??'PENDING']));
  const groups=new Map<string,Task[]>();for(const task of plan.tasks){const group=groups.get(task.groupId)??[];group.push(task);groups.set(task.groupId,group);}
  const units=[...groups.entries()].map(([groupId,members],index)=>({id:`task_unit_${index}`,groupId,layer:Math.min(...members.map(t=>t.layer)),goal:'Coordinate migration group',prompt:'Generate one-file candidates, then check and merge the complete group',files:members.flatMap(t=>t.files),dependsOn:[] as string[]}));
  const taskUnit=new Map(units.flatMap(u=>groups.get(u.groupId)!.map(t=>[t.id,u.id] as const))),unitStatus:Record<string,Status>={};
  for(const unit of units){const members=groups.get(unit.groupId)!;unit.dependsOn=[...new Set(members.flatMap(t=>t.dependsOn.map(id=>taskUnit.get(id)!)).filter(id=>id!==unit.id))];const states=members.map(t=>statuses[t.id]);if(states.every(s=>s==='SUCCEEDED'))unitStatus[unit.id]='SUCCEEDED';else if(states.some(s=>s==='SUCCEEDED'))throw new Error('Partial coordination-group recovery; receipt is incomplete');else if(states.some(s=>s==='FAILED'||s==='BLOCKED'))unitStatus[unit.id]='FAILED';}
  const emit=(type:DispatchEvent['type'],task:Task,workerId?:number,error?:string)=>{const event:DispatchEvent={type,taskId:task.id,workerId,timestamp:new Date().toISOString(),activeWorkers:pool.active,elapsedMs:performance.now()-started,...(error?{error}:{})};events.push(event);onEvent?.(event);};
  const synthetic:TaskPlan={...plan,schemaVersion:1,tasks:units};
  await dispatch(synthetic,limit,async unit=>{
    const members=groups.get(unit.groupId)!;let feedback=checkpoint?.feedback[unit.groupId]??'',previous:CandidateRecord[]=[];const firstAttempt=1+Math.max(0,...members.map(t=>checkpoint?.attempts[t.id]??0));
    try {
      for(let attempt=firstAttempt;attempt<=maxAttempts;attempt++) {
        if(checkpoint){for(const task of members)checkpoint.attempts[task.id]=attempt;checkpoint.persist();}
        const generated=await Promise.allSettled(members.map(task=>pool.run(async worker=>{
          statuses[task.id]='RUNNING';emit('started',task,worker);
          const candidate=await generate(task,worker,attempt,feedback,previous.filter(c=>c.taskId!==task.id));emit('submitted',task,worker);return candidate;
        })));
        const failure=generated.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;
        const candidates=generated.map(r=>(r as PromiseFulfilledResult<CandidateRecord>).value);
        const result=await evaluator.evaluateGroup(members,candidates,attempt);
        if(result.approved){for(const task of members){statuses[task.id]='SUCCEEDED';emit('succeeded',task);}return;}
        feedback=result.feedback;previous=candidates;if(checkpoint){checkpoint.feedback[unit.groupId]=feedback;checkpoint.persist();}
        if(attempt<maxAttempts)for(const task of members)emit('returned',task,undefined,feedback);
      }
      throw new Error(`Evaluator rejected coordination group after ${maxAttempts} attempts: ${feedback}`);
    }catch(error){for(const task of members){statuses[task.id]='FAILED';emit('failed',task,undefined,(error as Error).message);}throw error;}
  },event=>{if(event.type==='blocked')for(const task of groups.get(units.find(u=>u.id===event.taskId)!.groupId)!){statuses[task.id]='BLOCKED';emit('blocked',task);}},unitStatus);
  return {limit,peakActiveWorkers:pool.peak,parallelObserved:pool.peak>1,durationMs:performance.now()-started,statuses,events};
}
