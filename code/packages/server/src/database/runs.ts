import {permissionSummarySql,clearIdleContext} from './context-retention.js';
import {memoryEnabled} from './memory-controls.js';
import {publicToolEvent} from './tool-events.js';
import {selection,requireVersion,fileTaskScope,type RunResourceScope} from './resource-scope.js';
import {authorizationDigest,currentInvocation} from './tool-authorization.js';
import { compactedHistory } from './compaction.js';
import { reconcileMessages, remainingSteps } from './recovery.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentEvent, ChatMessage, StopReason, ToolAccessRequest } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface RunHandle { id: string; taskId: string; turnId: string; fence: string; duplicate: boolean }
const leaseSeconds = 30;
const permissionTtlMinutes = (() => {
  const configured = Number(process.env['WORKPIVOT_PERMISSION_TTL_MINUTES'] ?? 10);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 60 ? configured : 10;
})();
/**
 * 静默执行的工具白名单：只有产品明确要求不弹卡的工具才自动放行，模型参数无法扩展这个集合。
 * 部署可用 WORKPIVOT_CODE_APPROVAL=confirm 恢复逐次确认；输入与产物范围仍由运行读取范围独立校验。
 */
/** 用户「执行模式」：manual 逐次确认；auto（或未设置）只对声明 auto 的工具静默。部署可用 WORKPIVOT_CODE_APPROVAL=confirm 强制覆盖。 */
function automaticRequest(request: ToolAccessRequest, mode: unknown): boolean {
  if (process.env['WORKPIVOT_CODE_APPROVAL'] === 'confirm') return false;
  if (mode === 'manual') return false;
  // 自动模式没有计划闸门；确认模式才在首个执行动作前问一次。
  if (request.tool === 'plan') return true;
  return request.auto === true && request.tool === 'run_code' && !request.paths.length;
}
/** 联网类工具的用户可见名称，避免授权卡把所有外部调用都说成 MCP。 */
function networkActionLabel(tool: string): string {
  return tool === 'web_search' ? '联网搜索' : tool === 'web_fetch' ? '读取网页' : '浏览网页';
}
/** 中断的工具消息组不得作为未配对的模型协议消息重放。 */
export function replayableMessages(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'tool') continue;
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const outputs: ChatMessage[] = [];
      for (let j = i + 1; j < messages.length && messages[j]!.role === 'tool'; j++) outputs.push(messages[j]!);
      const ids = new Set(message.tool_calls.map(call => call.id));
      if (outputs.length === ids.size && new Set(outputs.map(m => m.tool_call_id)).size === ids.size && outputs.every(m => ids.has(m.tool_call_id ?? ''))) result.push(message, ...outputs);
      else if (message.content) result.push({ role: 'assistant', content: message.content });
      i += outputs.length;
    } else result.push(message);
  }
  return result;
}
async function lock(c: PoolClient, taskId: string) {
  const row = (await c.query('SELECT id,status FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [taskId])).rows[0];
  if (!row) throw new RepositoryError(404, '任务不存在');
  return row;
}
async function event(c: PoolClient, actor: string, run: RunHandle, kind: string, content: string) {
  const seq = (await c.query('UPDATE workpivot.tasks SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence', [run.taskId])).rows[0].sequence;
  const id = randomUUID();
  await c.query('INSERT INTO workpivot.conversation_events(id,owner_user_id,task_id,turn_id,sequence,request_id,run_id,kind,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, actor, run.taskId, run.turnId, seq, randomUUID(), run.id, kind, content]);
  return { id, sequence: seq as string, turnId: run.turnId, runId: run.id };
}

export class RunRepository {
  constructor(private readonly db: Pool) {}
  async resources(actor:string,taskId:string,input?:unknown,attachments:string[]=[],requestId?:string):Promise<RunResourceScope> {
    if(!Array.isArray(attachments)||attachments.length>10)throw new RepositoryError(400,'附件列表无效');attachments.forEach(uuid);
    return transaction(this.db,async c=>{
      await lock(c,taskId);
      await clearIdleContext(c,taskId);
      if(requestId){
        uuid(requestId);
        const duplicate=(await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE task_id=$1 AND request_id=$2',[taskId,requestId])).rows[0]?.resource_scope as RunResourceScope|undefined;
        if(duplicate){
          if(input!==undefined){const requested=selection(input);requested.versionIds=selection({...requested,versionIds:[...requested.versionIds,...attachments]}).versionIds;if(authorizationDigest(requested)!==authorizationDigest(duplicate.initial??selection(duplicate)))throw new RepositoryError(409,'重复请求的读取范围不同');}
          return duplicate;
        }
      }
      const previous=(await c.query('SELECT id,resource_scope FROM workpivot.task_runs WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[taskId])).rows[0];
      const old=previous?.resource_scope as RunResourceScope|null;
      if(input&&typeof input==='object'&&'baseRunId' in input&&(input as {baseRunId:unknown}).baseRunId!==(previous?.id??null))throw new RepositoryError(409,'读取范围已在其他页面变化，请刷新');
      const value=selection(input===undefined?(old?.version===1?old:{versionIds:[],memoryScopes:[],expert:false}):input);
      // 自动资料范围未提供记忆层时，沿用三层中仍启用“加载”的默认集合；显式关闭仍由记忆设置控制。
      if(value.memoryScopes.length===0){
        for(const scope of ['user','project','task'] as const)if(await memoryEnabled(c,scope,'load'))value.memoryScopes.push(scope);
        value.memoryScopes.sort();
      }
      value.versionIds=selection({...value,versionIds:[...value.versionIds,...attachments]}).versionIds;
      const valid=(await c.query(`SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE ${fileTaskScope('$1')} AND v.id=ANY($2::uuid[])`,[taskId,value.versionIds])).rows.map(r=>r.id as string);
      if(input!==undefined&&valid.length!==value.versionIds.length)throw new RepositoryError(404,'所选文件已删除或不属于当前任务和项目');
      value.versionIds=valid.sort();
      const plans=(await c.query("SELECT id FROM workpivot.automations WHERE id=ANY($1::uuid[]) AND state<>'deleted'",[value.scheduleIds??[]])).rows.map(r=>r.id as string).sort();
      if(input!==undefined&&plans.length!==(value.scheduleIds??[]).length)throw new RepositoryError(404,'所选自动化已删除或不可访问');
      value.scheduleIds=plans;
      const same=old?.version===1&&authorizationDigest(selection(old))===authorizationDigest(value);
      return {...value,initial:structuredClone(value),version:1,epoch:same?old!.epoch:randomUUID(),baseRunId:previous?.id??null};
    },actor);
  }
  /** 与发布共用事务，复核已消费的许可；其他工具或迟到异步工作不能借用许可。 */
  async checkToolPermission(c:PoolClient,run:RunHandle,expected:string[],args?:Record<string,unknown>) {
    await this.active(c,run);
    const {tool,invocation}=currentInvocation(expected);
    if(args&&authorizationDigest(args)!==invocation.digest)throw new RepositoryError(403,'业务操作参数与审批不一致');
    const rows=await c.query("SELECT request FROM workpivot.run_permissions WHERE run_id=$1 AND task_id=$2 AND state='consumed' AND decision='allow' AND request->>'tool'=$3 AND request->'invocation'->>'id'=$4",[run.id,run.taskId,tool,invocation.id]);
    if(!rows.rows.some(row=>row.request.invocation?.definition===invocation.definition&&row.request.invocation?.digest===invocation.digest))throw new RepositoryError(403,'业务操作没有已批准的匹配调用');
  }
  async cleanupContext(actor:string) {
    await transaction(this.db,async c=>{
      const tasks=(await c.query("SELECT t.id FROM workpivot.tasks t WHERE EXISTS(SELECT 1 FROM workpivot.task_runs r WHERE r.task_id=t.id AND NOT r.context_revoked) AND NOT EXISTS(SELECT 1 FROM workpivot.task_runs r WHERE r.task_id=t.id AND (COALESCE(r.finished_at,r.created_at)>=now()-interval '30 days' OR r.status IN ('running','stopping'))) ORDER BY t.id LIMIT 50 FOR UPDATE SKIP LOCKED")).rows;
      for(const task of tasks)await clearIdleContext(c,task.id);
      const approvals=(await c.query(`SELECT id,content FROM workpivot.conversation_events WHERE kind='meta' AND content LIKE '%"type":"permission_request"%' AND content NOT LIKE '%"redacted":true%' ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
      for(const event of approvals){
        let old:Record<string,unknown>;try{old=JSON.parse(event.content);}catch{continue;}
        await c.query('UPDATE workpivot.conversation_events SET content=$2 WHERE id=$1',[event.id,JSON.stringify({type:'permission_request',id:old.id,tool:old.tool,command:old.tool,paths:[],scope:'once',reason:'请在待审批卡片核对本次操作',redacted:true})]);
      }
      const events=(await c.query(`SELECT id,kind,content FROM workpivot.conversation_events WHERE kind IN ('tool_use','tool_result') AND content NOT LIKE '%"redacted":true%' ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)).rows;
      for(const event of events){
        let value:AgentEvent;try{value=JSON.parse(event.content) as AgentEvent;}catch{value={type:event.kind,ok:false};}
        await c.query('UPDATE workpivot.conversation_events SET content=$2 WHERE id=$1',[event.id,JSON.stringify(publicToolEvent({...value,type:event.kind}))]);
      }
      await c.query(`UPDATE workpivot.run_permissions SET request=${permissionSummarySql} WHERE id IN (SELECT id FROM workpivot.run_permissions WHERE state NOT IN ('pending','allowed') AND NOT COALESCE((request->>'redacted')::boolean,false) LIMIT 100)`);
    },actor);
  }
  async checkResources(actor:string,run:RunHandle,scope:RunResourceScope,args:Record<string,unknown>={}) {
    await transaction(this.db,c=>this.checkResourcesInTransaction(c,run,scope,args),actor);
  }
  /** 发布事务已持有任务锁，在同一事务复核范围，避免入口检查与落库之间失效。 */
  async checkResourcesInTransaction(c:PoolClient,run:RunHandle,scope:RunResourceScope,args:Record<string,unknown>={}) {
    if(typeof args.versionId==='string')requireVersion(scope.versionIds,args.versionId);
    if(args.inputs!==undefined){if(!Array.isArray(args.inputs))throw new RepositoryError(400,'输入列表无效');for(const id of args.inputs)requireVersion(scope.versionIds,id);}
    await this.active(c,run);
    const saved=(await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1',[run.id])).rows[0]?.resource_scope;
    if(authorizationDigest(saved)!==authorizationDigest(scope))throw new RepositoryError(409,'运行读取范围已撤销或变化');
    const remaining=await c.query(`SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE ${fileTaskScope('$1')} AND v.id=ANY($2::uuid[])`,[run.taskId,scope.versionIds]);
    if(remaining.rowCount!==scope.versionIds.length)throw new RepositoryError(409,'授权文件已删除，请重新发送');
    const plans=await c.query("SELECT id FROM workpivot.automations WHERE id=ANY($1::uuid[]) AND state<>'deleted'",[scope.scheduleIds??[]]);
    if(plans.rowCount!==(scope.scheduleIds??[]).length)throw new RepositoryError(409,'授权自动化已删除，请重新选择范围');
    const targets=args.outputs===undefined?[args]:args.outputs;
    if(!Array.isArray(targets))throw new RepositoryError(400,'产物列表无效');
    for(const target of targets){
      // Skill试运行的outputs是文件名列表，不是已有成果的更新目标。
      if(typeof target==='string')continue;
      if(!target||typeof target!=='object'||Array.isArray(target))throw new RepositoryError(400,'产物参数无效');
      const {documentId,revision}=target as Record<string,unknown>;
      if(documentId===undefined)continue;
      uuid(documentId as string);
      if(!Number.isSafeInteger(revision)||Number(revision)<1)throw new RepositoryError(400,'需要产物修订号');
      const authorized=await c.query("SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1 AND d.id=$2 AND d.purpose='artifact' AND v.revision=$3 AND v.id=ANY($4::uuid[])",[run.taskId,documentId,revision,scope.versionIds]);
      if(!authorized.rowCount)throw new RepositoryError(403,'更新目标不在本轮授权范围');
    }
  }
  async grantSchedule(actor:string,run:RunHandle,scope:RunResourceScope,id:string) {
    uuid(id);
    const ids=[...new Set([...(scope.scheduleIds??[]),id])].sort();
    if(ids.length>100)throw new RepositoryError(413,'自动化读取范围超过100个');
    await transaction(this.db,async c=>{
      await this.checkResourcesInTransaction(c,run,scope);
      if(!(await c.query("SELECT id FROM workpivot.automations WHERE id=$1 AND source_run_id=$2 AND state<>'deleted'",[id,run.id])).rowCount)throw new RepositoryError(403,'自动化不属于本轮生成内容');
      await c.query('UPDATE workpivot.task_runs SET resource_scope=$2 WHERE id=$1',[run.id,JSON.stringify({...scope,scheduleIds:ids})]);
    },actor);
    if(!scope.scheduleIds)scope.scheduleIds=[];
    scope.scheduleIds.splice(0,scope.scheduleIds.length,...ids);
  }
  async grantArtifacts(actor:string,run:RunHandle,scope:RunResourceScope,ids:string[]){
    if(!ids.length)return;
    const next=[...new Set([...scope.versionIds,...ids])].sort();if(next.length>100)throw new RepositoryError(413,'本轮文件范围超过100个版本');
    await transaction(this.db,async c=>{
      await this.active(c,run);
      const saved=(await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1',[run.id])).rows[0]?.resource_scope;
      if(authorizationDigest(saved)!==authorizationDigest(scope))throw new RepositoryError(409,'运行读取范围已撤销或变化');
      const valid=await c.query("SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1 AND d.purpose='artifact' AND v.id=ANY($2::uuid[])",[run.taskId,ids]);
      if(valid.rowCount!==new Set(ids).size)throw new RepositoryError(409,'新成果不属于当前任务');
      await c.query('UPDATE workpivot.task_runs SET resource_scope=$2 WHERE id=$1',[run.id,JSON.stringify({...scope,versionIds:next})]);
    },actor);
    // 保持工具闭包中的数组身份，获批生成的成果可在本轮核对。
    scope.versionIds.splice(0,scope.versionIds.length,...next);
  }
  async start(actor: string, taskId: string, requestId: string, content: string, attachments: string[] = [],resources?:RunResourceScope): Promise<RunHandle> {
    uuid(taskId); uuid(requestId);
    if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(id => typeof id !== 'string')) throw new RepositoryError(400, '附件列表无效');
    attachments.forEach(uuid); attachments = attachments.map(id => id.toLowerCase());
    if (new Set(attachments).size !== attachments.length) throw new RepositoryError(400, '附件不能重复');
    if (typeof content !== 'string' || !content.trim() || content.length > 200000) throw new RepositoryError(400, '消息内容无效');
    return transaction(this.db, async c => {
      const task = await lock(c, taskId);
      const old = (await c.query('SELECT id,turn_id AS "turnId",fence,attachment_ids,resource_scope FROM workpivot.task_runs WHERE task_id=$1 AND request_id=$2', [taskId, requestId])).rows[0];
      if (old) {
        const original = (await c.query("SELECT content FROM workpivot.conversation_events WHERE turn_id=$1 AND kind='user' ORDER BY sequence LIMIT 1", [old.turnId])).rows[0];
        if ((resources&&authorizationDigest(selection(old.resource_scope))!==authorizationDigest(selection(resources))) || original?.content !== content || JSON.stringify(old.attachment_ids) !== JSON.stringify(attachments)) throw new RepositoryError(409, '重复请求内容不同');
        return { ...old, taskId, duplicate: true };
      }
      if (['queued', 'running', 'waiting'].includes(task.status)) throw new RepositoryError(409, '任务仍在执行，请先停止或恢复中断状态');
      const limits = (await c.query(
        'SELECT platform_admin,concurrent_task_limit FROM identity.users WHERE id=$1',
        [actor],
      )).rows[0];
      if (!limits) throw new RepositoryError(401, '账号不存在');
      if (!limits.platform_admin && Number(limits.concurrent_task_limit) > 0) {
        const running = Number((await c.query(
          "SELECT count(DISTINCT task_id)::int AS n FROM workpivot.task_runs WHERE owner_user_id=$1 AND status='running'",
          [actor],
        )).rows[0]?.n ?? 0);
        if (running >= Number(limits.concurrent_task_limit)) {
          throw new RepositoryError(429, `同时运行任务已达上限（${limits.concurrent_task_limit} 个），请等待当前任务结束或联系管理员`);
        }
      }
      if (attachments.length) {
        const valid = await c.query(`SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE ${fileTaskScope('$1')} AND v.id=ANY($2::uuid[])`, [taskId, attachments]);
        if (valid.rowCount !== attachments.length) throw new RepositoryError(404, '附件已删除或不属于当前任务');
      }
      if(resources){
        const latest=(await c.query('SELECT id FROM workpivot.task_runs WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[taskId])).rows[0]?.id??null;
        if(latest!==resources.baseRunId)throw new RepositoryError(409,'读取范围已变化，请刷新后重试');
        const valid=await c.query(`SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE ${fileTaskScope('$1')} AND v.id=ANY($2::uuid[])`,[taskId,resources.versionIds]);
        if(valid.rowCount!==resources.versionIds.length)throw new RepositoryError(409,'授权文件已删除，请刷新范围');
        // 范围变化同时撤销旧派生上下文，后台整理也不能继续使用旧范围。
        await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]' WHERE task_id=$1 AND (resource_scope->>'epoch' IS DISTINCT FROM $2) AND NOT context_revoked",[taskId,resources.epoch]);
        await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE task_id=$1 AND state IN ('pending','allowed')`,[taskId]);
      }
      // 演示额度：只对真正新建的轮次计数（重复请求在前面已返回），与建 run 同事务。
      const quota = await c.query(
        `UPDATE identity.users SET
           messages_used=CASE WHEN quota_reset_at<=now() THEN 1 ELSE messages_used+1 END,
           quota_reset_at=CASE WHEN quota_reset_at<=now() THEN workpivot.quota_next_reset(now()) ELSE quota_reset_at END
         WHERE id=$1 AND NOT platform_admin AND message_quota>0
           AND (quota_reset_at<=now() OR messages_used<message_quota)
         RETURNING message_quota-messages_used AS remaining`,
        [actor],
      );
      if (!quota.rowCount) {
        const me = (await c.query('SELECT platform_admin,message_quota,messages_used,quota_reset_at FROM identity.users WHERE id=$1', [actor])).rows[0];
        if (!me) throw new RepositoryError(401, '账号不存在');
        if (!me.platform_admin && Number(me.message_quota) > 0) throw new RepositoryError(429, `演示额度已用完（${me.message_quota} 次），如需继续请联系管理员开通`);
      }
      const run: RunHandle = { id: randomUUID(), taskId, turnId: randomUUID(), fence: randomUUID(), duplicate: false };
      // R006 P1：上一轮被中断时，把它的检查点作为本轮基础上下文（已补齐结果未知的调用），
      // 用户重发"继续"即可接着做；预算按剩余步数继承，不重置。
      const interrupted = task.status === 'interrupted'
        ? (await c.query("SELECT model_messages,step_limit,used_steps FROM workpivot.task_runs WHERE task_id=$1 AND status='interrupted' ORDER BY created_at DESC,id DESC LIMIT 1", [taskId])).rows[0]
        : undefined;
      const inherited = interrupted && !interrupted.model_messages?.length
        ? []
        : reconcileMessages(Array.isArray(interrupted?.model_messages) ? interrupted.model_messages as ChatMessage[] : []).messages;
      const seedMessages = inherited.length ? [...inherited, { role: 'user' as const, content }] : [];
      const inheritedBudget = interrupted
        ? remainingSteps(Number(interrupted.step_limit ?? 0), Number(interrupted.used_steps ?? 0)) ?? 0
        : 0;
      const seq = (await c.query("UPDATE workpivot.tasks SET next_turn_sequence=next_turn_sequence+1,status='running',revision=revision+1 WHERE id=$1 RETURNING next_turn_sequence-1 AS sequence", [taskId])).rows[0].sequence;
      await c.query('INSERT INTO workpivot.conversation_turns(id,owner_user_id,task_id,sequence,request_id) VALUES($1,$2,$3,$4,$5)', [run.turnId, actor, taskId, seq, requestId]);
      await c.query("INSERT INTO workpivot.task_runs(id,owner_user_id,task_id,turn_id,request_id,fence,status,lease_until,model_messages,step_limit) VALUES($1,$2,$3,$4,$5,$6,'running',now()+$7*interval '1 second',$8,$9)", [run.id, actor, taskId, run.turnId, requestId, run.fence, leaseSeconds, JSON.stringify(seedMessages), inheritedBudget]);
      if(resources)await c.query('UPDATE workpivot.task_runs SET resource_scope=$2 WHERE id=$1',[run.id,JSON.stringify(resources)]);
      await event(c, actor, run, 'user', content);
      await c.query("UPDATE workpivot.task_runs SET expert_snapshot=(SELECT jsonb_build_object('id',e.id,'revision',e.revision,'settings',e.settings) FROM workpivot.tasks t JOIN workpivot.experts e ON e.id=t.expert_id WHERE t.id=$2 AND NOT e.public AND NOT e.disabled) WHERE id=$1",[run.id,taskId]);
      await c.query('UPDATE workpivot.task_runs SET attachment_ids=$2,memory_epoch=COALESCE((SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=workpivot.actor_id()),0) WHERE id=$1', [run.id, attachments]);
      return run;
    }, actor);
  }
  private async active(c: PoolClient, run: RunHandle, allowStopping = false) {
    await lock(c, run.taskId);
    const row = (await c.query('SELECT status,context_revoked,model_messages,used_steps,step_limit,lease_until>now() AS live FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND fence=$3 FOR UPDATE', [run.id, run.taskId, run.fence])).rows[0];
    if (row?.context_revoked && !allowStopping) throw new RepositoryError(409, '记忆已删除，请重新开始本轮对话');
    if (!row?.live || (row.status !== 'running' && !(allowStopping && row.status === 'stopping'))) throw new RepositoryError(409, '运行已停止或执行租约失效');
    return row;
  }
  async heartbeat(actor: string, run: RunHandle): Promise<boolean> {
    return transaction(this.db, async c => {
      const current = await this.active(c, run, true);
      await c.query("UPDATE workpivot.task_runs SET lease_until=now()+$2*interval '1 second' WHERE id=$1", [run.id, leaseSeconds]);
      return current.status === 'running' && !current.context_revoked;
    }, actor);
  }
  async append(actor: string, run: RunHandle, value: AgentEvent) {
    value=publicToolEvent(value);
    const content = value.type === 'assistant_delta' || value.type === 'reasoning_delta' ? value.text ?? '' : JSON.stringify(value);
    if (content.length > 200000) throw new RepositoryError(413, '运行事件过大');
    const kind = value.type === 'assistant_delta' ? 'assistant' : value.type === 'reasoning_delta' ? 'thinking' : value.type === 'tool_use' || value.type === 'tool_result' ? value.type : 'meta';
    return transaction(this.db, async c => { await this.active(c, run); return event(c, actor, run, kind, content); }, actor);
  }
  async stop(actor: string, taskId: string): Promise<void> {
    uuid(taskId);
    await transaction(this.db, async c => {
      await lock(c, taskId);
      await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE task_id=$1 AND state IN ('pending','allowed')`, [taskId]);
      await c.query("UPDATE workpivot.task_runs SET status='stopping' WHERE task_id=$1 AND status='running'", [taskId]);
    }, actor);
  }
  async finish(actor: string, run: RunHandle, reason: StopReason, messages: ChatMessage[]): Promise<StopReason> {
    if (JSON.stringify(messages).length > 2000000) throw new RepositoryError(413, '运行上下文过大');
    return transaction(this.db, async c => {
      const current = await this.active(c, run, true);
      await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE run_id=$1 AND state IN ('pending','allowed')`, [run.id]);
      const result = current.status === 'stopping' || current.context_revoked ? 'aborted' : reason;
      const status = result === 'completed' ? 'completed' : result === 'aborted' ? 'stopped' : 'failed';
      await c.query('UPDATE workpivot.task_runs SET status=$2,stop_reason=$3,model_messages=$4,finished_at=now() WHERE id=$1', [run.id, status, result, JSON.stringify(current.context_revoked ? [] : replayableMessages(messages))]);
      await event(c, actor, run, 'meta', JSON.stringify({ type: 'done', stopReason: result }));
      await c.query('UPDATE workpivot.tasks SET status=$2,revision=revision+1 WHERE id=$1', [run.taskId, status === 'completed' ? 'idle' : status]);
      return result;
    }, actor);
  }
  async recover(actor: string, taskId: string): Promise<boolean> {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      const runs = (await c.query("UPDATE workpivot.task_runs SET status='interrupted',stop_reason='lease_expired',finished_at=now() WHERE task_id=$1 AND status IN ('running','stopping') AND lease_until<=now() RETURNING id,turn_id AS \"turnId\",fence,model_messages", [taskId])).rows;
      for (const run of runs) {
        await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE run_id=$1 AND state IN ('pending','allowed')`, [run.id]);
        // R006：对账未闭合的 tool_call——已派发的只补"结果未知"，绝不重放。
        const stored = Array.isArray(run.model_messages) ? run.model_messages as ChatMessage[] : [];
        const { messages, repaired } = reconcileMessages(stored);
        if (repaired.length) await c.query('UPDATE workpivot.task_runs SET model_messages=$2 WHERE id=$1', [run.id, JSON.stringify(messages)]);
        await c.query("UPDATE workpivot.tool_dispatches SET status='interrupted',finished_at=now() WHERE run_id=$1 AND status='dispatched'", [run.id]);
        if (repaired.length) await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'recovered', repaired: repaired.map((item) => item.tool) }));
        await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'done', stopReason: 'interrupted' }));
      }
      if (runs.length) await c.query("UPDATE workpivot.tasks SET status='interrupted',revision=revision+1 WHERE id=$1", [taskId]);
      return runs.length > 0;
    }, actor);
  }

  /** R006 P2：一键续跑——新 run 继承上一轮检查点与剩余步数，不重放已发生的副作用。 */
  async resume(actor: string, taskId: string): Promise<RunHandle> {
    uuid(taskId);
    return transaction(this.db, async c => {
      const task = await lock(c, taskId);
      if (task.status !== 'interrupted') throw new RepositoryError(409, '当前任务没有可继续的中断运行');
      const previous = (await c.query("SELECT id,model_messages,step_limit,used_steps,context_revoked FROM workpivot.task_runs WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1", [taskId])).rows[0];
      if (!previous) throw new RepositoryError(409, '找不到上一轮运行');
      if (previous.context_revoked) throw new RepositoryError(409, '上下文已失效，请重新发起本轮对话');
      const stored = Array.isArray(previous.model_messages) ? previous.model_messages as ChatMessage[] : [];
      const { messages } = reconcileMessages(stored);
      const run: RunHandle = { id: randomUUID(), taskId, turnId: randomUUID(), fence: randomUUID(), duplicate: false };
      const requestId = randomUUID();
      const seq = (await c.query("UPDATE workpivot.tasks SET next_turn_sequence=next_turn_sequence+1,status='running',revision=revision+1 WHERE id=$1 RETURNING next_turn_sequence-1 AS sequence", [taskId])).rows[0].sequence;
      await c.query('INSERT INTO workpivot.conversation_turns(id,owner_user_id,task_id,sequence,request_id) VALUES($1,$2,$3,$4,$5)', [run.turnId, actor, taskId, seq, requestId]);
      const budget = remainingSteps(Number(previous.step_limit ?? 0), Number(previous.used_steps ?? 0)) ?? 0;
      await c.query("INSERT INTO workpivot.task_runs(id,owner_user_id,task_id,turn_id,request_id,fence,status,lease_until,model_messages,step_limit) VALUES($1,$2,$3,$4,$5,$6,'running',now()+$7*interval '1 second',$8,$9)", [run.id, actor, taskId, run.turnId, requestId, run.fence, leaseSeconds, JSON.stringify(messages), budget]);
      await c.query("UPDATE workpivot.task_runs SET resource_scope=(SELECT resource_scope FROM workpivot.task_runs WHERE id=$2),attachment_ids=(SELECT attachment_ids FROM workpivot.task_runs WHERE id=$2) WHERE id=$1", [run.id, previous.id]);
      await event(c, actor, run, 'meta', JSON.stringify({ type: 'resumed', from: previous.id }));
      return run;
    }, actor);
  }
  async history(actor: string, run: RunHandle): Promise<ChatMessage[]> {
    return transaction(this.db, async c => {
      const row = await this.active(c, run);
      // R006：续跑承接上一轮检查点；全新轮次 model_messages 为空，回落到任务级历史。
      const stored = Array.isArray(row.model_messages) ? row.model_messages as ChatMessage[] : [];
      if (stored.length) return stored;
      return compactedHistory(c, run.taskId);
    }, actor);
  }

  /** R006：每一步结束写检查点（完整消息数组），恢复时以它为准；fence 不匹配则拒绝旧写入。 */
  async checkpoint(actor: string, run: RunHandle, messages: ChatMessage[], steps: number, stepLimit = 0): Promise<void> {
    if (JSON.stringify(messages).length > 2000000) throw new RepositoryError(413, '运行上下文过大');
    await transaction(this.db, async c => {
      await this.active(c, run);
      const updated = await c.query('UPDATE workpivot.task_runs SET model_messages=$2,used_steps=GREATEST(used_steps,$3),step_limit=CASE WHEN $4::integer>0 THEN $4 ELSE step_limit END WHERE id=$1 AND fence=$5 RETURNING id', [run.id, JSON.stringify(replayableMessages(messages)), steps, stepLimit, run.fence]);
      if (!updated.rowCount) throw new RepositoryError(409, '运行已停止或执行租约失效');
    }, actor);
  }

  /** R006：工具派发登记（执行前），恢复时据此判断"已派发但结果未知"，绝不重放。 */
  async dispatch(actor: string, run: RunHandle, callId: string, tool: string): Promise<void> {
    await transaction(this.db, async c => {
      await c.query('INSERT INTO workpivot.tool_dispatches(run_id,call_id,owner_user_id,task_id,tool) VALUES($1,$2,$3,$4,$5) ON CONFLICT(run_id,call_id) DO NOTHING', [run.id, callId, actor, run.taskId, tool]);
    }, actor);
  }

  /** R006：工具结束登记；失败/拒绝也要落，避免被误判为"结果未知"。 */
  async settle(actor: string, run: RunHandle, callId: string, status: 'completed' | 'failed'): Promise<void> {
    await transaction(this.db, async c => {
      await c.query("UPDATE workpivot.tool_dispatches SET status=$3,finished_at=now() WHERE run_id=$1 AND call_id=$2 AND status='dispatched'", [run.id, callId, status]);
    }, actor);
  }
  async requestPermission(actor: string, run: RunHandle, request: ToolAccessRequest) {
    // 数据库工具使用一次性操作许可；external表示审批通道，不授予宿主路径权限。
    if (!request.external || request.paths.length || request.kind !== 'write' || !request.tool || JSON.stringify(request).length > (request.invocation ? 1048576 : 24000)) throw new RepositoryError(400, '此类授权尚未接入数据库');
    return transaction(this.db, async c => {
      await this.active(c, run);
      // 用户的执行模式：manual 时逐次确认，auto 或未设置时只有声明 auto 的工具静默。
      const mode = (await c.query("SELECT value FROM workpivot.user_settings WHERE owner_user_id=$1 AND key='execution.mode'", [actor])).rows[0]?.value;
      const silent = automaticRequest(request, mode);
      const id = randomUUID();
      const record = JSON.stringify({...request,authorizationHash:authorizationDigest(request)});
      if (silent) {
        // 静默执行：直接登记为已批准并已消费，不进入待审批列表；发布事务仍按同一调用摘要复核。
        await c.query("INSERT INTO workpivot.run_permissions(id,owner_user_id,task_id,run_id,request,state,decision,resolved_at,expires_at) VALUES($1,$2,$3,$4,$5,'consumed','allow',now(),now()+$6*interval '1 minute')", [id, actor, run.taskId, run.id, record, permissionTtlMinutes]);
        return { id, automatic: true as const, eventId: '' };
      }
      // 任务级授权范围尚未建立，旧全局auto不能替代本次明确许可。
      await c.query("INSERT INTO workpivot.run_permissions(id,owner_user_id,task_id,run_id,request,expires_at) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 minute')", [id, actor, run.taskId, run.id, record, permissionTtlMinutes]);
      await c.query("UPDATE workpivot.tasks SET status='waiting',revision=revision+1 WHERE id=$1", [run.taskId]);
      const payload = { type: 'permission_request' as const, id, tool: request.tool, command: request.tool, paths: [], scope: 'once', redacted:true, reason: request.tool === 'plan' ? '确认执行计划：接下来会调用写入或执行类工具，本轮确认后不再逐次询问' : mode === 'manual' ? '确认模式：本次操作需要你确认' : request.tool === 'execute_skill' ? '本次隔离执行需要确认' : ['web_fetch','web_search','browser_visit'].includes(request.tool) ? `本次${networkActionLabel(request.tool)}需要确认` : '本次操作需要确认，请核对参数和影响' };
      const saved = await event(c, actor, run, 'meta', JSON.stringify(payload));
      return { ...saved, ...payload, automatic: false as const, eventId: saved.id };
    }, actor);
  }
  async pendingPermissions(actor: string, taskId: string) {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      return (await c.query("SELECT p.id,p.request,p.expires_at AS \"expiresAt\" FROM workpivot.run_permissions p JOIN workpivot.task_runs r ON r.id=p.run_id WHERE p.task_id=$1 AND p.state='pending' AND p.expires_at>now() AND r.status='running' AND r.lease_until>now() ORDER BY p.created_at,p.id", [taskId])).rows;
    }, actor);
  }
  async decidePermission(actor: string, taskId: string, id: string, decision: 'allow' | 'deny'): Promise<void> {
    uuid(taskId); uuid(id);
    if (decision !== 'allow' && decision !== 'deny') throw new RepositoryError(400, '仅支持本次允许或拒绝');
    await transaction(this.db, async c => {
      await lock(c, taskId);
      const row = (await c.query('SELECT *,expires_at>now() AS live FROM workpivot.run_permissions WHERE task_id=$1 AND id=$2 FOR UPDATE', [taskId, id])).rows[0];
      if (!row) throw new RepositoryError(404, '授权请求不存在');
      if (row.decision === decision && ['allowed', 'denied', 'consumed'].includes(row.state)) return;
      if (row.state !== 'pending' || !row.live) throw new RepositoryError(409, '授权请求已失效或处理');
      const run = (await c.query("SELECT id,turn_id AS \"turnId\",fence FROM workpivot.task_runs WHERE id=$1 AND status='running' AND lease_until>now()", [row.run_id])).rows[0];
      if (!run) throw new RepositoryError(409, '任务执行已失效');
      await c.query(`UPDATE workpivot.run_permissions SET state=$2,decision=$3,resolved_at=now(),request=CASE WHEN $3='deny' THEN ${permissionSummarySql} ELSE request END WHERE id=$1`, [id, decision === 'allow' ? 'allowed' : 'denied', decision]);
      await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision }));
      // 等待执行器消费审批决定后再继续，避免界面提前宣称已恢复执行。
    }, actor);
  }
  async consumePermission(actor: string, run: RunHandle, id: string, expected?: ToolAccessRequest): Promise<'pending' | 'allow' | 'deny'> {
    uuid(id);
    return transaction(this.db, async c => {
      await this.active(c, run);
      const row = (await c.query('SELECT state,request,expires_at>now() AS live FROM workpivot.run_permissions WHERE id=$1 AND run_id=$2 AND task_id=$3 FOR UPDATE', [id, run.id, run.taskId])).rows[0];
      if (!row) throw new RepositoryError(404, '授权请求不存在');
      if (row.request.invocation && (!expected || (row.request.authorizationHash??authorizationDigest(row.request)) !== authorizationDigest(expected))) throw new RepositoryError(409, '审批与实际调用不一致');
      if (row.state === 'pending' && row.live) return 'pending';
      if (!row.live && ['pending', 'allowed'].includes(row.state)) {
        await c.query(`UPDATE workpivot.run_permissions SET state='expired',resolved_at=now(),request=${permissionSummarySql} WHERE id=$1`, [id]);
        await event(c, actor, run, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision: 'deny', reason: 'timeout' }));
      }
      const allow = row.state === 'allowed' && row.live;
      if (allow) await c.query(`UPDATE workpivot.run_permissions SET state='consumed',request=${permissionSummarySql} WHERE id=$1`, [id]);
      await c.query("UPDATE workpivot.tasks SET status='running',revision=revision+1 WHERE id=$1 AND status='waiting'", [run.taskId]);
      return allow ? 'allow' : 'deny';
    }, actor);
  }
}
