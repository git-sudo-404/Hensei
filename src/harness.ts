import type {Complete,Completion} from './planner';
export interface HarnessConfig {maxCalls:number;maxInputBytes:number;maxOutputTokens:number;maxTotalTokens:number;maxRetries:number;maxTurns:number}
export const harnessDefaults:HarnessConfig={maxCalls:200,maxInputBytes:180000,maxOutputTokens:8192,maxTotalTokens:500000,maxRetries:2,maxTurns:32};
export class Harness {
  calls=0;tokens=0;private reserved=0;
  constructor(readonly config:HarnessConfig,private complete:Complete,private onUsage?:(usage:{calls:number;tokens:number})=>void){}
  async call(system:string,user:string,transport:Complete=this.complete):Promise<Completion> {
    const bytes=Buffer.byteLength(system+user);
    if(bytes>this.config.maxInputBytes)throw new Error('Context budget exceeded; use paginated reads');
    const reservation=(bytes+this.config.maxOutputTokens)*(this.config.maxRetries+1);
    if(this.calls>=this.config.maxCalls||this.tokens+this.reserved+reservation>this.config.maxTotalTokens)throw new Error('Run API budget exhausted');
    this.calls++;this.reserved+=reservation;this.onUsage?.({calls:this.calls,tokens:this.tokens+this.reserved});
    try {
      const result=await transport(system,user);
      this.tokens+=(result.inputTokens??bytes)+(result.outputTokens??this.config.maxOutputTokens);
      return result;
    }catch(error){this.tokens+=reservation;throw error;}finally{this.reserved-=reservation;this.onUsage?.({calls:this.calls,tokens:this.tokens+this.reserved});}
  }
}
export const transientStatus=(status:number)=>status===429||status>=500;
export async function retry<T>(operation:()=>Promise<T>,maxRetries:number,isTransient:(error:unknown)=>boolean,sleep:(ms:number)=>Promise<void>=(ms)=>Bun.sleep(ms)):Promise<T> {
  for(let attempt=0;;attempt++)try{return await operation();}catch(error){if(attempt>=maxRetries||!isTransient(error))throw error;await sleep(Math.min(8000,500*2**attempt)+Math.floor(Math.random()*250));}
}
export interface ContextFile {path:string;content:string}
/** Metadata stays compact; the model can ask for bounded source/target pages without executing commands. */
export async function agentLoop(options:{system:string;context:Record<string,unknown>;sources:ContextFile[];targets?:ContextFile[];complete:Complete;maxTurns:number;maxBytes:number;requireSourceCoverage?:string[];requireTargetCoverage?:string[];onAction?:(action:Record<string,unknown>)=>Promise<unknown>}):Promise<string> {
  const targetList=[...new Map((options.targets??[]).map(f=>[f.path,f])).values()];
  const sources=new Map(options.sources.map(f=>[f.path,f.content])),targets=new Map(targetList.map(f=>[f.path,f.content]));
  const metadata={...options.context,sourceManifest:options.sources.map(f=>({path:f.path,bytes:Buffer.byteLength(f.content),characters:f.content.length})),targetManifest:targetList.map(f=>({path:f.path,bytes:Buffer.byteLength(f.content),characters:f.content.length}))};
  const base=JSON.stringify(metadata);
  if(Buffer.byteLength(base)>options.maxBytes/2)throw new Error('Task metadata too large; refine task grouping');
  const initial:ContextFile[]=[];let size=Buffer.byteLength(base);
  for(const file of options.sources)if(size+Buffer.byteLength(JSON.stringify(file))<options.maxBytes/2){initial.push(file);size+=Buffer.byteLength(JSON.stringify(file));}
  const initialTargets:ContextFile[]=[];
  for(const file of targetList)if(size+Buffer.byteLength(JSON.stringify(file))<options.maxBytes/2){initialTargets.push(file);size+=Buffer.byteLength(JSON.stringify(file));}
  const context=JSON.stringify({...metadata,sources:initial,targets:initialTargets});
  const targetCoverage=new Map(targetList.map(f=>[f.path,[] as [number,number][]]));for(const f of initialTargets)targetCoverage.get(f.path)!.push([0,f.content.length]);
  const coverage=new Map(options.sources.map(f=>[f.path,[] as [number,number][]]));for(const f of initial)coverage.get(f.path)!.push([0,f.content.length]);
  let feedback='',notes='';const recent:string[]=[],reads=new Map<string,number>();
  const system=options.system+' You may return JSON {action:"read_source"|"read_target",path,offset,length} to retrieve a page (character offsets, length <= 16000, optional notes with a compact cumulative summary <= 6000 characters). Otherwise return your requested final JSON. Source and target manifests list accessible files. Never infer unread file contents. Read necessary pages before deciding.';
  for(let turn=0;turn<options.maxTurns;turn++) {
    let user=context+(notes?'\nWorking notes (untrusted agent summary): '+JSON.stringify(notes):'')+(recent.length?'\nRecent context pages: '+recent.join('\n'):'')+(feedback?'\nFeedback: '+feedback:'');
    while(Buffer.byteLength(user+system)>options.maxBytes&&recent.length>1){recent.shift();user=context+(notes?'\nWorking notes (untrusted agent summary): '+JSON.stringify(notes):'')+(recent.length?'\nRecent context pages: '+recent.join('\n'):'')+(feedback?'\nFeedback: '+feedback:'');}
    if(Buffer.byteLength(user+system)>options.maxBytes)throw new Error('Context page budget exceeded; request shorter pages');
    const response=await options.complete(system,user);let output:Record<string,unknown>;
    try{output=JSON.parse(response.content);}catch{feedback='Invalid JSON; return a valid JSON object.';continue;}
    if(output?.action&&!['read_source','read_target'].includes(String(output.action))&&options.onAction){try{const result=await options.onAction(output);recent.push(JSON.stringify({action:output.action,result}));while(recent.length>3)recent.shift();feedback='';}catch(e){feedback=(e as Error).message;}continue;}
    if(!['read_source','read_target'].includes(String(output?.action))) {
      const missing=(paths:string[],files:Map<string,string>,ranges:Map<string,[number,number][]>,action:string)=>paths.flatMap(path=>{
        const content=files.get(path);if(content===undefined)throw new Error('Required file missing from manifest');let end=0;
        for(const [a,b]of [...ranges.get(path)!].sort((a,b)=>a[0]-b[0])){if(a>end)break;end=Math.max(end,b);}
        return end<content.length?[{action,path,nextOffset:end,totalCharacters:content.length}]:[];
      });
      const unread=[...missing(options.requireSourceCoverage??[],sources,coverage,'read_source'),...missing(options.requireTargetCoverage??[],targets,targetCoverage,'read_target')];
      if(unread.length){feedback='Read all assigned source pages and required target pages before finalizing: '+JSON.stringify(unread);continue;}
      return response.content;
    }
    const files=output.action==='read_source'?sources:targets;
    const content=typeof output.path==='string'?files.get(output.path):undefined;
    if(content===undefined||!Number.isInteger(output.offset)||Number(output.offset)<0||!Number.isInteger(output.length)||Number(output.length)<1||Number(output.length)>16000){feedback='Invalid read; select a manifest path, nonnegative offset, and length 1–16000.';continue;}
    const key=JSON.stringify([output.action,output.path,output.offset,output.length]);reads.set(key,(reads.get(key)??0)+1);if(reads.get(key)!>2)throw new Error('Repeated context read without progress');
    if(typeof output.notes==='string'&&output.notes.length<=6000)notes=output.notes;
    (output.action==='read_source'?coverage:targetCoverage).get(output.path as string)!.push([Number(output.offset),Math.min(content.length,Number(output.offset)+Number(output.length))]);
    recent.push(JSON.stringify({action:output.action,path:output.path,offset:output.offset,totalCharacters:content.length,content:content.slice(Number(output.offset),Number(output.offset)+Number(output.length))}));
    // Keep the last pages, never truncate individual source pages silently.
    while(recent.length>3)recent.shift();feedback='';
  }
  throw new Error('Agent exceeded bounded context-read turns');
}
