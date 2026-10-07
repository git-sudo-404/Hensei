import {join} from 'node:path';
import {mkdir,realpath} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {loadConfig} from './config';
import {deepseekComplete,type Complete,type TaskPlan} from './planner';
import {dispatch,validateTasks,type DispatchReport} from './dispatcher';
import {migrationWorker,readVersionedSource} from './worker';
import {WorktreeManager} from './worktrees';
export async function executeTasks(destination:string,options:{complete?:Complete;onProgress?:(message:string)=>void}={}):Promise<{runDir:string;report:DispatchReport}> {
  destination=await realpath(destination);
  const config=await loadConfig(destination);
  if (config.workers===undefined) throw new Error('Set agents.workers in destination config before executing tasks');
  const plan=await Bun.file(join(destination,'tasks.json')).json() as TaskPlan;
  validateTasks(plan);
  if (config.language!==plan.targetLanguage || config.framework!==plan.targetFramework || config.version!==plan.targetVersion) throw new Error('Config target differs from tasks.json; regenerate the plan');
  // Validate all input versions before admitting workers or spending API tokens.
  for (const task of plan.tasks) await readVersionedSource(plan.sourceRoot,task);
  const model=process.env.DEEPSEEK_MODEL||'deepseek-flash';
  const complete=options.complete??deepseekComplete(process.env.DEEPSEEK_API_KEY||'',model);
  const runDir=join(destination,'.hensei','runs',`${Date.now()}-${crypto.randomUUID()}`);
  await mkdir(runDir,{recursive:true});
  await Bun.write(join(runDir,'tasks.json'),JSON.stringify(plan,null,2)+'\n');
  const worktrees=new WorktreeManager(runDir);
  await worktrees.initialize();
  const report=await dispatch(plan,config.workers,migrationWorker(plan,runDir,complete,worktrees),event=> {
    appendFileSync(join(runDir,'events.jsonl'),JSON.stringify(event)+'\n');
    options.onProgress?.(`${event.type} ${event.taskId} worker=${event.workerId??'-'} active=${event.activeWorkers}/${config.workers}`);
  });
  await Bun.write(join(runDir,'report.json'),JSON.stringify({...report,model,candidateOnly:true,repository:worktrees.repo},null,2)+'\n');
  options.onProgress?.(`Peak workers: ${report.peakActiveWorkers}/${report.limit}; overlap observed: ${report.parallelObserved}. Report: ${join(runDir,'report.json')}`);
  return {runDir,report};
}
