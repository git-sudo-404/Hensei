import {test,expect} from 'bun:test';
import {Harness,harnessDefaults,retry,agentLoop} from '../src/harness';
import {runLock} from '../src/runlock';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('bounded retry distinguishes transient failures and budget admission is atomic',async()=>{
  let attempts=0;const value=await retry(async()=>{attempts++;if(attempts<3)throw new Error('transient');return 7;},2,()=>true,async()=>{});expect(value).toBe(7);expect(attempts).toBe(3);
  await expect(retry(async()=>{throw new Error('permanent');},5,()=>false,async()=>{})).rejects.toThrow('permanent');
  const harness=new Harness({...harnessDefaults,maxCalls:1},async()=>({content:'{}',inputTokens:2,outputTokens:2}));await harness.call('s','u');await expect(harness.call('s','u')).rejects.toThrow('budget');
});
test('large source uses bounded read pages and rejects paths outside manifests',async()=>{
  let turns=0;const large='x'.repeat(40000)+'IMPORTANT';
  const result=await agentLoop({system:'Review',context:{task:'test'},sources:[{path:'large.ts',content:large}],maxTurns:4,maxBytes:32000,complete:async(_s,u)=>{turns++;if(turns===1){expect(u).not.toContain('IMPORTANT');return {content:'{"action":"read_source","path":".env","offset":0,"length":20}'};}if(turns===2){expect(u).toContain('Invalid read');return {content:'{"action":"read_source","path":"large.ts","offset":40000,"length":9}'};}expect(u).toContain('IMPORTANT');return {content:'{"approved":true}'};}});
  expect(JSON.parse(result).approved).toBe(true);expect(turns).toBe(3);
});
test('destination lock prevents two orchestrators running together',async()=>{
  const dest=await mkdtemp(join(tmpdir(),'hensei-lock-'));try{const release=await runLock(dest);await expect(runLock(dest)).rejects.toThrow('already');await release();const again=await runLock(dest);await again();}finally{await rm(dest,{recursive:true,force:true});}
});
test('concurrent calls reserve the shared token budget before awaiting responses',async()=>{
  let finish!:()=>void;const gate=new Promise<void>(r=>finish=r);let calls=0;
  const harness=new Harness({...harnessDefaults,maxRetries:0,maxOutputTokens:100,maxTotalTokens:150},async()=>{calls++;await gate;return {content:'{}',inputTokens:1,outputTokens:1};});
  const admitted=harness.call('s','u');await expect(harness.call('s','u')).rejects.toThrow('budget');expect(calls).toBe(1);finish();await admitted;
});
test('sandbox commands isolate network, credentials and resources without forwarding host secrets',async()=>{
 const {checkCommand}=await import('../src/evaluator');const argv=checkCommand(['bun','test'],'/tmp/candidate',{image:'local-migration@sha256:abc',cpus:2,memory:'2g',pidsLimit:128});
 expect(argv).toContain('--network=none');expect(argv).toContain('--read-only');expect(argv).toContain('--cap-drop=ALL');expect(argv).toContain('--pull=never');expect(argv).toContain('type=bind,src=/tmp/candidate,dst=/work');expect(argv).not.toContain('--env');expect(argv.slice(-2)).toEqual(['bun','test']);
});
test('workers cannot finalize before every assigned source page was supplied',async()=>{
 let calls=0;const content='x'.repeat(20000),seen:string[]=[];
 const result=await agentLoop({system:'Review',context:{},sources:[{path:'large.ts',content}],maxTurns:6,maxBytes:32000,requireSourceCoverage:['large.ts'],complete:async(_s,u)=>{calls++;seen.push(u);if(calls===1)return {content:'{"done":true}'};if(calls===2)return {content:'{"action":"read_source","path":"large.ts","offset":0,"length":16000}'};if(calls===3)return {content:'{"action":"read_source","path":"large.ts","offset":16000,"length":4000}'};return {content:'{"done":true}'};}});
 expect(JSON.parse(result).done).toBe(true);expect(calls).toBe(4);expect(seen[1]).toContain('Read all assigned source pages');expect(seen.every(u=>Buffer.byteLength(u)<32000)).toBe(true);
});
