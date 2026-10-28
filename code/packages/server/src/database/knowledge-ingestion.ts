import type { Pool, PoolClient } from 'pg';
import { parserFingerprint } from './document-parser.js';
import { publishKnowledgeChunks, splitKnowledge } from './knowledge.js';
import type { ParsedPart } from './parsed-content.js';
import { RepositoryError, transaction, uuid } from './connection.js';

interface IngestionRow {
  versionId: string;
  documentId: string;
  taskId: string;
  projectId: string | null;
  name: string;
  versionRevision: number;
  documentRevision: number;
  parts: ParsedPart[];
  parserStatus: string;
  parsedFingerprint: string | null;
  status: string;
  revision: number;
  selectedOrdinals: number[];
  excluded: unknown[];
  decisionNote: string | null;
}

interface IngestionRequest {
  status: string;
  revision: number;
  parserFingerprint: string;
  selectedOrdinals: number[];
  excluded: unknown[];
  decisionNote: string | null;
}

export interface KnowledgeCandidate {
  id: string;
  ordinal: number;
  location: string;
  sourceOffset: number;
  content: string;
  suggested: boolean;
  reason: string | null;
}

/** 候选提示只做确定性降噪，最终是否入库始终由用户确认。 */
function candidateReasons(chunks: readonly { location:string; content:string }[]): Map<number,string> {
  const counts = new Map<string,number>();
  for (const chunk of chunks) {
    const key = chunk.content.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const result = new Map<number,string>();
  chunks.forEach((chunk,ordinal) => {
    const normalized = chunk.content.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const meaningful = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
    if (meaningful < 8) result.set(ordinal,'有效文字过少');
    else if (normalized.length <= 120 && (counts.get(normalized.toLowerCase()) ?? 0) >= 3) result.set(ordinal,'重复样板内容');
  });
  return result;
}

export class KnowledgeIngestionRepository {
  constructor(private readonly db:Pool) {}

  private async lockTask(c:PoolClient,taskId:string) {
    uuid(taskId);
    if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[taskId])).rowCount)throw new RepositoryError(404,'任务不存在');
  }

  private async source(c:PoolClient,taskId:string,versionId:string):Promise<IngestionRow> {
    uuid(taskId); uuid(versionId);
    const row = (await c.query<IngestionRow>(`
      SELECT v.id AS "versionId",v.document_id AS "documentId",d.task_id AS "taskId",
        t.project_id AS "projectId",v.name,v.revision AS "versionRevision",
        d.revision AS "documentRevision",COALESCE(p.parts,'[]'::jsonb) AS parts,
        COALESCE(p.status,'missing') AS "parserStatus",p.parser_fingerprint AS "parsedFingerprint",
        i.status,i.revision,i.selected_ordinals AS "selectedOrdinals",i.excluded,i.decision_note AS "decisionNote"
      FROM workpivot.document_versions v
      JOIN workpivot.documents d ON d.id=v.document_id
      JOIN workpivot.tasks t ON t.id=d.task_id
      LEFT JOIN workpivot.document_processing p ON p.version_id=v.id
      LEFT JOIN workpivot.knowledge_ingestions i ON i.version_id=v.id
      WHERE v.id=$1 AND d.task_id=$2 AND d.purpose='upload' AND t.deleted_at IS NULL`,
    [versionId,taskId])).rows[0];
    if (!row) throw new RepositoryError(404,'文件版本不存在');
    if (!row.projectId) throw new RepositoryError(409,'临时任务资料不能进入项目知识库，请先将任务归入项目');
    if (row.parserStatus !== 'completed') throw new RepositoryError(409,'文件尚未解析完成，暂不能审核入库');
    if (row.parsedFingerprint !== parserFingerprint) throw new RepositoryError(409,'解析结果已过期，请重建解析后重新审核');
    return row;
  }

  private async request(c:PoolClient,actor:string,source:IngestionRow):Promise<IngestionRequest> {
    await c.query(`INSERT INTO workpivot.knowledge_ingestions(
      version_id,owner_user_id,status,revision,parser_fingerprint
    ) VALUES($1,$2,'pending',1,$3) ON CONFLICT(version_id) DO NOTHING`,
    [source.versionId,actor,parserFingerprint]);
    const row = (await c.query<IngestionRequest>(`
      SELECT status,revision,parser_fingerprint AS "parserFingerprint",
        selected_ordinals AS "selectedOrdinals",excluded,decision_note AS "decisionNote"
      FROM workpivot.knowledge_ingestions WHERE version_id=$1 FOR UPDATE`, [source.versionId])).rows[0];
    if (!row) throw new RepositoryError(409,'知识入库状态不存在');
    if (row.parserFingerprint !== parserFingerprint) {
      await c.query('DELETE FROM workpivot.knowledge_versions WHERE version_id=$1',[source.versionId]);
      await c.query(`UPDATE workpivot.knowledge_ingestions
        SET status='pending',revision=revision+1,parser_fingerprint=$2,
          selected_ordinals='{}',excluded='[]',decision_note=NULL,decided_at=NULL,updated_at=now()
        WHERE version_id=$1`,[source.versionId,parserFingerprint]);
      return {status:'pending',revision:row.revision+1,parserFingerprint,selectedOrdinals:[],excluded:[],decisionNote:null};
    }
    return row;
  }

  async candidates(actor:string,taskId:string,versionId:string,offset=0,limit=50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RepositoryError(400,'候选分页参数无效');
    return transaction(this.db,async c=>{
      const source=await this.source(c,taskId,versionId);
      const request=await this.request(c,actor,source);
      const chunks=splitKnowledge(source.parts);
      const reasons=candidateReasons(chunks);
      const rows:KnowledgeCandidate[]=chunks.slice(offset,offset+limit).map((chunk,index)=>{
        const ordinal=offset+index;
        return {
          id:String(ordinal),
          ordinal,
          location:chunk.location,
          sourceOffset:chunk.offset,
          content:chunk.content,
          suggested:!reasons.has(ordinal),
          reason:reasons.get(ordinal)??null,
        };
      });
      return {
        versionId,
        documentId:source.documentId,
        taskId:source.taskId,
        projectId:source.projectId,
        name:source.name,
        versionRevision:source.versionRevision,
        status:request.status,
        revision:request.revision,
        selectedOrdinals:request.selectedOrdinals,
        excluded:request.excluded,
        decisionNote:request.decisionNote,
        total:chunks.length,
        offset,
        limit,
        nextOffset:offset+rows.length<chunks.length?offset+rows.length:null,
        candidates:rows,
      };
    },actor);
  }

  async confirm(actor:string,taskId:string,versionId:string,expectedRevision:number,selectedOrdinals:number[]) {
    if (!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new RepositoryError(400,'知识入库版本无效');
    if (!Array.isArray(selectedOrdinals)||selectedOrdinals.length<1||selectedOrdinals.length>20000||
      selectedOrdinals.some(value=>!Number.isSafeInteger(value)||value<0)||
      new Set(selectedOrdinals).size!==selectedOrdinals.length) throw new RepositoryError(400,'请选择至少一段有效候选内容');
    return transaction(this.db,async c=>{
      await this.lockTask(c,taskId);
      const source=await this.source(c,taskId,versionId);
      const request=await this.request(c,actor,source);
      if(request.revision!==expectedRevision)throw new RepositoryError(409,'知识入库状态已变化，请刷新后重新审核');
      const chunks=splitKnowledge(source.parts);
      const selected=[...selectedOrdinals].sort((a,b)=>a-b);
      if(selected.some(value=>value>=chunks.length))throw new RepositoryError(409,'候选内容已变化，请刷新后重新审核');
      const reasons=candidateReasons(chunks),selectedSet=new Set(selected);
      const excluded=chunks.flatMap((chunk,ordinal)=>selectedSet.has(ordinal)?[]:[{
        ordinal,
        location:chunk.location,
        reason:reasons.get(ordinal)??'用户未选择',
      }]);
      await publishKnowledgeChunks(c,actor,versionId,source.parts,selected);
      const updated=(await c.query(`UPDATE workpivot.knowledge_ingestions
        SET status='confirmed',revision=revision+1,selected_ordinals=$2,excluded=$3::jsonb,
          decision_note=NULL,decided_at=now(),updated_at=now()
        WHERE version_id=$1 RETURNING revision`,[versionId,selected,JSON.stringify(excluded)])).rows[0];
      return {status:'confirmed',revision:updated.revision,selected:selected.length,excluded:excluded.length};
    },actor);
  }

  async reject(actor:string,taskId:string,versionId:string,expectedRevision:number,note?:string|null) {
    if (!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new RepositoryError(400,'知识入库版本无效');
    if(note!==undefined&&note!==null&&(typeof note!=='string'||note.length>1000))throw new RepositoryError(400,'拒绝原因最多1000字');
    return transaction(this.db,async c=>{
      await this.lockTask(c,taskId);
      const source=await this.source(c,taskId,versionId);
      const request=await this.request(c,actor,source);
      if(request.revision!==expectedRevision)throw new RepositoryError(409,'知识入库状态已变化，请刷新后重新审核');
      await c.query('DELETE FROM workpivot.knowledge_versions WHERE version_id=$1',[versionId]);
      const updated=(await c.query(`UPDATE workpivot.knowledge_ingestions
        SET status='rejected',revision=revision+1,selected_ordinals='{}',excluded='[]',
          decision_note=$2,decided_at=now(),updated_at=now()
        WHERE version_id=$1 RETURNING revision`,[versionId,note??null])).rows[0];
      await c.query(`INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1)
        ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1`,[actor]);
      return {status:'rejected',revision:updated.revision};
    },actor);
  }

  async reopen(actor:string,taskId:string,versionId:string,expectedRevision:number) {
    if (!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new RepositoryError(400,'知识入库版本无效');
    return transaction(this.db,async c=>{
      await this.lockTask(c,taskId);
      const source=await this.source(c,taskId,versionId);
      const request=await this.request(c,actor,source);
      if(request.revision!==expectedRevision)throw new RepositoryError(409,'知识入库状态已变化，请刷新');
      await c.query('DELETE FROM workpivot.knowledge_versions WHERE version_id=$1',[versionId]);
      const updated=(await c.query(`UPDATE workpivot.knowledge_ingestions
        SET status='pending',revision=revision+1,selected_ordinals='{}',excluded='[]',
          decision_note=NULL,decided_at=NULL,updated_at=now()
        WHERE version_id=$1 RETURNING revision`,[versionId])).rows[0];
      await c.query(`INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1)
        ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1`,[actor]);
      return {status:'pending',revision:updated.revision};
    },actor);
  }
}
