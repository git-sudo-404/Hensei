import {readdir,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export interface SourceEntry {path:string;version:string;binary:boolean;bytes:number}
export interface Inventory {files:SourceEntry[];excluded:{path:string;reason:string}[]}
const infrastructure=new Set(['.git','node_modules','.hensei','.venv','__pycache__']);
export const contentVersion=(bytes:string|Uint8Array)=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function inventory(root:string,excludes:string[]=[]):Promise<Inventory> {
  root=await realpath(root);const globs=excludes.map(pattern=>new Bun.Glob(pattern));const files:SourceEntry[]=[],excluded:Inventory['excluded']=[],stack=[''];
  while(stack.length) {
    const directory=stack.pop()!;
    for(const entry of await readdir(join(root,directory),{withFileTypes:true})) {
      const path=[directory,entry.name].filter(Boolean).join('/');
      if(infrastructure.has(entry.name)||entry.name==='.env'||entry.name.startsWith('.env.')){excluded.push({path,reason:'VCS/dependency cache/runtime metadata/secret environment file'});continue;}
      if(globs.some(glob=>glob.match(path))){excluded.push({path,reason:'User-configured coverage.exclude'});continue;}
      if(entry.isSymbolicLink())throw new Error(`Source symlink needs explicit coverage exclusion: ${path}`);
      if(entry.isDirectory()){stack.push(path);continue;}
      if(!entry.isFile())throw new Error(`Unsupported source entry: ${path}`);
      const bytes=await Bun.file(join(root,path)).bytes();
      let binary=bytes.includes(0);try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{binary=true;}
      files.push({path,version:contentVersion(bytes),binary,bytes:bytes.length});
    }
  }
  return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),excluded:excluded.sort((a,b)=>a.path.localeCompare(b.path))};
}
export async function assertSnapshot(root:string,snapshot:Inventory,excludes:string[]):Promise<void> {
  const current=await inventory(root,excludes);
  if(JSON.stringify(current)!==JSON.stringify(snapshot))throw new Error('Source inventory changed during migration; start a new plan');
}
