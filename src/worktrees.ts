import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {Task} from './planner';
import type {Candidate} from './worker';

export interface TaskCheckout {branch:string; path:string; baseCommit:string}
export interface CandidateRecord extends Candidate {branch:string; worktree:string; baseCommit:string; commit:string}

/** All mutations in the run's shared Git repository are serialized to avoid index/ref lock races. */
export class WorktreeManager {
  readonly repo:string;
  private queue:Promise<unknown>=Promise.resolve();
  constructor(readonly runDir:string) {this.repo=join(runDir,'repo');}
  private exclusive<T>(action:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(action);this.queue=next.catch(()=>{});return next;
  }
  private async git(cwd:string,args:string[],raw=false):Promise<string> {
    const env={...process.env};
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    const child=Bun.spawn(['git','-c','user.name=Hensei','-c','user.email=hensei@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],{
      cwd,env:{...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdout:'pipe',stderr:'pipe',
    });
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    if (code!==0) throw new Error(`Git ${args[0]} failed: ${stderr.trim()}`);
    return raw?stdout:stdout.trim();
  }
  async initialize():Promise<void> {
    await this.exclusive(async()=>{
      await mkdir(this.repo,{recursive:true});
      await this.git(this.repo,['-c','init.templateDir=','init','-b','integration']);
      await this.git(this.repo,['commit','--allow-empty','-m','Initialize isolated migration run']);
    });
  }
  async create(task:Task,dependencies:CandidateRecord[]):Promise<TaskCheckout> {
    if (!/^task_[a-zA-Z0-9_-]+$/.test(task.id)) throw new Error('Unsafe task branch name');
    return this.exclusive(async()=>{
      const path=join(this.runDir,'worktrees',task.id);
      await mkdir(join(this.runDir,'worktrees'),{recursive:true});
      await this.git(this.repo,['worktree','add','-b',task.id,path,'integration']);
      // Dependencies remain provisional. Snapshot their committed files without merging integration.
      const occupied=new Map<string,string>();
      const paths:string[]=[];
      for (const dependency of dependencies) for (const file of dependency.files) {
        const prior=occupied.get(file.path);
        if (prior!==undefined && prior!==file.content) throw new Error(`Conflicting prerequisite output: ${file.path}`);
        if (prior!==undefined) continue;
        occupied.set(file.path,file.content);
        if(await Bun.file(join(path,file.path)).exists()) {
          if(await Bun.file(join(path,file.path)).text()!==file.content)throw new Error(`Integrated prerequisite differs: ${file.path}`);
          continue;
        }
        paths.push(file.path);await Bun.write(join(path,file.path),file.content);
      }
      if (paths.length) {
        await this.git(path,['add','--',...paths]);
        await this.git(path,['commit','-m',`Snapshot provisional prerequisites for ${task.id}`]);
      }
      return {branch:task.id,path,baseCommit:await this.git(path,['rev-parse','HEAD'])};
    });
  }
  async submit(checkout:TaskCheckout,candidate:Candidate,repair=false):Promise<CandidateRecord> {
    return this.exclusive(async()=>{
      if(repair)await this.git(checkout.path,['reset','--hard',checkout.baseCommit]);
      for (const file of candidate.files) {
        if (!repair && await Bun.file(join(checkout.path,file.path)).exists()) throw new Error(`Candidate would overwrite prerequisite output: ${file.path}`);
      }
      for (const file of candidate.files) await Bun.write(join(checkout.path,file.path),file.content);
      await this.git(checkout.path,['add','--',...candidate.files.map(file=>file.path)]);
      await this.git(checkout.path,['commit','-m',`Migrate ${candidate.taskId}\n\nHensei-Task: ${candidate.taskId}`]);
      if (await this.git(checkout.path,['status','--porcelain'])) throw new Error('Candidate worktree is not clean after commit');
      return {...candidate,branch:checkout.branch,worktree:checkout.path,baseCommit:checkout.baseCommit,commit:await this.git(checkout.path,['rev-parse','HEAD'])};
    });
  }
  async integrate(candidate:CandidateRecord,check:(path:string)=>Promise<void>):Promise<string> {
    return this.exclusive(async()=>{
      const head=await this.git(this.repo,['rev-parse','HEAD']);
      if(await this.git(candidate.worktree,['rev-parse','HEAD'])!==candidate.commit || await this.git(candidate.worktree,['status','--porcelain']))throw new Error('Candidate changed after submission');
      const changed=(await this.git(candidate.worktree,['diff','--name-only','-z',candidate.baseCommit,candidate.commit],true)).split('\0').filter(Boolean).sort();
      if(JSON.stringify(changed)!==JSON.stringify(candidate.files.map(f=>f.path).sort()))throw new Error('Candidate diff exceeds declared files');
      for(const file of candidate.files)if(await this.git(candidate.worktree,['show',`${candidate.commit}:${file.path}`],true)!==file.content)throw new Error('Candidate manifest differs from committed code');
      const review=join(this.runDir,'evaluations',`${candidate.taskId}-${crypto.randomUUID()}`);
      await mkdir(join(this.runDir,'evaluations'),{recursive:true});
      await this.git(this.repo,['worktree','add','--detach',review,head]);
      await this.git(review,['merge','--no-ff','--no-edit',candidate.commit]);
      const evaluated=await this.git(review,['rev-parse','HEAD']);
      await check(review);
      if(await this.git(review,['rev-parse','HEAD'])!==evaluated)throw new Error('Checks changed evaluated HEAD; refuse integration');
      if(await this.git(review,['status','--porcelain']))throw new Error('Checks changed the evaluated tree; refuse integration');
      if(await this.git(this.repo,['rev-parse','HEAD'])!==head)throw new Error('Integration HEAD changed during evaluation');
      await this.git(this.repo,['merge','--ff-only',evaluated]);
      return evaluated;
    });
  }

}
