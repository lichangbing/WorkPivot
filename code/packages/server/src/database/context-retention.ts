import type {PoolClient} from 'pg';
/** 审批终态仅留工具身份和摘要，不留命令、地址、正文与参数。 */
export const permissionSummarySql=`jsonb_strip_nulls(jsonb_build_object('tool',request->'tool','kind',request->'kind','authorizationHash',request->'authorizationHash','invocation',(request->'invocation')-'arguments','redacted',true))`;
/** 调用方先持有任务锁，避免清理与新一轮启动交错。 */
export async function clearIdleContext(c:PoolClient,taskId:string) {
  const idle=(await c.query("SELECT 1 FROM workpivot.task_runs WHERE task_id=$1 HAVING max(COALESCE(finished_at,created_at))<now()-interval '30 days' AND bool_and(status NOT IN ('running','stopping'))",[taskId])).rowCount;
  if(!idle)return;
  await c.query("UPDATE workpivot.task_runs SET model_messages='[]',context_revoked=true WHERE task_id=$1 AND (NOT context_revoked OR model_messages<>'[]'::jsonb)",[taskId]);
  await c.query("UPDATE workpivot.context_checkpoints SET content='',status='stale',error=NULL,revision=revision+1 WHERE task_id=$1 AND (content<>'' OR status<>'stale')",[taskId]);
}
