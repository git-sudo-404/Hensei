import {safePath} from './paths';
export interface RepositoryConfig {
 mode:'local'|'source'|'new'; url?:string; create?:boolean; private?:boolean;
 baseBranch?:string; migrationBranch?:string; outputDirectory?:string;
}
export function githubSlug(url:string):string {
 const match=/^(?:https:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
 if(!match||['.','..'].includes(match[2]))throw new Error('repository.url must identify a GitHub owner/repository without credentials');
 return `${match[1]}/${match[2]}`;
}
export function safeBranch(value:string):boolean {
 return typeof value==='string'&&value.length<=200&&/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value)&&!value.includes('..')&&!value.endsWith('.')&&!value.split('/').some(s=>!s||s.endsWith('.lock')||s.startsWith('.'));
}
export function parseRepository(raw:unknown):RepositoryConfig {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid repository config');const r=raw as Record<string,unknown>;
 if(Object.keys(r).some(k=>!['mode','url','create','private','baseBranch','migrationBranch','outputDirectory'].includes(k))||!['local','source','new'].includes(String(r.mode)))throw new Error('repository.mode must be local, source, or new');
 if(r.url!==undefined){if(typeof r.url!=='string')throw new Error('Invalid repository.url');githubSlug(r.url);}
 if(r.mode==='new'&&!r.url)throw new Error('New repository mode requires repository.url');
 for(const k of ['create','private'])if(r[k]!==undefined&&typeof r[k]!=='boolean')throw new Error(`repository.${k} must be boolean`);
 if(r.create&&r.mode!=='new')throw new Error('Only new repository mode can create a repository');
 for(const k of ['baseBranch','migrationBranch'])if(r[k]!==undefined&&!safeBranch(r[k] as string))throw new Error(`Unsafe repository.${k}`);
 if(r.baseBranch&&r.baseBranch===r.migrationBranch)throw new Error('Migration branch must differ from baseBranch');
 if(r.outputDirectory!==undefined&&(typeof r.outputDirectory!=='string'||(r.outputDirectory!=='.'&&!safePath(r.outputDirectory))))throw new Error('Unsafe repository.outputDirectory');
 if(r.mode==='source'&&r.outputDirectory==='.')throw new Error('Source mode requires a dedicated outputDirectory to preserve source files');
 if(r.mode==='local'&&Object.keys(r).length>1)throw new Error('Local repository mode cannot publish');
 return r as unknown as RepositoryConfig;
}
