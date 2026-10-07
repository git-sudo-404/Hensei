import {parseDocument} from 'yaml';
export interface TargetConfig { language:string; framework?:string; version?:string }
export function parseConfig(text:string): TargetConfig {
  const document=parseDocument(text,{uniqueKeys:true});
  if (document.errors.length) throw new Error('Invalid hensei.yml YAML');
  const config=document.toJS({maxAliasCount:20});
  if (!config || typeof config !== 'object' || Array.isArray(config) || !config.target || typeof config.target !== 'object' || Array.isArray(config.target)) throw new Error('hensei.yml requires target.language');
  if (Object.keys(config).some(k=>k!=='target')) throw new Error('Unknown hensei.yml field; expected target');
  const target=config.target;
  if (Object.keys(target).some(k=>!['language','framework','version'].includes(k))) throw new Error('Unknown target field; expected language, framework, version');
  for (const key of ['language','framework','version']) {
    const value=target[key];
    if (value===undefined && key!=='language') continue;
    if (typeof value!=='string' || !value.trim() || value.length>200) throw new Error(`target.${key} must be a nonempty string (quote version numbers)`);
  }
  return {language:target.language.trim(),...(target.framework ? {framework:target.framework.trim()} : {}),...(target.version ? {version:target.version.trim()} : {})};
}
