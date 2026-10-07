import {Database} from 'bun:sqlite';
import {join} from 'node:path';
import type {Task} from './planner';
import type {CandidateRecord} from './worktrees';
export class Journal {
  private db:Database;
  constructor(runDir:string) {
    this.db=new Database(join(runDir,'state.sqlite'),{create:true});this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL); CREATE TABLE IF NOT EXISTS integrations(task_id TEXT PRIMARY KEY,candidate TEXT NOT NULL,commit_id TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  }
  add(tasks:Task[]):void {this.db.transaction(()=>{for(const task of tasks)this.db.query('INSERT OR IGNORE INTO tasks VALUES(?,?,?)').run(task.id,JSON.stringify(task),'PENDING');})();}
  initialize(plan:import('./planner').TaskPlan,snapshot:unknown,config:unknown):void {this.db.transaction(()=>{this.set('plan',plan);this.set('inventory',snapshot);this.set('config',config);this.add(plan.tasks);})();}
  enqueue(tasks:Task[],round:number):void {this.db.transaction(()=>{this.add(tasks);this.set('round',round);})();}
  status(id:string,status:string):void {this.db.query('UPDATE tasks SET status=? WHERE id=?').run(status,id);}
  statuses():Record<string,string> {return Object.fromEntries((this.db.query('SELECT id,status FROM tasks').all() as {id:string;status:string}[]).map(r=>[r.id,r.status]));}
  tasks():Task[] {return (this.db.query('SELECT payload FROM tasks ORDER BY rowid').all() as {payload:string}[]).map(row=>JSON.parse(row.payload));}
  accept(candidate:CandidateRecord,commit:string):void {this.acceptMany([candidate],commit);}
  acceptMany(candidates:CandidateRecord[],commit:string):void {this.db.transaction(()=>{for(const candidate of candidates){this.db.query('INSERT OR REPLACE INTO integrations VALUES(?,?,?)').run(candidate.taskId,JSON.stringify(candidate),commit);this.status(candidate.taskId,'SUCCEEDED');}})();}
  accepted():{candidate:CandidateRecord;commit:string}[] {return (this.db.query('SELECT candidate,commit_id FROM integrations ORDER BY rowid').all() as {candidate:string;commit_id:string}[]).map(r=>({candidate:JSON.parse(r.candidate),commit:r.commit_id}));}
  set(key:string,value:unknown):void {this.db.query('INSERT OR REPLACE INTO metadata VALUES(?,?)').run(key,JSON.stringify(value));}
  get<T>(key:string):T|undefined {const row=this.db.query('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|null;return row?JSON.parse(row.value):undefined;}
  close():void {this.db.close();}
}
