import {mkdir,realpath} from 'node:fs/promises';
import {contentVersion} from './inventory';
import type {TaskFile} from './planner';
import {join,relative} from 'node:path';
import type {Task} from './planner';
import type {Candidate} from './worker';

export interface TaskCheckout {branch:string; path:string; baseCommit:string}
export interface CandidateRecord extends Candidate {branch:string; worktree:string; baseCommit:string; commit:string; readCommit?:string; targetVersions?:Record<string,string|null> }

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
      if(await Bun.file(join(this.repo,'.git','HEAD')).exists()){if(await this.git(this.repo,['status','--porcelain']))throw new Error('Integration checkout dirty; manual recovery required');return;}
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
      if(await Bun.file(join(path,'.git')).exists()){const checkout={branch:task.id,path,baseCommit:''};await this.assertCheckout(checkout);await this.git(path,['reset','--hard','integration']);if(task.outputPaths?.length)await this.git(path,['clean','-fd','--',...task.outputPaths]);return {...checkout,baseCommit:await this.git(path,['rev-parse','HEAD'])};}
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
          if(contentVersion(await Bun.file(join(path,file.path)).bytes())!==contentVersion(file.encoding==='base64'?Buffer.from(file.content,'base64'):file.content))throw new Error(`Integrated prerequisite differs: ${file.path}`);
          continue;
        }
        paths.push(file.path);await Bun.write(join(path,file.path),file.encoding==='base64'?Buffer.from(file.content,'base64'):file.content);
      }
      if (paths.length) {
        await this.git(path,['add','--',...paths]);
        await this.git(path,['commit','-m',`Snapshot provisional prerequisites for ${task.id}`]);
      }
      return {branch:task.id,path,baseCommit:await this.git(path,['rev-parse','HEAD'])};
    });
  }
  private async assertCheckout(checkout:TaskCheckout):Promise<void>{
    if(!/^task_[a-zA-Z0-9_-]+$/.test(checkout.branch)||relative(await realpath(join(this.runDir,'worktrees')),await realpath(checkout.path))!==checkout.branch||await this.git(checkout.path,['branch','--show-current'])!==checkout.branch)throw new Error('Checkout is not the task-owned run worktree');
  }
  async submit(checkout:TaskCheckout,candidate:Candidate,repair=false,allowed:TaskFile[]=[]):Promise<CandidateRecord> {
    return this.exclusive(async()=>{
      await this.assertCheckout(checkout);
      if(repair)await this.git(checkout.path,['reset','--hard',checkout.baseCommit]);
      for (const file of candidate.files) {
        if(await Bun.file(join(checkout.path,file.path)).exists()) {const expected=allowed.find(f=>f.path===file.path);if(!expected||contentVersion(await Bun.file(join(checkout.path,file.path)).bytes())!==expected.version)throw new Error(`Candidate would overwrite prerequisite output: ${file.path}`);}
      }
      for (const file of candidate.files) await Bun.write(join(checkout.path,file.path),file.encoding==='base64'?Buffer.from(file.content,'base64'):file.content);
      await this.git(checkout.path,['add','--',...candidate.files.map(file=>file.path)]);
      if(!await this.git(checkout.path,['diff','--cached','--name-only']))throw new Error('No progress: candidate makes no changes');
      await this.git(checkout.path,['commit','-m',`Migrate ${candidate.taskId}\n\nHensei-Task: ${candidate.taskId}`]);
      if (await this.git(checkout.path,['status','--porcelain'])) throw new Error('Candidate worktree is not clean after commit');
      const commit=await this.git(checkout.path,['rev-parse','HEAD']);await this.git(this.repo,['update-ref',`refs/hensei/submissions/${candidate.taskId}/${commit}`,commit]);
      return {...candidate,branch:checkout.branch,worktree:checkout.path,baseCommit:checkout.baseCommit,commit};
    });
  }
  async refresh(checkout:TaskCheckout):Promise<TaskCheckout> {
    return this.exclusive(async()=>{
      await this.assertCheckout(checkout);await this.git(checkout.path,['reset','--hard','integration']);
      return {...checkout,baseCommit:await this.git(checkout.path,['rev-parse','HEAD'])};
    });
  }
  async snapshot(paths:string[]):Promise<Record<string,string|null>> {
    const result:Record<string,string|null>={};
    for(const path of paths)result[path]=await Bun.file(join(this.repo,path)).exists()?await this.fileVersion(path):null;
    return result;
  }
  async changesSince(commit:string):Promise<{head:string;paths:string[];patch:string}> {
    const head=await this.head();
    const paths=(await this.git(this.repo,['diff','--name-only','-z',commit,head],true)).split('\0').filter(Boolean);
    const patch=await this.git(this.repo,['diff','--no-ext-diff','--no-textconv','--unified=3',commit,head],true);
    return {head,paths,patch:patch.slice(-24000)};
  }
  async integrate(candidate:CandidateRecord,check:(path:string)=>Promise<void>,beforePromote?:(commit:string,path:string)=>Promise<void>):Promise<string> {
    return this.integrateMany([candidate],check,beforePromote);
  }
  /** A cycle is checked and promoted as a complete bundle; partial cycle merges are forbidden. */
  async integrateMany(candidates:CandidateRecord[],check:(path:string)=>Promise<void>,beforePromote?:(commit:string,path:string)=>Promise<void>):Promise<string> {
    return this.exclusive(async()=>{
      const head=await this.head(),owners=new Set<string>();
      for(const candidate of candidates) {
        if(candidate.readCommit&&candidate.readCommit!==head)throw new Error('Integration changed since context snapshot; regenerate candidate');
        for(const [path,version] of Object.entries(candidate.targetVersions??{}))if((await Bun.file(join(this.repo,path)).exists()?await this.fileVersion(path):null)!==version)throw new Error(`Stale target preimage: ${path}`);
        if(await this.git(candidate.worktree,['rev-parse','HEAD'])!==candidate.commit||await this.git(candidate.worktree,['status','--porcelain']))throw new Error('Candidate changed after submission');
        const changed=(await this.git(candidate.worktree,['diff','--name-only','-z',candidate.baseCommit,candidate.commit],true)).split('\0').filter(Boolean);
        if(changed.some(path=>!candidate.files.some(f=>f.path===path)))throw new Error('Candidate diff exceeds declared files');
        for(const file of candidate.files) {
          if(owners.has(file.path))throw new Error('Cycle candidates have overlapping output ownership');owners.add(file.path);
          if(contentVersion(await Bun.file(join(candidate.worktree,file.path)).bytes())!==contentVersion(file.encoding==='base64'?Buffer.from(file.content,'base64'):file.content))throw new Error('Candidate manifest differs from committed code');
        }
      }
      const review=join(this.runDir,'evaluations',crypto.randomUUID());await mkdir(join(this.runDir,'evaluations'),{recursive:true});
      await this.git(this.repo,['worktree','add','--detach',review,head]);
      try {
        for(const candidate of candidates)await this.git(review,['merge','--no-ff','--no-edit',candidate.commit]);
        const evaluated=await this.git(review,['rev-parse','HEAD']);await check(review);
        if(await this.git(review,['rev-parse','HEAD'])!==evaluated)throw new Error('Checks changed evaluated HEAD; refuse integration');
        if(await this.git(review,['status','--porcelain']))throw new Error('Checks changed the evaluated tree; refuse integration');
        if(await this.head()!==head)throw new Error('Integration HEAD changed during evaluation');
        await this.git(this.repo,['update-ref',`refs/hensei/evaluated/${evaluated}`,evaluated]);
        await beforePromote?.(evaluated,review);await this.git(this.repo,['merge','--ff-only',evaluated]);return evaluated;
      }finally{await this.git(this.repo,['worktree','remove','--force',review]).catch(()=>{});}
    });
  }

  async promoteEvaluated(commit:string):Promise<void>{await this.exclusive(async()=>{if(!/^[a-f0-9]{40}$/.test(commit))throw new Error('Invalid evaluated commit');await this.git(this.repo,['merge','--ff-only',commit]);});}
  async tree():Promise<string>{return this.git(this.repo,['rev-parse','HEAD^{tree}']);}
  async commitOrder():Promise<string[]>{return (await this.git(this.repo,['rev-list','--first-parent','--reverse','HEAD'])).split('\n');}
  async head():Promise<string>{return this.git(this.repo,['rev-parse','HEAD']);}
  async contains(commit:string):Promise<boolean>{try{await this.git(this.repo,['merge-base','--is-ancestor',commit,'HEAD']);return true;}catch{return false;}}
  async trackedFiles():Promise<string[]>{return (await this.git(this.repo,['ls-files','-z'],true)).split('\0').filter(Boolean);}
  async contextFiles(paths:string[]):Promise<{path:string;content:string}[]>{const result=[];for(const path of paths){const bytes=await Bun.file(join(this.repo,path)).bytes();try{if(!bytes.includes(0))result.push({path,content:new TextDecoder('utf-8',{fatal:true}).decode(bytes)});}catch{}}return result;}
  async fileVersion(path:string):Promise<string>{return contentVersion(await Bun.file(join(this.repo,path)).bytes());}
  async auditTree(check:(path:string)=>Promise<void>):Promise<void>{await this.exclusive(async()=>{
    const head=await this.head(),path=join(this.runDir,'audits',crypto.randomUUID());await mkdir(join(this.runDir,'audits'),{recursive:true});
    await this.git(this.repo,['worktree','add','--detach',path,head]);try{await check(path);
    if(await this.git(path,['rev-parse','HEAD'])!==head||await this.git(path,['status','--porcelain']))throw new Error('Final checks changed audited tree');
    if(await this.head()!==head)throw new Error('Integration changed during final audit');
    }finally{await this.git(this.repo,['worktree','remove','--force',path]).catch(()=>{});}
  });}

}
