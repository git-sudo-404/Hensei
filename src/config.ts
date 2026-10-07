import {parseRepository,type RepositoryConfig} from './repository';
import {parseDocument} from 'yaml';
import {join} from 'node:path';
import {harnessDefaults,type HarnessConfig} from './harness';
export interface SandboxConfig {image:string;cpus:number;memory:string;pidsLimit:number}
export interface EvaluationConfig {build:string[]; test:string[]; timeoutSeconds:number; maxAttempts:number;finalBuild?:string[];finalTest?:string[];sandbox?:SandboxConfig}
export interface TargetConfig { language:string; framework?:string; version?:string; workers?:number; maxRetries?:number; evaluation?:EvaluationConfig; runtime?:HarnessConfig; orchestration?:{maxRounds:number}; coverage?:{exclude:string[]};repository?:RepositoryConfig }
export function parseConfig(text:string): TargetConfig {
  const document=parseDocument(text,{uniqueKeys:true});
  if (document.errors.length) throw new Error('Invalid hensei.yml YAML');
  const config=document.toJS({maxAliasCount:20});
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.target || typeof config.target !== 'object' || Array.isArray(config.target)) throw new Error('hensei.yml requires target.language');
  if (Object.keys(config).some(k=>!['target','agents','evaluation','runtime','orchestration','coverage','repository'].includes(k))) throw new Error('Unknown config field; expected target or agents');
  const target=config.target;
  if (Object.keys(target).some(k=>!['language','framework','version'].includes(k))) throw new Error('Unknown target field; expected language, framework, version');
  for (const key of ['language','framework','version']) {
    const value=target[key];
    if (value===undefined && key!=='language') continue;
    if (typeof value!=='string' || !value.trim() || value.length>200) throw new Error(`target.${key} must be a nonempty string (quote version numbers)`);
  }
  const agents=config.agents;
  if (agents!==undefined && (!agents || typeof agents!=='object' || Array.isArray(agents) || Object.keys(agents).some(k=>!['workers','maxRetries'].includes(k)) || !Number.isInteger(agents.workers) || agents.workers<1 || agents.workers>64)) throw new Error('agents.workers must be an integer from 1 to 64');
  if(agents?.maxRetries!==undefined&&(!Number.isInteger(agents.maxRetries)||agents.maxRetries<0||agents.maxRetries>10))throw new Error('agents.maxRetries must be 0–10 repair returns');
  let evaluation:EvaluationConfig|undefined;
  if(config.evaluation!==undefined) {
    const e=config.evaluation;
    if(!e||typeof e!=='object'||Array.isArray(e)||Object.keys(e).some(k=>!['build','test','finalBuild','finalTest','timeoutSeconds','maxAttempts','sandbox'].includes(k)))throw new Error('Invalid evaluation configuration');
    for(const key of ['build','test'])if(!Array.isArray(e[key])||!e[key].length||e[key].some((arg:unknown)=>typeof arg!=='string'||!arg))throw new Error(`evaluation.${key} must be a nonempty command argument array`);
    const timeoutSeconds=e.timeoutSeconds??60,maxAttempts=e.maxAttempts??((agents?.maxRetries??3)+1);
    if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>300||!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>11)throw new Error('Invalid evaluation timeoutSeconds (1–300) or maxAttempts (1–11)');
    for(const key of ['finalBuild','finalTest'])if(e[key]!==undefined&&(!Array.isArray(e[key])||!e[key].length||e[key].some((a:unknown)=>typeof a!=='string'||!a)))throw new Error(`Invalid evaluation.${key}`);
    if(e.maxAttempts!==undefined&&agents?.maxRetries!==undefined)throw new Error('Use agents.maxRetries or legacy evaluation.maxAttempts, not both');
    let sandbox:SandboxConfig|undefined;
    if(e.sandbox!==undefined){const b=e.sandbox;if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['image','cpus','memory','pidsLimit'].includes(k))||typeof b.image!=='string'||!/^[-a-zA-Z0-9_./:@]+$/.test(b.image)||b.image.startsWith('-'))throw new Error('Invalid sandbox image');sandbox={image:b.image,cpus:b.cpus??2,memory:b.memory??'2g',pidsLimit:b.pidsLimit??128};if(typeof sandbox.cpus!=='number'||sandbox.cpus<0.1||sandbox.cpus>64||!/^([1-9][0-9]*)(m|g)$/.test(sandbox.memory)||!Number.isInteger(sandbox.pidsLimit)||sandbox.pidsLimit<16||sandbox.pidsLimit>4096)throw new Error('Invalid sandbox resource limits');}
    evaluation={...(sandbox?{sandbox}:{}),build:e.build,test:e.test,timeoutSeconds,maxAttempts,...(e.finalBuild?{finalBuild:e.finalBuild}:{}),...(e.finalTest?{finalTest:e.finalTest}:{})};
  }
  let runtime:HarnessConfig|undefined,orchestration:{maxRounds:number}|undefined,coverage:{exclude:string[]}|undefined;
  if(config.runtime!==undefined) {
    if(!config.runtime||typeof config.runtime!=='object'||Array.isArray(config.runtime)||Object.keys(config.runtime).some(k=>!(k in harnessDefaults)))throw new Error('Invalid runtime config');
    runtime={...harnessDefaults,...config.runtime} as HarnessConfig;
    for(const [key,value] of Object.entries(runtime))if(!Number.isInteger(value)||value<0)throw new Error(`Invalid runtime.${key}`);
    if(runtime.maxCalls<1||runtime.maxInputBytes<32000||runtime.maxInputBytes>1000000||runtime.maxOutputTokens<256||runtime.maxOutputTokens>32768||runtime.maxTotalTokens<1||runtime.maxRetries>5||runtime.maxTurns<1||runtime.maxTurns>200)throw new Error('Runtime limits out of bounds');
  }
  if(config.orchestration!==undefined) {
    const o=config.orchestration;if(!o||typeof o!=='object'||Object.keys(o).some(k=>k!=='maxRounds')||!Number.isInteger(o.maxRounds)||o.maxRounds<0||o.maxRounds>10)throw new Error('orchestration.maxRounds must be 0–10');orchestration={maxRounds:o.maxRounds};
  }
  if(config.coverage!==undefined) {
    const c=config.coverage;if(!c||typeof c!=='object'||Object.keys(c).some(k=>k!=='exclude')||!Array.isArray(c.exclude)||c.exclude.some((p:unknown)=>typeof p!=='string'||!p))throw new Error('coverage.exclude must be a glob array');coverage={exclude:c.exclude};
  }
  return {...(config.repository!==undefined?{repository:parseRepository(config.repository)}:{}),...(runtime?{runtime}:{}),...(orchestration?{orchestration}:{}),...(coverage?{coverage}:{}),...(evaluation?{evaluation}:{}),...(agents ? {workers:agents.workers,...(agents.maxRetries!==undefined?{maxRetries:agents.maxRetries}:{})} : {}),language:target.language.trim(),...(target.framework ? {framework:target.framework.trim()} : {}),...(target.version ? {version:target.version.trim()} : {})};
}

export async function loadConfig(destination:string):Promise<TargetConfig> {
  const paths=[join(destination,'hensei.yaml'),join(destination,'hensei.yml')];
  const existing=[];
  for (const path of paths) if (await Bun.file(path).exists()) existing.push(path);
  if (existing.length!==1) throw new Error('Destination must contain exactly one hensei.yaml or hensei.yml');
  return parseConfig(await Bun.file(existing[0]).text());
}
