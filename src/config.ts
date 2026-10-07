import {parseDocument} from 'yaml';
import {join} from 'node:path';
export interface EvaluationConfig {build:string[]; test:string[]; timeoutSeconds:number; maxAttempts:number}
export interface TargetConfig { language:string; framework?:string; version?:string; workers?:number; evaluation?:EvaluationConfig }
export function parseConfig(text:string): TargetConfig {
  const document=parseDocument(text,{uniqueKeys:true});
  if (document.errors.length) throw new Error('Invalid hensei.yml YAML');
  const config=document.toJS({maxAliasCount:20});
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.target || typeof config.target !== 'object' || Array.isArray(config.target)) throw new Error('hensei.yml requires target.language');
  if (Object.keys(config).some(k=>!['target','agents','evaluation'].includes(k))) throw new Error('Unknown config field; expected target or agents');
  const target=config.target;
  if (Object.keys(target).some(k=>!['language','framework','version'].includes(k))) throw new Error('Unknown target field; expected language, framework, version');
  for (const key of ['language','framework','version']) {
    const value=target[key];
    if (value===undefined && key!=='language') continue;
    if (typeof value!=='string' || !value.trim() || value.length>200) throw new Error(`target.${key} must be a nonempty string (quote version numbers)`);
  }
  const agents=config.agents;
  if (agents!==undefined && (!agents || typeof agents!=='object' || Array.isArray(agents) || Object.keys(agents).some(k=>k!=='workers') || !Number.isInteger(agents.workers) || agents.workers<1 || agents.workers>64)) throw new Error('agents.workers must be an integer from 1 to 64');
  let evaluation:EvaluationConfig|undefined;
  if(config.evaluation!==undefined) {
    const e=config.evaluation;
    if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['build','test','timeoutSeconds','maxAttempts'].includes(k)))throw new Error('Invalid evaluation configuration');
    for(const key of ['build','test'])if(!Array.isArray(e[key])||!e[key].length||e[key].some((arg:unknown)=>typeof arg!=='string'||!arg))throw new Error(`evaluation.${key} must be a nonempty command argument array`);
    const timeoutSeconds=e.timeoutSeconds??60,maxAttempts=e.maxAttempts??2;
    if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>300||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>5)throw new Error('Invalid evaluation timeoutSeconds (1–300) or maxAttempts (1–5)');
    evaluation={build:e.build,test:e.test,timeoutSeconds,maxAttempts};
  }
  return {...(evaluation?{evaluation}:{}),...(agents ? {workers:agents.workers} : {}),language:target.language.trim(),...(target.framework ? {framework:target.framework.trim()} : {}),...(target.version ? {version:target.version.trim()} : {})};
}

export async function loadConfig(destination:string):Promise<TargetConfig> {
  const paths=[join(destination,'hensei.yaml'),join(destination,'hensei.yml')];
  const existing=[];
  for (const path of paths) if (await Bun.file(path).exists()) existing.push(path);
  if (existing.length!==1) throw new Error('Destination must contain exactly one hensei.yaml or hensei.yml');
  return parseConfig(await Bun.file(existing[0]).text());
}
