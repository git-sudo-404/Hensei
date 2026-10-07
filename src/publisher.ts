import {mkdir,readdir} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicJson} from './storage';
import {githubSlug,type RepositoryConfig} from './repository';
import {safePath} from './paths';
import type {CandidateRecord} from './worktrees';
import type {CheckResult,Verdict} from './evaluator';
export type Command=(args:string[],cwd:string)=>Promise<string>;
export async function command(args:string[],cwd:string):Promise<string> {
 const env:Record<string,string|undefined>={...process.env,GIT_TERMINAL_PROMPT:'0',GH_PROMPT_DISABLED:'1'};delete env.DEEPSEEK_API_KEY;if(args[0]==='git'){for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});}
 const p=Bun.spawn(args,{cwd,env,stdin:'ignore',stdout:'pipe',stderr:'pipe',detached:process.platform!=='win32'});
 const kill=()=>{try{if(process.platform==='win32')p.kill('SIGKILL');else process.kill(-p.pid,'SIGKILL');}catch{}};
 const timer=setTimeout(kill,120000);
 try{const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);if(code!==0)throw new Error(`${args[0]} ${args[1]??''} failed: ${err.slice(-4000)}`);return out.trim();}finally{clearTimeout(timer);kill();}
}
export interface Publication {
 url:string;repository:string;baseBranch:string;headBranch:string;headCommit:string;mergeCommit:string;
 checkedCommit:string;targetTree:string;state:'MERGED';
}
interface Transaction {key:string;checkedCommit:string;checkedCommits?:string[];targetTree:string;headBranch:string;headCommit?:string;baseCommit?:string;url?:string;mergeCommit?:string;state:'PREPARED'|'OPEN'|'MERGED';taskIds:string[]}
interface State {slug:string;branch:string;directory:string;baseCommit:string}
/** Publication is serialized by the evaluator. Only the already-reviewed, tested target tree enters a PR. */
export class Publisher {
 readonly repo:string;private state!:State;
 constructor(readonly runDir:string,private sourceRoot:string,private config:RepositoryConfig,private run:Command=command,private onPR?:(url:string)=>Promise<void>){this.repo=join(runDir,'publication','repo');}
 private git(cwd:string,args:string[]):Promise<string>{return this.run(['git','-c','http.version=HTTP/1.1','-c','http.postBuffer=157286400','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Hensei','-c','user.email=hensei@localhost','-c','credential.helper=','-c','credential.https://github.com.helper=!gh auth git-credential',...args],cwd);}
 private gh(args:string[]):Promise<string>{return this.run(['gh',...args],this.runDir);}
 private get statePath(){return join(this.runDir,'publication','state.json');}
 private transactionPath(key:string){return join(this.runDir,'publication','transactions',key+'.json');}
 async initialize():Promise<void> {
  await mkdir(join(this.runDir,'publication'),{recursive:true});
  if(await Bun.file(this.statePath).exists()) {
   this.state=await Bun.file(this.statePath).json();if(!await this.git(this.repo,['ls-remote','--heads','origin',`refs/heads/${this.state.branch}`]))await this.git(this.repo,['push','origin',`${this.state.baseCommit}:refs/heads/${this.state.branch}`]);await this.fetchBase();return;
  }
  let url=this.config.url;
  if(this.config.mode==='source') {
   const origin=await this.git(this.sourceRoot,['remote','get-url','origin']);const sourceSlug=githubSlug(origin);
   if(url&&githubSlug(url).toLowerCase()!==sourceSlug.toLowerCase())throw new Error('Source mode repository.url differs from source origin');url=sourceSlug;
  }
  if(!url)throw new Error('Missing publication repository');const slug=githubSlug(url);
  let info:{isEmpty:boolean;defaultBranchRef?:{name:string}};
  try{info=JSON.parse(await this.gh(['repo','view',slug,'--json','isEmpty,defaultBranchRef']));}
  catch(error){if(!this.config.create)throw error;await this.gh(['repo','create',slug,this.config.private===false?'--public':'--private']);info={isEmpty:true};}
  const branch=this.config.migrationBranch??`hensei/migration-${basename(this.runDir)}`,directory=this.config.outputDirectory??(this.config.mode==='source'?'migration':'.');
  const base=this.config.baseBranch??info.defaultBranchRef?.name??'main';if(branch===base)throw new Error('Refuse migration into original base branch');
  if(!await Bun.file(join(this.repo,'.git','HEAD')).exists())await this.git(this.runDir,['clone','--no-checkout',`https://github.com/${slug}.git`,this.repo]);
  let baseCommit:string;
  if(info.isEmpty){
   // Retain the initial commit before any remote write, including failures before state.json.
   try{baseCommit=await this.git(this.repo,['rev-parse','--verify','refs/hensei/publication-base']);}
   catch{const emptyTree=await this.git(this.repo,['mktree']);baseCommit=await this.git(this.repo,['commit-tree',emptyTree,'-m','Initialize migration destination']);await this.git(this.repo,['update-ref','refs/hensei/publication-base',baseCommit]);}
   if(await this.git(this.repo,['ls-tree','-r','--name-only',baseCommit]))throw new Error('Initial publication base must be empty');
   await this.git(this.repo,['push','origin',`${baseCommit}:refs/heads/${base}`]);
  }else{await this.git(this.repo,['fetch','origin',`refs/heads/${base}:refs/remotes/origin/publication-base`]);baseCommit=await this.git(this.repo,['rev-parse','refs/remotes/origin/publication-base']);}
  const existing=await this.git(this.repo,['ls-remote','--heads','origin',`refs/heads/${branch}`]);if(existing)throw new Error('Migration branch already exists; resume its owning run or choose a fresh branch');
  await this.git(this.repo,['checkout','--detach',baseCommit]);
  const paths=(await this.git(this.repo,['ls-tree','-r','--name-only','-z',baseCommit])).split('\0').filter(Boolean);
  if(paths.some(path=>directory==='.'||path===directory||path.startsWith(directory+'/')||directory.startsWith(path+'/')))throw new Error('Publication output directory is not empty or has a file/symlink ancestor; choose a fresh directory');
  this.state={slug,branch,directory,baseCommit};await atomicJson(this.statePath,this.state);
  await this.git(this.repo,['push','origin',`${baseCommit}:refs/heads/${branch}`]);await this.fetchBase();
 }
 private async fetchBase():Promise<string>{await this.git(this.repo,['fetch','origin',`refs/heads/${this.state.branch}:refs/remotes/origin/migration`]);return this.git(this.repo,['rev-parse','refs/remotes/origin/migration']);}
 private async tree(commit:string):Promise<string>{return this.git(this.repo,['rev-parse',this.state.directory==='.'?`${commit}^{tree}`:`${commit}:${this.state.directory}`]);}
 private async getPR(url:string):Promise<{state:string;headRefOid:string;mergeCommit?:{oid:string};baseRefName:string}>{return JSON.parse(await this.gh(['pr','view',url,'--repo',this.state.slug,'--json','state,headRefOid,mergeCommit,baseRefName']));}
 private publication(tx:Transaction,checkedCommit=tx.checkedCommit):Publication{return {url:tx.url!,repository:`https://github.com/${this.state.slug}`,baseBranch:this.state.branch,headBranch:tx.headBranch,headCommit:tx.headCommit!,mergeCommit:tx.mergeCommit!,checkedCommit,targetTree:tx.targetTree,state:'MERGED'};}
 async publish(checkedCommit:string,checkedPath:string,candidates:CandidateRecord[],verdict:Verdict,checks:CheckResult[],localRepo:string):Promise<Publication> {
  if(!verdict.approved||checks.length!==2||checks.some(c=>!c.passed))throw new Error('Publication requires approved review and passing checks');
  const targetTree=await this.git(localRepo,['rev-parse',`${checkedCommit}^{tree}`]);
  const ids=candidates.map(c=>c.taskId).sort(),key=createHash('sha256').update(JSON.stringify([ids,targetTree])).digest('hex');
  let tx:Transaction=await Bun.file(this.transactionPath(key)).exists()?await Bun.file(this.transactionPath(key)).json():{key,checkedCommit,targetTree,taskIds:ids,headBranch:`hensei/${basename(this.runDir)}/${ids[0]}/${key.slice(0,12)}`,state:'PREPARED'};
  // A resumed evaluation can recreate the same tree with a different local commit.
  // Retain every checked commit so its durable receipt can recover the existing PR.
  tx.checkedCommits=[...new Set([tx.checkedCommit,...(tx.checkedCommits??[]),checkedCommit])];await atomicJson(this.transactionPath(key),tx);
  if(tx.state==='MERGED')return this.verify(tx,checkedCommit);
  const base=await this.fetchBase();
  if(tx.baseCommit&&base!==tx.baseCommit&&tx.url){const remote=await this.getPR(tx.url);if(remote.state==='MERGED'&&remote.mergeCommit){tx.mergeCommit=remote.mergeCommit.oid;tx.state='MERGED';await atomicJson(this.transactionPath(key),tx);return this.verify(tx,checkedCommit);}throw new Error('Remote migration branch changed before approval; refuse stale PR merge');}
  if(!tx.headCommit) {
   await this.git(this.repo,['checkout','--detach',base]);const outputs=new Set<string>();
   for(const candidate of candidates)for(const file of candidate.files){if(!safePath(file.path)||outputs.has(file.path))throw new Error('Invalid publication file scope');outputs.add(file.path);const path=this.state.directory==='.'?file.path:`${this.state.directory}/${file.path}`;await Bun.write(join(this.repo,path),await Bun.file(join(checkedPath,file.path)).bytes());}
   const changed=(await this.git(this.repo,['diff','--name-only','-z'])).split('\0').filter(Boolean);const untracked=(await this.git(this.repo,['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
   const allowed=new Set([...outputs].map(path=>this.state.directory==='.'?path:`${this.state.directory}/${path}`));if([...changed,...untracked].some(path=>!allowed.has(path)))throw new Error('Publication diff exceeds approved task scope');
   await this.git(this.repo,['add','--',...allowed]);await this.git(this.repo,['commit','-m',`Migrate ${ids.join(', ')}`]);
   tx.headCommit=await this.git(this.repo,['rev-parse','HEAD']);tx.baseCommit=base;
   if(await this.tree(tx.headCommit)!==targetTree)throw new Error('Published project tree differs from exact tested target tree');
   await atomicJson(this.transactionPath(key),tx);
  }
  await this.git(this.repo,['push','origin',`${tx.headCommit}:refs/heads/${tx.headBranch}`]);
  if(!tx.url) {
   const existing=JSON.parse(await this.gh(['pr','list','--repo',this.state.slug,'--head',tx.headBranch,'--base',this.state.branch,'--state','all','--json','url']));
   if(existing.length)tx.url=existing[0].url;
   else {
    const body=join(this.runDir,'publication',key+'.md');await Bun.write(body,`Migrates ${ids.join(', ')} into the configured destination project.\n\nIndependent evaluator approved the candidate. Required build and behavior checks passed on target tree ${targetTree}. Source-file scope and current versions were verified.\n\n${candidates.map(c=>`- ${c.taskId}: ${c.summary.slice(0,500)}`).join('\n')}\n`);
    tx.url=await this.gh(['pr','create','--repo',this.state.slug,'--base',this.state.branch,'--head',tx.headBranch,'--title',`Hensei: migrate ${ids.join(', ')}`.slice(0,200),'--body-file',body]);
   }
   tx.state='OPEN';await atomicJson(this.transactionPath(key),tx);await this.onPR?.(tx.url!);
  }
  const remote=await this.getPR(tx.url!);
  if(remote.headRefOid!==tx.headCommit||remote.baseRefName!==this.state.branch)throw new Error('PR refs changed after publication');
  if(remote.state!=='MERGED') {
   if(await this.fetchBase()!==tx.baseCommit)throw new Error('Remote base changed; refuse stale PR');
   // Never --admin, --auto or squash: respect protection and require the exact reviewed head.
   await this.gh(['pr','merge',tx.url!,'--repo',this.state.slug,'--merge','--match-head-commit',tx.headCommit!]);
  }
  const merged=await this.getPR(tx.url!);if(merged.state!=='MERGED'||!merged.mergeCommit)throw new Error('PR is not merged; branch protection or a merge queue may need attention');
  tx.mergeCommit=merged.mergeCommit.oid;tx.state='MERGED';await atomicJson(this.transactionPath(key),tx);return this.verify(tx,checkedCommit);
 }
 private async verify(tx:Transaction,checkedCommit=tx.checkedCommit):Promise<Publication> {
  const remote=await this.getPR(tx.url!);if(remote.state!=='MERGED'||remote.headRefOid!==tx.headCommit||remote.baseRefName!==this.state.branch||remote.mergeCommit?.oid!==tx.mergeCommit)throw new Error('Merged PR does not match the approved publication');
  const head=await this.fetchBase();await this.git(this.repo,['merge-base','--is-ancestor',tx.mergeCommit!,head]);
  if(await this.tree(tx.mergeCommit!)!==tx.targetTree)throw new Error('GitHub merged tree differs from tested target tree');return this.publication(tx,checkedCommit);
 }
 async recover(checkedCommit:string):Promise<Publication|undefined> {
  const directory=join(this.runDir,'publication','transactions');let files:string[];try{files=await readdir(directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  for(const file of files.filter(f=>f.endsWith('.json'))){const tx=await Bun.file(join(directory,file)).json() as Transaction;if(tx.checkedCommit!==checkedCommit&&!tx.checkedCommits?.includes(checkedCommit)||!tx.url)continue;const pr=await this.getPR(tx.url);if(pr.state==='MERGED'&&pr.mergeCommit){tx.state='MERGED';tx.mergeCommit=pr.mergeCommit.oid;await atomicJson(this.transactionPath(tx.key),tx);return this.verify(tx,checkedCommit);}}
 }
 async audit(localTree:string):Promise<void>{const head=await this.fetchBase();if(await this.tree(head)!==localTree)throw new Error('Remote final target tree differs from locally audited migration');}
 summary(){return {repository:`https://github.com/${this.state.slug}`,migrationBranch:this.state.branch,outputDirectory:this.state.directory};}
}
