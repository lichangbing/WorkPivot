import type {Pool} from 'pg';
import {KnowledgeIngestionRepository,type KnowledgeCandidate} from '../packages/server/src/database/knowledge-ingestion.js';

/** 测试夹具也必须走真实用户确认路径，不能绕过知识入库边界。 */
export async function confirmKnowledgeForTest(
  db:Pool,
  actor:string,
  taskId:string,
  versionId:string,
  selection:'all'|'suggested'|number[]='all',
) {
  const ingestion=new KnowledgeIngestionRepository(db);
  let offset=0,revision=1;
  const candidates:KnowledgeCandidate[]=[];
  while(true){
    const page=await ingestion.candidates(actor,taskId,versionId,offset,100);
    candidates.push(...page.candidates);revision=page.revision;
    if(page.nextOffset===null)break;
    offset=page.nextOffset;
  }
  const selected=selection==='all'
    ? candidates.map(row=>row.ordinal)
    : selection==='suggested'
      ? candidates.filter(row=>row.suggested).map(row=>row.ordinal)
      : selection;
  return ingestion.confirm(actor,taskId,versionId,revision,selected);
}
