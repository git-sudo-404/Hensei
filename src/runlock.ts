import {open,unlink,readFile,mkdir,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
export async function runLock(destination:string):Promise<()=>Promise<void>> {
  await mkdir(join(destination,'.hensei'),{recursive:true});const path=join(destination,'.hensei','run.lock'),claim=path+'.claim',token=crypto.randomUUID();
  // Serialize stale-lock reclamation as well as acquisition. A crash during this short claim
  // leaves an explicit manual-recovery marker rather than risking two active orchestrators.
  try{await mkdir(claim);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Another Hensei run already acquiring this destination (or stale run.lock.claim needs recovery)');throw error;}
  try {
    const acquire=async()=>{const file=await open(path,'wx');await file.writeFile(JSON.stringify({pid:process.pid,token}));await file.close();};
    try{await acquire();}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const owner=JSON.parse(await readFile(path,'utf8'));if(!Number.isInteger(owner.pid)||owner.pid<1)throw new Error('Invalid run.lock; manual recovery required');
      try{process.kill(owner.pid,0);throw new Error('Another Hensei run already owns this destination');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      await unlink(path);await acquire();
    }
  }finally{await rmdir(claim);}
  return async()=>{const owner=JSON.parse(await readFile(path,'utf8'));if(owner.token===token)await unlink(path);};
}
