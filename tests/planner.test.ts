import {test, expect} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planTasks, validateDraft, deepseekComplete, type Complete} from '../src/planner';
async function fixture(run:(root:string,graphPath:string,output:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'hensei-plan-'));
  try {
    await Bun.write(join(root,'base.ts'),'export const n = 1;');
    await Bun.write(join(root,'app.ts'),'import { n } from "./base"; export const value = n;');
    const graphPath=join(root,'graph.json');
    await Bun.write(graphPath,JSON.stringify({nodes:[{id:'base',source_file:'base.ts'},{id:'app',source_file:'app.ts'}],edges:[{source:'app',target:'base',relation:'imports_from'}]}));
    await run(root,graphPath,join(root,'tasks.json'));
  } finally {await rm(root,{recursive:true,force:true});}
}
const reply: Complete=async (_system,user)=> {
  const context=JSON.parse(user.split('\n')[0]);
  expect(context.sources).toBeUndefined();
  return {content:JSON.stringify({id:context.id,goal:'Migrate to Go preserving behavior',prompt:`Translate ${context.files.map((f:{path:string})=>f.path).join(', ')} into Go and validate public behavior.`,files:context.files})};
};
test('planner publishes versioned tasks in prerequisite-first order',async()=>fixture(async(root,graphPath,output)=> {
  const plan=await planTasks({root,graphPath,output,target:'Go',framework:'Gin',version:'1.24',model:'test',complete:async(s,u)=>{const context=JSON.parse(u.split('\n')[0]); expect(context.targetFramework).toBe('Gin'); expect(context.targetVersion).toBe('1.24');return reply(s,u);}});
  expect(plan.targetFramework).toBe('Gin'); expect(plan.targetVersion).toBe('1.24');
  expect(plan.tasks.map(t=>t.files[0].path)).toEqual(['base.ts','app.ts']);
  expect(plan.tasks[1].dependsOn).toEqual(['task_0001']);
  expect(plan.tasks[0].files[0].version).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(await Bun.file(output).json()).toEqual(plan);
}));
test('invalid JSON gets one correction; fabricated files fail without replacing existing output',async()=>fixture(async(root,graphPath,output)=> {
  let calls=0;
  const retry:Complete=async(s,u)=> ++calls===1 ? {content:'invalid'} : reply(s,u);
  await planTasks({root,graphPath,output,target:'Go',model:'test',complete:retry});
  expect(calls).toBe(3);
  const original=await Bun.file(output).text();
  await expect(planTasks({root,graphPath,output,target:'Go',model:'test',complete:async()=>({content:'{"id":"wrong","goal":"x","prompt":"x","files":[]}'})})).rejects.toThrow('validation');
  expect(await Bun.file(output).text()).toBe(original);
}));
test('source changes prevent publication',async()=>fixture(async(root,graphPath,output)=> {
  const changing:Complete=async(s,u)=>{await Bun.write(join(root,'base.ts'),'changed');return reply(s,u);};
  await expect(planTasks({root,graphPath,output,target:'Go',model:'test',complete:changing})).rejects.toThrow('Source changed');
  expect(await Bun.file(output).exists()).toBe(false);
}));
test('oversized context fails before model calls',async()=>fixture(async(root,graphPath,output)=> {
  const data=await Bun.file(graphPath).json(); data.nodes[0].label='a'.repeat(180001); await Bun.write(graphPath,JSON.stringify(data));
  let calls=0;
  await expect(planTasks({root,graphPath,output,target:'Go',model:'test',complete:async(s,u)=>{calls++;return reply(s,u);}})).rejects.toThrow('Context too large');
  expect(calls).toBe(0);
}));
test('version mismatches, duplicate paths and missing credentials are rejected',()=> {
  const files=[{path:'a.ts',version:'sha256:abc'},{path:'b.ts',version:'sha256:def'}];
  expect(()=>validateDraft(JSON.stringify({id:'task_0001',goal:'x',prompt:'x',files:[files[0],files[0]]}),'task_0001',files)).toThrow();
  expect(()=>validateDraft(JSON.stringify({id:'task_0001',goal:'x',prompt:'x',files:[files[0],{path:'b.ts',version:'wrong'}]}),'task_0001',files)).toThrow();
  expect(()=>deepseekComplete('','test')).toThrow('DEEPSEEK_API_KEY');
});
test('DeepSeek adapter uses JSON mode and rejects truncated responses and HTTP failures', async()=> {
  const original=globalThis.fetch;
  try {
    globalThis.fetch=(async(input: RequestInfo | URL,init?: RequestInit)=> {
      expect(String(input)).toBe('https://api.deepseek.com/chat/completions');
      const body=JSON.parse(String(init?.body));
      expect(body.response_format).toEqual({type:'json_object'});
      expect(body.messages[0].role).toBe('system');
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"goal":"test"}'}}]}));
    }) as unknown as typeof fetch;
    expect((await deepseekComplete('test-key','test-model')('system','context')).content).toBe('{"goal":"test"}');
    globalThis.fetch=(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))) as unknown as typeof fetch;
    await expect(deepseekComplete('test-key','test-model')('s','u')).rejects.toThrow('incomplete');
    globalThis.fetch=(async()=>new Response('sensitive provider body',{status:401})) as unknown as typeof fetch;
    await expect(deepseekComplete('test-key','test-model')('s','u')).rejects.toThrow('HTTP 401');
    globalThis.fetch=(async()=>{throw new Error('network details');}) as unknown as typeof fetch;
    await expect(deepseekComplete('test-key','test-model')('s','u')).rejects.toThrow('connection failed');
  } finally {globalThis.fetch=original;}
});
