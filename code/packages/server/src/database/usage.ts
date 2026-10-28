import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ModelClient, StreamEvent } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';
import { modelFailureDetails } from './model-error.js';

export interface UsageContext { taskId?: string; source?: 'chat'|'automation'|'memory'|'expert'|'summary'|'diagnostic' }
export interface UsagePrice { inputPrice: string|null; outputPrice: string|null; currency: string }
export function priceValue(value: unknown, nullable = true): string|null {
 if (value === null && nullable) return null;
 if (typeof value !== 'string' && typeof value !== 'number') throw new RepositoryError(400,'金额格式无效');
 const text=String(value);
 if (!/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/.test(text)) throw new RepositoryError(400,'金额必须为非负数，最多6位小数');
 return text;
}
export function currencyValue(value: unknown): string { if(value!=='CNY'&&value!=='USD')throw new RepositoryError(400,'币种仅支持CNY或USD');return value; }
const estimate=(bytes:number)=>Math.ceil(bytes/4);
/** 每个实际HTTP请求单独登记；重试不覆盖前一请求，也不保存请求正文。 */
export class UsageRepository {
 constructor(private readonly db:Pool){}
 wrap(actor:string,client:ModelClient,price:UsagePrice,context:UsageContext={}):ModelClient {
  const db=this.db;
  return {providerId:client.providerId,model:client.model,async *streamChat(messages,tools,signal){
   signal?.throwIfAborted();
   const id=randomUUID(),input=estimate(Buffer.byteLength(JSON.stringify({messages,tools})));
   const reservation=await transaction(db,async c=>{
    if(context.taskId){uuid(context.taskId);if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL',[context.taskId])).rowCount)throw new RepositoryError(404,'任务不存在');}
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['usage:'+actor]);
    const current=(await c.query(`SELECT platform_admin,token_quota::double precision AS "tokenQuota",
      CASE WHEN usage_period_started_at<identity.quota_period_start(now()) THEN 0 ELSE tokens_used::double precision END AS "tokensUsed",
      identity.quota_period_start(now()) AS "periodStart"
      FROM identity.users WHERE id=$1`,[actor])).rows[0];
    if(!current)throw new RepositoryError(401,'账号不存在');
    const used=Number(current.tokensUsed);
    if(!current.platform_admin&&Number(current.tokenQuota)>0&&used+input>Number(current.tokenQuota)){
      throw new RepositoryError(429,`今日 Token 额度已用完（上限 ${Number(current.tokenQuota).toLocaleString('zh-CN')}），请等待北京时间 12:00 刷新或联系管理员`);
    }
    await c.query(`UPDATE identity.users SET tokens_used=$2,usage_period_started_at=$3 WHERE id=$1`,[actor,used+input,current.periodStart]);
    await c.query('INSERT INTO workpivot.model_usage(id,owner_user_id,provider_id,model,task_id,source,input_tokens,output_tokens,measurement,input_price,output_price,currency) VALUES($1,$2,$3,$4,$5,$6,$7,0,\'estimated\',$8,$9,$10)',[id,actor,client.providerId,client.model,context.taskId??null,context.source??'chat',input,price.inputPrice,price.outputPrice,price.currency]);
    return {remainingOutput:Number(current.tokenQuota)>0&&!current.platform_admin?Math.max(0,Number(current.tokenQuota)-used-input):null,reservedInput:input};
   },actor);
   let usage:Extract<StreamEvent,{type:'usage'}>|undefined,outputBytes=0,status='cancelled',failure:string|null=null;
   const outputLimit=new AbortController();
   const streamSignal=reservation.remainingOutput===null?signal:signal?AbortSignal.any([signal,outputLimit.signal]):outputLimit.signal;
   try{
    for await(const event of client.streamChat(messages,tools,streamSignal)){
     if(event.type==='usage'){
      if(reservation.remainingOutput!==null&&event.outputTokens>reservation.remainingOutput){
       outputLimit.abort();
       throw new RepositoryError(429,'今日 Token 额度已用完，本轮生成已停止');
      }
      usage=event;
     }
     else if(event.type==='delta'||event.type==='reasoning_delta')outputBytes+=Buffer.byteLength(event.text);
     else if(event.type==='tool_calls')outputBytes+=Buffer.byteLength(JSON.stringify(event.tool_calls));
     if(reservation.remainingOutput!==null&&estimate(outputBytes)>reservation.remainingOutput){
      outputLimit.abort();
      throw new RepositoryError(429,'今日 Token 额度已用完，本轮生成已停止');
     }
     yield event;
    }
    status='completed';
   }catch(error){status=streamSignal?.aborted&&!outputLimit.signal.aborted?'cancelled':'failed';const detail=modelFailureDetails(error);failure=detail.status?'HTTP '+detail.status:detail.code??(status==='cancelled'?'cancelled':'model-error');throw error;}
   finally{
    // 部分流中的usage可能尚未最终结算，因此中断也明确标为估算。
    const exact=status==='completed'&&usage!==undefined;
    const charged=usage?(usage.inputTokens+usage.outputTokens):input+estimate(outputBytes);
    await transaction(db,async c=>{
     await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['usage:'+actor]);
     await c.query('UPDATE identity.users SET tokens_used=GREATEST(0,tokens_used-$2+$3) WHERE id=$1',[actor,reservation.reservedInput,charged]);
     await c.query(`UPDATE workpivot.model_usage SET status=$2,finished_at=now(),input_tokens=$3::bigint,output_tokens=$4::bigint,measurement=$5,
      cost=CASE WHEN input_price IS NOT NULL AND output_price IS NOT NULL THEN round(($3::numeric*input_price+$4::numeric*output_price)/1000000,12) END,failure=$6 WHERE id=$1 AND status='pending'`,[id,status,usage?.inputTokens??input,usage?.outputTokens??estimate(outputBytes),exact?'provider':'estimated',failure]);
    },actor);
   }
  }};
 }
 async overview(actor:string,month:string,taskId?:string){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month<'2020-01'||month>'2100-12')throw new RepositoryError(400,'月份无效');
  if(taskId)uuid(taskId);
  return transaction(this.db,async c=>{
   const where="started_at>=($1||'-01')::timestamp AT TIME ZONE 'Asia/Shanghai' AND started_at<(($1||'-01')::timestamp+interval '1 month') AT TIME ZONE 'Asia/Shanghai' AND ($2::uuid IS NULL OR task_id=$2)";
   const aggregate="currency,count(*)::int AS requests,COALESCE(sum(input_tokens),0)::text AS \"inputTokens\",COALESCE(sum(output_tokens),0)::text AS \"outputTokens\",sum(cost)::text AS cost,count(*) FILTER(WHERE cost IS NULL)::int AS \"unknownCost\",count(*) FILTER(WHERE measurement='estimated')::int AS estimated,count(*) FILTER(WHERE status='pending')::int AS unfinished";
   const args=[month,taskId??null];
   const totals=(await c.query(`SELECT ${aggregate} FROM workpivot.model_usage WHERE ${where} GROUP BY currency ORDER BY currency`,args)).rows;
   const days=(await c.query(`SELECT to_char(started_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,${aggregate} FROM workpivot.model_usage WHERE ${where} GROUP BY day,currency ORDER BY day DESC,currency`,args)).rows;
   const tasks=(await c.query(`SELECT task_id AS "taskId",(SELECT name FROM workpivot.tasks WHERE id=model_usage.task_id AND deleted_at IS NULL) AS "taskName",${aggregate} FROM workpivot.model_usage WHERE ${where} GROUP BY task_id,currency ORDER BY requests DESC LIMIT 100`,args)).rows;
   const recent=(await c.query(`SELECT id,model,task_id AS "taskId",source,status,started_at AS "startedAt",input_tokens::text AS "inputTokens",output_tokens::text AS "outputTokens",measurement,currency,cost::text,input_price::text AS "inputPrice",output_price::text AS "outputPrice",failure FROM workpivot.model_usage WHERE ${where} ORDER BY started_at DESC,id LIMIT 100`,args)).rows;
   return {month,totals,days,tasks,recent,budgets:[],alerts:[],limits:{recent:100,tasks:100},notice:'费用为单价快照估算，不含缓存优惠、阶梯价等调整，不代表账单；缺少供应商用量时按UTF-8字节数÷4估算Token，不是精确分词。未知费用和未结算请求另列。月份按亚洲/上海时区。'};
  },actor);
 }
}
