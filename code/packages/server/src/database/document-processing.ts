import { readStructurePage, type StructureQuery } from './document-structure.js';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Pool } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';
import { FileRepository } from './files.js';
import { parseDocumentResult, parserFingerprint, validateParsedDocument, type ParsedDocument } from './document-parser.js';
import type { WorkerConfiguration } from './skill-execution.js';
import { parsingLimitations, readParsedPage, type ParsedPart } from './parsed-content.js';

export class DocumentProcessing {
  constructor(private readonly db:Pool, private readonly files:FileRepository, private readonly parse:(ext:string,data:Buffer)=>Promise<ParsedPart[] | ParsedDocument>, private readonly fingerprint=parserFingerprint) {}
  static worker(db:Pool,files:FileRepository,config:WorkerConfiguration) { return new DocumentProcessing(db,files,(ext,data)=>parseDocumentResult(config,ext,data)); }
  async process(actor:string) {
    const fence=randomUUID();
    const job=await transaction(this.db,async c=>{
      await c.query("UPDATE workpivot.document_processing SET status=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,error='解析中断，可重试',fence=NULL WHERE status='running' AND lease_until<now()");
      const row=(await c.query("SELECT p.version_id,p.status,p.parser_fingerprint,d.task_id,v.name FROM workpivot.document_processing p JOIN workpivot.document_versions v ON v.id=p.version_id JOIN workpivot.documents d ON d.id=v.document_id WHERE p.status='pending' OR (p.status='completed' AND p.parser_fingerprint IS DISTINCT FROM $1) ORDER BY v.created_at LIMIT 1 FOR UPDATE OF p SKIP LOCKED",[this.fingerprint])).rows[0];
      if(row && row.parser_fingerprint !== this.fingerprint) {
        await c.query('DELETE FROM workpivot.knowledge_versions WHERE version_id=$1',[row.version_id]);
        await c.query(`UPDATE workpivot.knowledge_ingestions
          SET status='pending',revision=revision+1,parser_fingerprint=$2,
            selected_ordinals='{}',excluded='[]',decision_note=NULL,decided_at=NULL,updated_at=now()
          WHERE version_id=$1`,[row.version_id,this.fingerprint]);
        if(row.status==='completed')await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]' WHERE owner_user_id=$1",[actor]);
      }
      if(row)await c.query("UPDATE workpivot.document_processing SET status='running',attempts=CASE WHEN parser_fingerprint IS DISTINCT FROM $3 THEN 1 ELSE attempts+1 END,fence=$2,lease_until=now()+interval '3 minutes',error=NULL,parser_fingerprint=$3,parts='[]',coverage='unknown',warnings='[]' WHERE version_id=$1",[row.version_id,fence,this.fingerprint]);
      return row;
    },actor);
    if(!job)return false;
    try {
      const original=await this.files.download(actor,job.task_id,job.version_id);
      const result=validateParsedDocument(await this.parse(extname(job.name).toLowerCase(),original.data));
      await transaction(this.db,async c=>{
        // 删除锁定同一任务后级联清理作业；迟到结果无法重建记录。
        await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE',[job.task_id]);
        await c.query("UPDATE workpivot.document_processing SET status='completed',parts=$3::jsonb,coverage=$4,warnings=$5::jsonb,error=NULL,fence=NULL,lease_until=NULL WHERE version_id=$1 AND fence=$2 AND status='running' AND lease_until>now()",[job.version_id,fence,JSON.stringify(result.parts),result.coverage,JSON.stringify(result.warnings)]);
        await c.query(`INSERT INTO workpivot.knowledge_ingestions(
          version_id,owner_user_id,status,revision,parser_fingerprint
        )
        SELECT v.id,v.owner_user_id,'pending',1,$2
        FROM workpivot.document_versions v
        JOIN workpivot.documents d ON d.id=v.document_id
        JOIN workpivot.tasks t ON t.id=d.task_id
        WHERE v.id=$1 AND d.purpose='upload' AND t.project_id IS NOT NULL
        ON CONFLICT(version_id) DO NOTHING`,[job.version_id,this.fingerprint]);
      },actor);
    } catch {
      await transaction(this.db,c=>c.query("UPDATE workpivot.document_processing SET status='failed',error='解析失败：请检查格式、文件内容或执行服务后重试；OCR可能失败或超出资源限制',fence=NULL,lease_until=NULL WHERE version_id=$1 AND fence=$2",[job.version_id,fence]),actor);
    }
    return true;
  }
  async list(actor:string,taskId:string) {
    uuid(taskId);
    return transaction(this.db,async c=>{
      if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1',[taskId])).rowCount)throw new RepositoryError(404,'任务不存在');
      const rows=(await c.query(`SELECT p.version_id AS id,v.name,p.status,p.error,
        p.parser_fingerprint AS "parserFingerprint",p.coverage,p.warnings,
        EXISTS(SELECT 1 FROM workpivot.knowledge_versions k WHERE k.version_id=p.version_id) AS indexed,
        COALESCE(i.status,'none') AS "knowledgeStatus",COALESCE(i.revision,0) AS "knowledgeRevision",
        COALESCE(jsonb_array_length(i.excluded),0) AS "excludedCount"
        FROM workpivot.document_processing p
        JOIN workpivot.document_versions v ON v.id=p.version_id
        JOIN workpivot.documents d ON d.id=v.document_id
        LEFT JOIN workpivot.knowledge_ingestions i ON i.version_id=p.version_id
        WHERE d.task_id=$1 AND v.revision=d.revision ORDER BY v.created_at`,[taskId])).rows;
      return rows.map(row=>({...row,stale:row.status==='completed'&&row.parserFingerprint!==this.fingerprint,indexed:row.indexed&&row.parserFingerprint===this.fingerprint}));
    },actor);
  }
  async retry(actor:string,taskId:string,versionId:string) {
    uuid(taskId);uuid(versionId);
    return transaction(this.db,async c=>{
      const updated=await c.query("UPDATE workpivot.document_processing p SET status='pending',attempts=0,error=NULL WHERE p.version_id=$1 AND (p.status='failed' OR (p.status='completed' AND (p.parser_fingerprint IS DISTINCT FROM $3 OR p.coverage='partial'))) AND EXISTS(SELECT 1 FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE v.id=p.version_id AND d.task_id=$2)",[versionId,taskId,this.fingerprint]);
      if(!updated.rowCount)throw new RepositoryError(409,'解析任务不存在或不可重试');
      await c.query('DELETE FROM workpivot.knowledge_versions WHERE version_id=$1',[versionId]);
      await c.query(`UPDATE workpivot.knowledge_ingestions
        SET status='pending',revision=revision+1,selected_ordinals='{}',excluded='[]',
          decision_note=NULL,decided_at=NULL,updated_at=now()
        WHERE version_id=$1`,[versionId]);
      await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]' WHERE owner_user_id=$1",[actor]);
    },actor);
  }
  async read(actor:string,taskId:string,versionId:string,offset:number): Promise<ReturnType<typeof readParsedPage> & {versionId:string;revision:number;latestRevision:number;parserStatus:string;parserFingerprint:string;coverage:string;warnings:string[]}>;
  async read(actor:string,taskId:string,versionId:string,offset:number,structure:StructureQuery): Promise<ReturnType<typeof readStructurePage> & {versionId:string;revision:number;latestRevision:number;parserStatus:string;parserFingerprint:string;coverage:string;warnings:string[]}>;
  async read(actor:string,taskId:string,versionId:string,offset:number, structure?:StructureQuery) {
    uuid(versionId);uuid(taskId);
    return transaction(this.db,async c=>{
      const row=(await c.query('SELECT p.status,p.parts,p.parser_fingerprint,p.coverage,p.warnings,v.name,v.revision,d.revision AS latest_revision FROM workpivot.document_processing p JOIN workpivot.document_versions v ON v.id=p.version_id JOIN workpivot.documents d ON d.id=v.document_id WHERE v.id=$1 AND d.task_id=$2',[versionId,taskId])).rows[0];
      if(!row)throw new RepositoryError(404,'解析内容不存在');
      if(row.status==='completed'&&row.parser_fingerprint!==this.fingerprint)throw new RepositoryError(409,'解析版本已过期，等待后台重建或手动重试');
      if(row.status!=='completed')throw new RepositoryError(409,'文件解析尚未完成，请查看解析状态后重试');
      return { ...(structure ? readStructurePage(row.parts, structure) : readParsedPage(row.parts, offset)), versionId, revision: row.revision, latestRevision: row.latest_revision, parserStatus: row.status, parserFingerprint:row.parser_fingerprint, coverage:row.coverage, warnings:[...parsingLimitations(extname(row.name)),...row.warnings] };
    },actor);
  }
}
