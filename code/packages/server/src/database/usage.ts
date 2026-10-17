import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
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
  const db=this.db, alert=this.alert.bind(this);
  return {providerId:client.providerId,model:client.model,async *streamChat(messages,tools,signal){
   signal?.throwIfAborted();
   const id=randomUUID(),input=estimate(Buffer.byteLength(JSON.stringify({messages,tools})));
   await transaction(db,async c=>{
    if(context.taskId){uuid(context.taskId);if(!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL',[context.taskId])).rowCount)throw new RepositoryError(404,'任务不存在');}
    await c.query('INSERT INTO workpivot.model_usage(id,owner_user_id,provider_id,model,task_id,source,input_price,output_price,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,actor,client.providerId,client.model,context.taskId??null,context.source??'chat',price.inputPrice,price.outputPrice,price.currency]);
   },actor);
   let usage:Extract<StreamEvent,{type:'usage'}>|undefined,outputBytes=0,status='cancelled',failure:string|null=null;
   try{
    for await(const event of client.streamChat(messages,tools,signal)){
     if(event.type==='usage')usage=event;
     else if(event.type==='delta'||event.type==='reasoning_delta')outputBytes+=Buffer.byteLength(event.text);
     else if(event.type==='tool_calls')outputBytes+=Buffer.byteLength(JSON.stringify(event.tool_calls));
     yield event;
    }
    status='completed';
   }catch(error){status=signal?.aborted?'cancelled':'failed';const detail=modelFailureDetails(error);failure=detail.status?'HTTP '+detail.status:detail.code??(status==='cancelled'?'cancelled':'model-error');throw error;}
   finally{
    // 部分流中的usage可能尚未最终结算，因此中断也明确标为估算。
    const exact=status==='completed'&&usage!==undefined;
    await transaction(db,async c=>{
     await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['usage:'+actor]);
     await c.query(`UPDATE workpivot.model_usage SET status=$2,finished_at=now(),input_tokens=$3::bigint,output_tokens=$4::bigint,measurement=$5,
      cost=CASE WHEN input_price IS NOT NULL AND output_price IS NOT NULL THEN round(($3::numeric*input_price+$4::numeric*output_price)/1000000,12) END,failure=$6 WHERE id=$1 AND status='pending'`,[id,status,usage?.inputTokens??input,usage?.outputTokens??estimate(outputBytes),exact?'provider':'estimated',failure]);
     await alert(c,actor);
    },actor);
   }
  }};
 }
 private async alert(c:PoolClient,actor:string){
  await c.query(`INSERT INTO workpivot.usage_alerts(owner_user_id,currency,month,amount)
   SELECT $1,b.currency,to_char(now() AT TIME ZONE 'Asia/Shanghai','YYYY-MM'),b.amount FROM workpivot.usage_budgets b
   JOIN workpivot.model_usage u ON u.owner_user_id=b.owner_user_id AND u.currency=b.currency
   WHERE b.amount IS NOT NULL AND u.started_at>=date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai'
   GROUP BY b.currency,b.amount HAVING sum(u.cost)>=b.amount ON CONFLICT DO NOTHING`,[actor]);
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
   const budgets=(await c.query('SELECT currency,amount::text,revision FROM workpivot.usage_budgets ORDER BY currency')).rows;
   const alerts=(await c.query('SELECT currency,month,amount::text,read_at AS "readAt" FROM workpivot.usage_alerts ORDER BY month DESC,currency LIMIT 24')).rows;
   return {month,totals,days,tasks,recent,budgets,alerts,limits:{recent:100,tasks:100},notice:'费用为单价快照估算，不含缓存优惠、阶梯价等调整，不代表账单；缺少供应商用量时按UTF-8字节数÷4估算Token，不是精确分词。未知费用和未结算请求另列。月份按亚洲/上海时区。'};
  },actor);
 }
 async budget(actor:string,currency:unknown,amount:unknown,revision:unknown){
  const unit=currencyValue(currency),value=priceValue(amount);if(value!==null&&Number(value)<=0)throw new RepositoryError(400,'预算须大于0，清除预算请传null');
  if(!Number.isSafeInteger(revision)||Number(revision)<0)throw new RepositoryError(400,'预算版本无效');
  return transaction(this.db,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['usage:'+actor]);
   const old=(await c.query('SELECT revision FROM workpivot.usage_budgets WHERE currency=$1',[unit])).rows[0];
   if((old?.revision??0)!==revision)throw new RepositoryError(409,'预算已变更，请刷新');
   await c.query('INSERT INTO workpivot.usage_budgets(owner_user_id,currency,amount) VALUES($1,$2,$3) ON CONFLICT(owner_user_id,currency) DO UPDATE SET amount=EXCLUDED.amount,revision=workpivot.usage_budgets.revision+1',[actor,unit,value]);
   await this.alert(c,actor);
  },actor);
 }
 async alerts(actor:string){return transaction(this.db,async c=>(await c.query('SELECT currency,month,amount::text FROM workpivot.usage_alerts WHERE read_at IS NULL ORDER BY month DESC,currency LIMIT 24')).rows,actor);}
 async acknowledge(actor:string,currency:unknown,month:unknown){if(typeof month!=='string'||!/^\d{4}-\d{2}$/.test(month))throw new RepositoryError(400,'月份无效');await transaction(this.db,c=>c.query('UPDATE workpivot.usage_alerts SET read_at=COALESCE(read_at,now()) WHERE currency=$1 AND month=$2',[currencyValue(currency),month]),actor);}
}
