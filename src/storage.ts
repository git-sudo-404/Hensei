import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
/** Readers see the previous complete record or the new complete record, never a partial JSON file. */
export async function atomicJson(path:string,value:unknown):Promise<void> {
 await mkdir(dirname(path),{recursive:true});const temporary=`${path}.${crypto.randomUUID()}.tmp`,file=await open(temporary,'wx');
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 try{await rename(temporary,path);}catch(error){await unlink(temporary).catch(()=>{});throw error;}
 const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
}
