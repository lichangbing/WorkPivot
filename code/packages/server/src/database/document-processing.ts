import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Pool } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';
import { FileRepository } from './files.js';
import { parseDocument, type ParsedPart } from './document-parser.js';
import type { WorkerConfiguration } from './skill-execution.js';

export class DocumentProcessing {
  constructor(private readonly db:Pool, private readonly files:FileRepository, private readonly parse:(ext:string,data:Buffer)=>Promise<ParsedPart[]>) {}
  static worker(db:Pool,files:FileRepository,config:WorkerConfiguration) { return new DocumentProcessing(db,files,(ext,data)=>parseDocument(config,ext,data)); }
  async process(actor:string) {
    const fence=randomUUID();
    const job=await transaction(this.db,async c=>{
      await c.query("UPDATE workpivot.document_processing SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,error='解析中断，可重试',fence=NULL WHERE status='running' AND lease_until<now()");
      const row=(await c.query("SELECT p.version_id,d.task_id,v.name FROM workpivot.document_processing p JOIN workpivot.document_versions v ON v.id=p.version_id JOIN workpivot.documents d ON d.id=v.document_id WHERE p.status='pending' ORDER BY v.created_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED")).rows[0];
      if(row)await c.query("UPDATE workpivot.document_processing SET status='running',attempts=attempts+1,fence=$2,lease_until=now()+interval '3 minutes',error=NULL WHERE version_id=$1",[row.version_id,fence]);
      return row;
    },actor);
    if(!job)return false;
    try {
      const original=await this.files.download(actor,job.task_id,job.version_id);
      const parts=await this.parse(extname(job.name).toLowerCase(),original.data);
      await transaction(this.db,async c=>{
        // Deletion locks the same task, then cascades the job. A late result cannot recreate it.
        await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE',[job.task_id]);
        await c.query("UPDATE workpivot.document_processing SET status='completed',parts=$3::jsonb,error=NULL,fence=NULL,lease_until=NULL WHERE version_id=$1 AND fence=$2 AND status='running' AND lease_until>now()",[job.version_id,fence,JSON.stringify(parts)]);
      },actor);
    } catch {
      await transaction(this.db,c=>c.query("UPDATE workpivot.document_processing SET status='failed',error='解析失败：请检查格式、文件内容或执行服务后重试；扫描件暂不支持OCR',fence=NULL,lease_until=NULL WHERE version_id=$1 AND fence=$2",[job.version_id,fence]),actor);
    }
    return true;
  }
  async list(actor:string,taskId:string) {
    uuid(taskId);
    return transaction(this.db,async c=>{
      if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1',[taskId])).rowCount)throw new RepositoryError(404,'任务不存在');
      return (await c.query('SELECT p.version_id AS id,v.name,p.status,p.error,EXISTS(SELECT 1 FROM workpivot.knowledge_versions k WHERE k.version_id=p.version_id) AS indexed FROM workpivot.document_processing p JOIN workpivot.document_versions v ON v.id=p.version_id JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1 AND v.revision=d.revision ORDER BY v.created_at',[taskId])).rows;
    },actor);
  }
  async retry(actor:string,taskId:string,versionId:string) {
    uuid(taskId);uuid(versionId);
    return transaction(this.db,async c=>{
      const updated=await c.query("UPDATE workpivot.document_processing p SET status='pending',attempts=0,error=NULL WHERE p.version_id=$1 AND p.status='failed' AND EXISTS(SELECT 1 FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE v.id=p.version_id AND d.task_id=$2)",[versionId,taskId]);
      if(!updated.rowCount)throw new RepositoryError(409,'解析任务不存在或不可重试');
    },actor);
  }
  async read(actor:string,taskId:string,versionId:string,offset:number) {
    uuid(versionId);uuid(taskId);
    return transaction(this.db,async c=>{
      const row=(await c.query('SELECT p.status,p.parts FROM workpivot.document_processing p JOIN workpivot.document_versions v ON v.id=p.version_id JOIN workpivot.documents d ON d.id=v.document_id WHERE v.id=$1 AND d.task_id=$2',[versionId,taskId])).rows[0];
      if(!row)throw new RepositoryError(404,'解析内容不存在');
      if(row.status!=='completed')throw new RepositoryError(409,'文件解析尚未完成，请查看解析状态后重试');
      const text=(row.parts as ParsedPart[]).map(p=>`[${p.location}]\n${p.text}`).join('\n');
      if(!Number.isSafeInteger(offset)||offset<0||offset>text.length)throw new RepositoryError(400,'读取位置无效');
      let end=Math.min(offset+8000,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;
      return {format:'extracted',offset,totalCharacters:text.length,content:text.slice(offset,end),nextOffset:end<text.length?end:null};
    },actor);
  }
}
