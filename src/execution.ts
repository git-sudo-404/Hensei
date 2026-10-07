import {atomicJson} from './storage';
import {join,relative,isAbsolute} from 'node:path';
import {mkdir,realpath} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {loadConfig} from './config';
import {deepseekComplete,type Complete,type TaskPlan} from './planner';
import {validateTasks,type DispatchReport,type Status} from './dispatcher';
import {candidateGenerator,readVersionedSource} from './worker';
import {WorktreeManager} from './worktrees';
import {Evaluator} from './evaluator';
import {Harness,harnessDefaults} from './harness';
import {inventory,assertSnapshot,type Inventory} from './inventory';
import {Journal} from './journal';
import {runLock} from './runlock';
import {audit,followups,type FinalAudit} from './audit';
import {dispatchCoordinated} from './scheduler';
export interface RunReport extends DispatchReport {finalAudit:FinalAudit;rounds:number;apiCalls:number;tokens:number;stopReason?:string}
export async function executeTasks(destination:string,options:{complete?:Complete;evaluatorComplete?:Complete;orchestratorComplete?:Complete;onProgress?:(message:string)=>void;resume?:string}={}):Promise<{runDir:string;report:RunReport}> {
  destination=await realpath(destination);const release=await runLock(destination);let journal:Journal|undefined;
  try {
    const config=await loadConfig(destination);
    if(config.workers===undefined)throw new Error('Set agents.workers in destination config before executing tasks');
    if(!config.evaluation)throw new Error('Set evaluation.build and evaluation.test command arrays before running');
    if(options.resume&&(!/^[a-zA-Z0-9-]+$/.test(options.resume)))throw new Error('Invalid run ID');
    const runDir=options.resume?join(destination,'.hensei','runs',options.resume):join(destination,'.hensei','runs',`${Date.now()}-${crypto.randomUUID()}`);
    if(options.resume&&!await Bun.file(join(runDir,'state.sqlite')).exists())throw new Error('Run does not exist or predates durable state');
    if(options.resume)journal=new Journal(runDir);
    const plan=(options.resume?journal!.get<TaskPlan>('plan'):undefined)??await Bun.file(options.resume?join(runDir,'tasks.json'):join(destination,'tasks.json')).json() as TaskPlan;
    if(options.resume)plan.tasks=journal!.tasks();
    if(plan.tasks.some(t=>t.files.length!==1||!t.outputPaths?.length))throw new Error('Regenerate tasks.json: execution requires one-file tasks with frozen outputPaths');
    validateTasks(plan,options.resume?Object.fromEntries(plan.tasks.map(task=>[task.id,'SUCCEEDED' as Status])):{});
    if(config.language!==plan.targetLanguage||config.framework!==plan.targetFramework||config.version!==plan.targetVersion)throw new Error('Config target differs from tasks.json; regenerate plan');
    const root=await realpath(plan.sourceRoot),relation=relative(root,destination);
    if(!relation||(relation!=='..'&&!relation.startsWith('../')&&!isAbsolute(relation)))throw new Error('Destination must be outside source root');
    const excludes=config.coverage?.exclude??[];
    for(const task of plan.tasks)if(task.kind!=='copy')await readVersionedSource(root,task);
    await mkdir(runDir,{recursive:true});journal??=new Journal(runDir);
    const snapshot=options.resume?journal.get<Inventory>('inventory')!:await inventory(root,excludes);
    if(!snapshot)throw new Error('Missing source inventory');await assertSnapshot(root,snapshot,excludes);
    if(options.resume&&JSON.stringify(journal.get('config'))!==JSON.stringify(config))throw new Error('Run config changed; start a new run');
    if(!options.resume){journal.initialize(plan,snapshot,config);await atomicJson(join(runDir,'tasks.json'),plan);}
    else plan.tasks=journal.tasks();
    const model=process.env.DEEPSEEK_MODEL||'deepseek-flash',runtime=config.runtime??harnessDefaults;
    const provider=options.complete??deepseekComplete(process.env.DEEPSEEK_API_KEY||'',model,runtime);
    const workerHarness=new Harness(runtime,provider,usage=>journal!.set('usage',usage));
    const saved=journal.get<{calls:number;tokens:number}>('usage');if(saved){workerHarness.calls=saved.calls;workerHarness.tokens=saved.tokens;}
    const complete:Complete=(s,u)=>workerHarness.call(s,u);
    // All roles share the same budget accounting even with injected role-specific transports.
    const role=(transport:Complete|undefined):Complete=>transport?(s,u)=>workerHarness.call(s,u,transport):complete;
    const evaluatorComplete=role(options.evaluatorComplete),orchestratorComplete=role(options.orchestratorComplete);
    const worktrees=new WorktreeManager(runDir);await worktrees.initialize();
    const evaluator=new Evaluator(plan,runDir,config.evaluation,evaluatorComplete,worktrees,journal,runtime);await evaluator.recover();
    const statuses=journal.statuses();for(const [id,status]of Object.entries(statuses))if(status==='RUNNING')journal.status(id,'PENDING');
    const eventPath=join(runDir,'events.jsonl'),lines=await Bun.file(eventPath).exists()?(await Bun.file(eventPath).text()).trim().split('\n').filter(Boolean):[];
    const history=lines.flatMap((line,index)=>{try{return [JSON.parse(line)];}catch(error){if(index===lines.length-1)return [];throw error;}});
    let total:DispatchReport={limit:config.workers,peakActiveWorkers:history.reduce((peak,e)=>Math.max(peak,e.activeWorkers),journal.get<number>('peak')??0),parallelObserved:(journal.get<number>('peak')??0)>1||history.some(e=>e.activeWorkers>1),durationMs:0,statuses:{},events:history},finalAudit:FinalAudit,round=journal.get<number>('round')??0,stopReason:string|undefined;
    const checkpoint={attempts:journal.get<Record<string,number>>('attempts')??{},feedback:journal.get<Record<string,string>>('feedback')??{},persist:()=>{journal!.set('attempts',checkpoint.attempts);journal!.set('feedback',checkpoint.feedback);}};
    const started=performance.now();
    for(;;) {
      journal.add(plan.tasks);const initial=journal.statuses() as Record<string,Status>;
      const batch=await dispatchCoordinated(plan,config.workers,candidateGenerator(plan,runDir,complete,worktrees,runtime),evaluator,config.evaluation.maxAttempts,event=>{
        journal!.set('peak',Math.max(journal!.get<number>('peak')??0,event.activeWorkers));
        if(event.error)journal!.set('error:'+event.taskId,event.error);
        if(!['submitted','returned'].includes(event.type))journal!.status(event.taskId,event.type==='started'?'RUNNING':event.type==='succeeded'?'SUCCEEDED':event.type==='failed'?'FAILED':'BLOCKED');
        appendFileSync(join(runDir,'events.jsonl'),JSON.stringify({...event,round})+'\n');options.onProgress?.(`${event.type} ${event.taskId} worker=${event.workerId??'-'} active=${event.activeWorkers}/${config.workers}`);
      },initial,checkpoint);
      total={...batch,peakActiveWorkers:Math.max(total.peakActiveWorkers,batch.peakActiveWorkers),parallelObserved:total.parallelObserved||batch.parallelObserved,events:[...total.events,...batch.events]};
      await evaluator.recover();
      finalAudit=await audit(plan,snapshot,excludes,journal,worktrees,config.evaluation);
      await Bun.write(join(runDir,`audit-${round}.json`),JSON.stringify(finalAudit,null,2)+'\n');journal.set('audit',finalAudit);
      options.onProgress?.(`Final audit: coverage=${finalAudit.coveragePercent.toFixed(1)}%, tests=${finalAudit.checks.every(c=>c.passed)}, complete=${finalAudit.complete}`);
      if(finalAudit.complete)break;
      if(!finalAudit.sourceStable){stopReason='Source changed';break;}
      if(round>=(config.orchestration?.maxRounds??2)){stopReason='Follow-up round limit reached';break;}
      try {
        const added=await followups(plan,snapshot,finalAudit,round+1,orchestratorComplete,journal);
        if(!added.length){stopReason='No actionable follow-up tasks';break;}
        plan.tasks.push(...added);round++;journal.enqueue(added,round);
        await atomicJson(join(runDir,'tasks.json'),plan);
        options.onProgress?.(`Orchestrator added ${added.length} follow-up tasks (round ${round})`);
      }catch(error){stopReason=(error as Error).message;break;}
    }
    const report:RunReport={...total,durationMs:performance.now()-started,finalAudit:finalAudit!,rounds:round,apiCalls:workerHarness.calls,tokens:workerHarness.tokens,...(stopReason?{stopReason}:{})};
    await Bun.write(join(runDir,'report.json'),JSON.stringify({...report,model,candidateOnly:false,repository:worktrees.repo},null,2)+'\n');
    journal.set('complete',report.finalAudit.complete);options.onProgress?.(`Peak workers: ${report.peakActiveWorkers}/${report.limit}; complete=${report.finalAudit.complete}. Report: ${join(runDir,'report.json')}`);
    return {runDir,report};
  }finally{journal?.close();await release();}
}
