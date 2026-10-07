import {mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {inventory} from '../src/inventory';
import {buildLayers} from '../src/layers';
// Synthetic local stress test; it performs no model calls and is not a migration-quality benchmark.
const root=resolve('artifacts/scalability-source');await mkdir(root,{recursive:true});
const count=1000,linesPerFile=1000;
for(let file=0;file<count;file++)await Bun.write(join(root,`file_${file}.ts`),Array.from({length:linesPerFile},(_,line)=>`export function fn_${line}(){return ${line};}`).join('\n')+'\n');
const started=performance.now(),snapshot=await inventory(root),inventoryMs=performance.now()-started;
const graph={files:snapshot.files.map(f=>f.path),dependencies:snapshot.files.slice(1).map((f,index)=>({dependent:f.path,prerequisite:snapshot.files[index].path})),warnings:[]};
const orderStarted=performance.now(),order=buildLayers(graph),orderMs=performance.now()-orderStarted;
const result={synthetic:true,cacheState:'freshly written source files (warm cache)',modelCalls:0,files:count,lines:count*linesPerFile,bytes:snapshot.files.reduce((n,f)=>n+f.bytes,0),inventoryMs,orderMs,layers:order.layers.length,rssBytes:process.memoryUsage().rss};
await Bun.write(resolve('artifacts/scalability-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
await rm(root,{recursive:true,force:true});
