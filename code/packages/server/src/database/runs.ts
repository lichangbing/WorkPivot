import {permissionSummarySql,clearIdleContext} from './context-retention.js';
import {memoryEnabled} from './memory-controls.js';
import {publicToolEvent} from './tool-events.js';
import {selection,requireVersion,fileTaskScope,syncExpandedScope,type RunResourceScope,type RuntimeScopeExpansionInput} from './resource-scope.js';
import {authorizationDigest,currentInvocation} from './tool-authorization.js';
import {classifyInteractionRisk, canAutoApprove} from './interaction-policy.js';
import { compactedHistory } from './compaction.js';
import { reconcileMessages, remainingSteps } from './recovery.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentEvent, ChatMessage, StopReason, ToolAccessRequest } from '@workpivot/core';
import { interactionCapabilities, type InteractionEnvelope, type SteeringMessage } from '@workpivot/shared';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface RunHandle { id: string; taskId: string; turnId: string; fence: string; duplicate: boolean }
export interface ScopeChangeView {
  id: string;
  taskId: string;
  runId: string;
  requestId: string;
  baseEpoch: string;
  addedVersionIds: string[];
  addedMemoryScopes: string[];
  createdAt: string;
}
interface SteeringRow {
  id: string;
  task_id: string;
  run_id: string;
  request_id: string;
  content: string;
  mode: 'safe';
  status: SteeringMessage['status'];
  relation: SteeringMessage['relation'];
  classification_reason: string | null;
  created_at: Date;
  applied_at: Date | null;
  cancelled_at: Date | null;
  event_id: string | null;
}
function steeringMessage(row: SteeringRow): SteeringMessage {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    requestId: row.request_id,
    content: row.content,
    mode: row.mode,
    status: row.status,
    relation: row.relation,
    ...(row.classification_reason ? { classificationReason: row.classification_reason } : {}),
    createdAt: row.created_at.toISOString(),
    ...(row.applied_at ? { appliedAt: row.applied_at.toISOString() } : {}),
    ...(row.cancelled_at ? { cancelledAt: row.cancelled_at.toISOString() } : {}),
    ...(row.event_id ? { eventId: row.event_id } : {}),
  };
}
interface ScopeChangeRow {
  id: string; task_id: string; run_id: string; request_id: string; base_epoch: string;
  added_version_ids: string[]; added_memory_scopes: string[];
  created_at: Date; previous_scope: RunResourceScope; next_scope: RunResourceScope;
}
function scopeChangeMessage(row: ScopeChangeRow): ScopeChangeView {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    requestId: row.request_id,
    baseEpoch: row.base_epoch,
    addedVersionIds: [...row.added_version_ids].sort(),
    addedMemoryScopes: [...row.added_memory_scopes].sort(),
    createdAt: row.created_at.toISOString(),
  };
}
function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (values: readonly string[]) => [...new Set(values.map(value => value.toLowerCase()))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
const leaseSeconds = 30;
const permissionTtlMinutes = (() => {
  const configured = Number(process.env['WORKPIVOT_PERMISSION_TTL_MINUTES'] ?? 10);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 60 ? configured : 10;
})();
/**
 * 静默执行的工具白名单：只有产品明确要求不弹卡的工具才自动放行，模型参数无法扩展这个集合。
 * 部署可用 WORKPIVOT_CODE_APPROVAL=confirm 恢复逐次确认；输入与产物范围仍由运行读取范围独立校验。
 */
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

  async activeResources(actor:string,taskId:string):Promise<{runId:string;turnId:string;scope:RunResourceScope}|null> {
    uuid(taskId);
    return transaction(this.db,async c=>{
      await lock(c,taskId);
      const row=(await c.query(`SELECT id,turn_id AS "turnId",resource_scope
        FROM workpivot.task_runs WHERE task_id=$1 AND status='running' AND lease_until>now()
        ORDER BY created_at DESC,id DESC LIMIT 1`,[taskId])).rows[0];
      if(!row||!row.resource_scope)return null;
      return {runId:String(row.id),turnId:String(row.turnId),scope:row.resource_scope as RunResourceScope};
    },actor);
  }

  /** 在当前运行的安全检查点前持久化一个“只增不减”的范围变更。 */
  async expandResources(actor:string,taskId:string,input:RuntimeScopeExpansionInput):Promise<{change:ScopeChangeView;scope:RunResourceScope}> {
    if(!interactionCapabilities().runtimeScopeExpansion)throw new RepositoryError(503,'运行中资源范围扩展尚未启用','RUNTIME_SCOPE_DISABLED');
    uuid(taskId);uuid(input.requestId);uuid(input.baseRunId);uuid(input.baseEpoch);
    const requestedVersions=selection({versionIds:input.addVersionIds??[],memoryScopes:[],expert:false}).versionIds;
    const requestedMemory=[...new Set(input.addMemoryScopes??[])].sort() as ('user'|'project'|'task')[];
    if(requestedMemory.some(scope=>!['user','project','task'].includes(scope)))throw new RepositoryError(400,'记忆层级无效');
    if(requestedVersions.length>100)throw new RepositoryError(413,'运行中新增文件范围超过100个');
    return transaction(this.db,async c=>{
      const task=await lock(c,taskId);
      const duplicate=(await c.query<ScopeChangeRow>('SELECT * FROM workpivot.run_scope_changes WHERE owner_user_id=$1 AND task_id=$2 AND request_id=$3',[actor,taskId,input.requestId])).rows[0];
      if(duplicate){
        // 同请求可以重复选择原范围中已有的层级；幂等比较的是本次实际可增加的范围。
        const requestedAddedVersions=requestedVersions.filter(id=>!duplicate.previous_scope.versionIds.includes(id));
        const requestedAddedMemory=requestedMemory.filter(scope=>!duplicate.previous_scope.memoryScopes.includes(scope));
        if(String(duplicate.base_epoch).toLowerCase()!==input.baseEpoch.toLowerCase()||
          String(duplicate.run_id).toLowerCase()!==input.baseRunId.toLowerCase()||
          !sameValues(duplicate.added_version_ids,requestedAddedVersions)||
          !sameValues(duplicate.added_memory_scopes,requestedAddedMemory))throw new RepositoryError(409,'重复请求的运行中范围变更不同');
        return {change:scopeChangeMessage(duplicate),scope:duplicate.next_scope};
      }
      if(!['running','waiting'].includes(task.status))throw new RepositoryError(409,'任务当前不在运行，请使用普通消息调整范围');
      const run=(await c.query(`SELECT id,turn_id AS "turnId",resource_scope
        FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND status='running' AND lease_until>now()
        FOR UPDATE`,[input.baseRunId,taskId])).rows[0];
      if(!run?.resource_scope)throw new RepositoryError(409,'当前运行已结束，请刷新后重新发送');
      const previous=run.resource_scope as RunResourceScope;
      if(previous.epoch!==input.baseEpoch)throw new RepositoryError(409,'运行资源范围已被其他页面修改，请刷新后重试');
      const nextAddedVersions=requestedVersions.filter(id=>!previous.versionIds.includes(id));
      const nextAddedMemory=requestedMemory.filter(scope=>!previous.memoryScopes.includes(scope)) as ('user'|'project'|'task')[];
      if(!nextAddedVersions.length&&!nextAddedMemory.length)throw new RepositoryError(400,'没有需要加入当前运行的新资料');
      const valid=nextAddedVersions.length
        ? (await c.query(`SELECT v.id,v.name FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE ${fileTaskScope('$1')} AND v.id=ANY($2::uuid[])`,[taskId,nextAddedVersions])).rows
        : [];
      if(valid.length!==nextAddedVersions.length)throw new RepositoryError(404,'新增文件已删除或不属于当前任务和项目');
      const current=selection(previous);
      const next:RunResourceScope={
        ...current,
        versionIds:[...new Set([...previous.versionIds,...nextAddedVersions])].sort(),
        memoryScopes:[...new Set([...previous.memoryScopes,...nextAddedMemory])].sort() as RunResourceScope['memoryScopes'],
        expert:previous.expert,
        version:1,
        epoch:randomUUID(),
        baseRunId:previous.baseRunId??null,
        initial:previous.initial??structuredClone(current),
      };
      await c.query('UPDATE workpivot.task_runs SET resource_scope=$2 WHERE id=$1',[run.id,JSON.stringify(next)]);
      await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE run_id=$1 AND state IN ('pending','allowed')`,[run.id]);
      await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE run_id=$1 AND state='pending'",[run.id]);
      await c.query("UPDATE workpivot.task_plans SET status='superseded',updated_at=now() WHERE task_id=$1 AND status IN ('draft','approved')",[taskId]);
      const id=randomUUID();
      const inserted=(await c.query<ScopeChangeRow>(`INSERT INTO workpivot.run_scope_changes(
        id,owner_user_id,task_id,run_id,request_id,base_epoch,added_version_ids,added_memory_scopes,previous_scope,next_scope
      ) VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8::text[],$9,$10) RETURNING *`,[
        id,actor,taskId,run.id,input.requestId,input.baseEpoch,nextAddedVersions,nextAddedMemory,
        JSON.stringify(previous),JSON.stringify(next),
      ])).rows[0]!;
      const memoryLabels={user:'个人记忆',project:'项目记忆',task:'任务记忆'} as const;
      const description=[
        nextAddedVersions.length?`新增文件版本：${valid.map(row=>String(row.name)).join('、')}`:'',
        nextAddedMemory.length?`新增记忆层：${nextAddedMemory.map(scope=>memoryLabels[scope]).join('、')}`:'',
      ].filter(Boolean).join('；');
      await c.query(`INSERT INTO workpivot.run_steering_messages(
        id,owner_user_id,task_id,run_id,request_id,content,mode,status,relation,classification_reason
      ) VALUES($1,$2,$3,$4,$5,$6,'safe','pending','related',$7)`,[
        randomUUID(),actor,taskId,run.id,randomUUID(),
        `用户已确认将新资料加入当前运行：${description}。请在下一个安全步骤重新读取相关资料，并核对现有计划和已有结论是否仍然成立；资料改变任务范围时应重新规划，不得忽略新增内容。`,
        '用户明确确认的运行中资源范围增量扩展',
      ]);
      await event(c,actor,{id:String(run.id),taskId,turnId:String(run.turnId),fence:'',duplicate:false},'meta',JSON.stringify({type:'scope_changed',change:scopeChangeMessage(inserted),scope:next}));
      return {change:scopeChangeMessage(inserted),scope:next};
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
  private async hasScopeChange(c:PoolClient,run:RunHandle,target:RunResourceScope,saved:unknown):Promise<boolean> {
    if(!saved||typeof saved!=='object'||Array.isArray(saved)||typeof (saved as Record<string,unknown>)['epoch']!=='string')return false;
    const epoch=(saved as Record<string,unknown>)['epoch'];
    const rows=(await c.query<{previous_scope:RunResourceScope;next_scope:RunResourceScope}>(
      "SELECT previous_scope,next_scope FROM workpivot.run_scope_changes WHERE run_id=$1 AND next_scope->>'epoch'=$2",
      [run.id,epoch],
    )).rows;
    // 只接受“当前闭包恰为该变更前快照”的受控转换；旧闭包不能跳过多个代次直接借新记录升级。
    return rows.some(row=>authorizationDigest(row.previous_scope)===authorizationDigest(target)&&authorizationDigest(row.next_scope)===authorizationDigest(saved));
  }
  /** 发布事务已持有任务锁，在同一事务复核范围，避免入口检查与落库之间失效。 */
  async checkResourcesInTransaction(c:PoolClient,run:RunHandle,scope:RunResourceScope,args:Record<string,unknown>={}) {
    await this.active(c,run);
    const saved=(await c.query('SELECT resource_scope FROM workpivot.task_runs WHERE id=$1',[run.id])).rows[0]?.resource_scope;
    if(authorizationDigest(saved)!==authorizationDigest(scope)){
      if(!await this.hasScopeChange(c,run,scope,saved))throw new RepositoryError(409,'运行读取范围已撤销或变化');
      syncExpandedScope(scope,saved);
    }
    // 先同步数据库里已审计的新增范围，再校验本次工具参数；否则新文件第一次读取会被旧闭包拒绝。
    if(typeof args.versionId==='string')requireVersion(scope.versionIds,args.versionId);
    if(args.inputs!==undefined){if(!Array.isArray(args.inputs))throw new RepositoryError(400,'输入列表无效');for(const id of args.inputs)requireVersion(scope.versionIds,id);}
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
      if(authorizationDigest(saved)!==authorizationDigest(scope)){
        if(!await this.hasScopeChange(c,run,scope,saved))throw new RepositoryError(409,'运行读取范围已撤销或变化');
        syncExpandedScope(scope,saved);
      }
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
      // 用户直接发送下一条消息说明旧澄清/验收已被放弃；交互回答接口会先处理并写入终态，不受影响。
      await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE task_id=$1 AND state='pending'", [taskId]);
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
        await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE task_id=$1 AND state='pending'",[taskId]);
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
        ? (await c.query("SELECT id,model_messages,step_limit,used_steps FROM workpivot.task_runs WHERE task_id=$1 AND status='interrupted' ORDER BY created_at DESC,id DESC LIMIT 1", [taskId])).rows[0]
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
      if (interrupted?.id) await event(c, actor, run, 'meta', JSON.stringify({ type: 'resumed', from: interrupted.id }));
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

  /** 任务运行中使用独立接口追加要求，不会创建第二个并发 run。 */
  async queueSteering(actor: string, taskId: string, requestId: string, content: string): Promise<SteeringMessage> {
    uuid(taskId); uuid(requestId);
    if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new RepositoryError(400, '运行中补充要求无效');
    return transaction(this.db, async c => {
      const task = await lock(c, taskId);
      const previous = (await c.query(
        'SELECT * FROM workpivot.run_steering_messages WHERE task_id=$1 AND request_id=$2',
        [taskId, requestId],
      )).rows[0] as SteeringRow | undefined;
      if (previous) {
        if (previous.content !== content.trim()) throw new RepositoryError(409, '重复请求的运行中补充要求不同');
        return steeringMessage(previous);
      }
      if (!['running', 'waiting'].includes(task.status)) throw new RepositoryError(409, '任务当前不在运行，请使用普通消息发送');
      const run = (await c.query(
        "SELECT id,turn_id AS \"turnId\",fence FROM workpivot.task_runs WHERE task_id=$1 ORDER BY (status='running' AND lease_until>now()) DESC,created_at DESC,id DESC LIMIT 1",
        [taskId],
      )).rows[0] as { id: string; turnId: string; fence: string } | undefined;
      if (!run) throw new RepositoryError(409, '任务运行已结束，请刷新后发送普通消息');
      const id = randomUUID();
      const inserted = (await c.query(
        "INSERT INTO workpivot.run_steering_messages(id,owner_user_id,task_id,run_id,request_id,content) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [id, actor, taskId, run.id, requestId, content.trim()],
      )).rows[0] as SteeringRow;
      const handle: RunHandle = { ...run, taskId, duplicate: false };
      await event(c, actor, handle, 'meta', JSON.stringify({
        type: 'steering_queued',
        steering: steeringMessage(inserted),
      }));
      return steeringMessage(inserted);
    }, actor);
  }

  async pendingSteering(actor: string, taskId: string): Promise<SteeringMessage[]> {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      const rows = await c.query("SELECT * FROM workpivot.run_steering_messages WHERE task_id=$1 AND status IN ('pending','deferred') ORDER BY created_at,id", [taskId]);
      return rows.rows.map(row => steeringMessage(row as SteeringRow));
    }, actor);
  }

  async unclassifiedSteering(actor: string, taskId: string): Promise<SteeringMessage[]> {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      const rows = await c.query("SELECT * FROM workpivot.run_steering_messages WHERE task_id=$1 AND status='pending' ORDER BY created_at,id", [taskId]);
      return rows.rows.map(row => steeringMessage(row as SteeringRow));
    }, actor);
  }

  async applyClassifiedSteering(actor: string, run: RunHandle, id: string, reason: string): Promise<SteeringMessage | null> {
    uuid(id);
    return transaction(this.db, async c => {
      await this.active(c, run, true);
      const row = (await c.query(
        "UPDATE workpivot.run_steering_messages SET status='applied',relation='related',classification_reason=$3,applied_at=now(),run_id=$2 WHERE id=$1 AND task_id=$4 AND status='pending' RETURNING *",
        [id, run.id, reason.slice(0, 1000), run.taskId],
      )).rows[0] as SteeringRow | undefined;
      if (!row) return null;
      const appliedEvent = await event(c, actor, run, 'user', row.content);
      await c.query('UPDATE workpivot.run_steering_messages SET event_id=$2 WHERE id=$1', [id, appliedEvent.id]);
      await event(c, actor, run, 'meta', JSON.stringify({ type: 'steering_applied', steering: steeringMessage({ ...row, event_id: appliedEvent.id }) }));
      return steeringMessage({ ...row, event_id: appliedEvent.id });
    }, actor);
  }

  async deferSteering(actor: string, run: RunHandle, id: string, reason: string): Promise<SteeringMessage | null> {
    uuid(id);
    return transaction(this.db, async c => {
      await this.active(c, run, true);
      const row = (await c.query(
        "UPDATE workpivot.run_steering_messages SET status='deferred',relation='unrelated',classification_reason=$3 WHERE id=$1 AND task_id=$2 AND status='pending' RETURNING *",
        [id, run.taskId, reason.slice(0, 1000)],
      )).rows[0] as SteeringRow | undefined;
      if (!row) return null;
      await event(c, actor, run, 'meta', JSON.stringify({ type: 'steering_deferred', steering: steeringMessage(row) }));
      return steeringMessage(row);
    }, actor);
  }

  async nextDeferredSteering(actor: string, taskId: string): Promise<SteeringMessage | null> {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      const row = (await c.query(
        "SELECT * FROM workpivot.run_steering_messages WHERE task_id=$1 AND status='deferred' ORDER BY created_at,id LIMIT 1",
        [taskId],
      )).rows[0] as SteeringRow | undefined;
      return row ? steeringMessage(row) : null;
    }, actor);
  }

  async markDeferredApplied(actor: string, run: RunHandle, id: string): Promise<void> {
    uuid(id);
    await transaction(this.db, async c => {
      await this.active(c, run, true);
      const userEvent = (await c.query(
        "SELECT id FROM workpivot.conversation_events WHERE run_id=$1 AND kind='user' ORDER BY sequence LIMIT 1",
        [run.id],
      )).rows[0];
      await c.query(
        "UPDATE workpivot.run_steering_messages SET status='applied',relation='unrelated',applied_at=now(),run_id=$2,event_id=$3 WHERE id=$1 AND task_id=$4 AND status='deferred'",
        [id, run.id, userEvent?.id ?? null, run.taskId],
      );
    }, actor);
  }

  /** 只在完整工具批次结束后调用，返回后由执行器作为最新用户消息加入上下文。 */
  async takeSteering(actor: string, run: RunHandle): Promise<SteeringMessage[]> {
    return transaction(this.db, async c => {
      await this.active(c, run, true);
      const rows = await c.query(
        "SELECT * FROM workpivot.run_steering_messages WHERE task_id=$1 AND status='pending' ORDER BY created_at,id FOR UPDATE",
        [run.taskId],
      );
      if (!rows.rowCount) return [];
      const ids = rows.rows.map(row => row.id as string);
      await c.query(
        "UPDATE workpivot.run_steering_messages SET status='applied',applied_at=now(),run_id=$2 WHERE id=ANY($1::uuid[])",
        [ids, run.id],
      );
      const applied: SteeringMessage[] = [];
      for (const row of rows.rows as SteeringRow[]) {
        const appliedEvent = await event(c, actor, run, 'user', row.content);
        await c.query('UPDATE workpivot.run_steering_messages SET event_id=$2 WHERE id=$1', [row.id, appliedEvent.id]);
        applied.push(steeringMessage({ ...row, status: 'applied', run_id: run.id, applied_at: new Date(), event_id: appliedEvent.id }));
      }
      return applied;
    }, actor);
  }

  async cancelSteering(actor: string, taskId: string, id: string): Promise<void> {
    uuid(taskId); uuid(id);
    await transaction(this.db, async c => {
      await lock(c, taskId);
      const row = (await c.query(
        "UPDATE workpivot.run_steering_messages SET status='cancelled',cancelled_at=now() WHERE id=$1 AND task_id=$2 AND status IN ('pending','deferred') RETURNING *",
        [id, taskId],
      )).rows[0] as SteeringRow | undefined;
      if (!row) throw new RepositoryError(409, '运行中补充要求已应用或不存在');
      const run = (await c.query(
        "SELECT id,turn_id AS \"turnId\",fence FROM workpivot.task_runs WHERE id=$1",
        [row.run_id],
      )).rows[0] as { id: string; turnId: string; fence: string } | undefined;
      if (run) await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'steering_cancelled', steering: steeringMessage(row) }));
    }, actor);
  }

  async stop(actor: string, taskId: string): Promise<void> {
    uuid(taskId);
    await transaction(this.db, async c => {
      await lock(c, taskId);
      await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE task_id=$1 AND state IN ('pending','allowed')`, [taskId]);
      await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE task_id=$1 AND state='pending'", [taskId]);
      await c.query("UPDATE workpivot.run_steering_messages SET status='cancelled',cancelled_at=now() WHERE task_id=$1 AND status IN ('pending','deferred')", [taskId]);
      await c.query("UPDATE workpivot.task_runs SET status='stopping' WHERE task_id=$1 AND status='running'", [taskId]);
    }, actor);
  }
  async finish(actor: string, run: RunHandle, reason: StopReason, messages: ChatMessage[]): Promise<StopReason> {
    if (JSON.stringify(messages).length > 2000000) throw new RepositoryError(413, '运行上下文过大');
    return transaction(this.db, async c => {
      const current = await this.active(c, run, true);
      await c.query(`UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now(),request=${permissionSummarySql} WHERE run_id=$1 AND state IN ('pending','allowed')`, [run.id]);
      const result = current.status === 'stopping' || current.context_revoked ? 'aborted' : reason;
      // completed 运行可以保留澄清/成果验收；异常停止则让所有等待进入明确终态。
      if (result !== 'completed') await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE run_id=$1 AND state='pending'", [run.id]);
      await c.query("UPDATE workpivot.run_steering_messages SET status='cancelled',cancelled_at=now() WHERE task_id=$1 AND status='pending'", [run.taskId]);
      const status = result === 'completed' ? 'completed' : result === 'aborted' ? 'stopped' : 'failed';
      await c.query('UPDATE workpivot.task_runs SET status=$2,stop_reason=$3,model_messages=$4,finished_at=now() WHERE id=$1', [run.id, status, result, JSON.stringify(current.context_revoked ? [] : replayableMessages(messages))]);
      await event(c, actor, run, 'meta', JSON.stringify({ type: 'done', stopReason: result }));
      const waiting = result === 'completed'
        ? await c.query("SELECT 1 FROM workpivot.interactions WHERE run_id=$1 AND state='pending' AND blocking", [run.id])
        : undefined;
      await c.query('UPDATE workpivot.tasks SET status=$2,revision=revision+1 WHERE id=$1', [run.taskId, status === 'completed' ? waiting?.rowCount ? 'waiting' : 'idle' : status]);
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
        await c.query("UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE run_id=$1 AND state='pending'", [run.id]);
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
      const risk = request.risk ?? classifyInteractionRisk(request);
      request = { ...request, risk };
      const interactionFlags = interactionCapabilities();
      const silent = canAutoApprove(request, mode, risk);
      const id = randomUUID();
      const record = JSON.stringify({...request,authorizationHash:authorizationDigest(request)});
      if (silent) {
        // 静默执行：直接登记为已批准并已消费，不进入待审批列表；发布事务仍按同一调用摘要复核。
        await c.query("INSERT INTO workpivot.run_permissions(id,owner_user_id,task_id,run_id,request,state,decision,resolved_at,expires_at,risk) VALUES($1,$2,$3,$4,$5,'consumed','allow',now(),now()+$6*interval '1 minute',$7)", [id, actor, run.taskId, run.id, record, permissionTtlMinutes, risk]);
        return { id, automatic: true as const, eventId: '' };
      }
      // 任务级授权范围尚未建立，旧全局auto不能替代本次明确许可。
      await c.query("INSERT INTO workpivot.run_permissions(id,owner_user_id,task_id,run_id,request,expires_at,risk) VALUES($1,$2,$3,$4,$5,now()+$6*interval '1 minute',$7)", [id, actor, run.taskId, run.id, record, permissionTtlMinutes, risk]);
      await c.query("UPDATE workpivot.tasks SET status='waiting',revision=revision+1 WHERE id=$1", [run.taskId]);
      const reason = request.tool === 'plan'
        ? '请核对目标、数据范围、步骤、风险和验收方式后确认执行计划'
        : mode === 'manual'
          ? '确认模式：本次操作需要你核对后执行'
          : request.tool === 'execute_skill'
            ? '本次隔离执行需要确认'
            : ['web_fetch','web_search','browser_visit'].includes(request.tool)
              ? `本次${networkActionLabel(request.tool)}需要确认`
              : '本次操作需要确认，请核对对象、参数和影响';
      const interaction: InteractionEnvelope = {
        id,
        kind: request.tool === 'plan' ? 'plan_approval' : 'action_permission',
        userId: actor,
        taskId: run.taskId,
        runId: run.id,
        revision: 1,
        state: 'pending',
        blocking: true,
        risk,
        reason,
        payload: request.interactionPayload ?? {
          tool: request.tool,
          ...(request.command === undefined ? {} : { command: request.command }),
          effects: request.effects ?? [],
          risk,
          summary: request.command ?? request.tool,
          ...(interactionFlags.permissionPreview && request.invocation ? { arguments: request.invocation.arguments } : {}),
          feedbackAllowed: true,
        },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + permissionTtlMinutes * 60_000).toISOString(),
      };
      const payload = { type: 'permission_request' as const, id, tool: request.tool, command: request.tool, paths: [], scope: 'once', redacted:true, reason, risk, revision: 1, interaction };
      const saved = await event(c, actor, run, 'meta', JSON.stringify(payload));
      return { ...saved, ...payload, automatic: false as const, eventId: saved.id };
    }, actor);
  }
  async pendingPermissions(actor: string, taskId: string) {
    uuid(taskId);
    return transaction(this.db, async c => {
      await lock(c, taskId);
      return (await c.query("SELECT p.id,p.run_id AS \"runId\",p.request,p.revision,p.risk,p.created_at AS \"createdAt\",p.expires_at AS \"expiresAt\" FROM workpivot.run_permissions p JOIN workpivot.task_runs r ON r.id=p.run_id WHERE p.task_id=$1 AND p.state='pending' AND p.expires_at>now() AND r.status='running' AND r.lease_until>now() ORDER BY p.created_at,p.id", [taskId])).rows;
    }, actor);
  }
  /** 统一展示协议：动作/计划批准继续由 run_permissions 作为权威存储。 */
  async pendingInteractions(actor: string, taskId: string): Promise<InteractionEnvelope[]> {
    const rows = await this.pendingPermissions(actor, taskId);
    return rows.map((row) => {
      const request = row.request as ToolAccessRequest;
      const kind = request.tool === 'plan' ? 'plan_approval' : 'action_permission';
      const risk = (row.risk as InteractionEnvelope['risk'] | undefined) ?? classifyInteractionRisk(request);
      const interactionFlags = interactionCapabilities();
      return {
        id: row.id as string,
        kind,
        userId: actor,
        taskId,
        runId: String(row.runId),
        revision: Number(row.revision ?? 1),
        state: 'pending',
        blocking: true,
        risk,
        reason: request.tool === 'plan'
          ? '请核对目标、数据范围、步骤、风险和验收方式后确认执行计划'
          : request.command ?? request.tool,
        payload: request.interactionPayload ?? {
          tool: request.tool,
          ...(request.command === undefined ? {} : { command: request.command }),
          effects: request.effects ?? [],
          risk,
          summary: request.command ?? request.tool,
          ...(interactionFlags.permissionPreview && request.invocation ? { arguments: request.invocation.arguments } : {}),
          feedbackAllowed: true,
        },
        createdAt: new Date(row.createdAt as string | Date).toISOString(),
        expiresAt: new Date(row.expiresAt as string | Date).toISOString(),
      };
    });
  }
  async decidePermission(actor: string, taskId: string, id: string, decision: 'allow' | 'deny', feedback?: string): Promise<void> {
    uuid(taskId); uuid(id);
    if (decision !== 'allow' && decision !== 'deny') throw new RepositoryError(400, '仅支持本次允许或拒绝');
    if (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > 2000)) throw new RepositoryError(400, '反馈不能超过2000字');
    await transaction(this.db, async c => {
      await lock(c, taskId);
      const row = (await c.query('SELECT *,expires_at>now() AS live FROM workpivot.run_permissions WHERE task_id=$1 AND id=$2 FOR UPDATE', [taskId, id])).rows[0];
      if (!row) throw new RepositoryError(404, '授权请求不存在');
      if (row.decision === decision && ['allowed', 'denied', 'consumed'].includes(row.state)) return;
      if (row.state !== 'pending' || !row.live) throw new RepositoryError(409, '授权请求已失效或处理');
      const run = (await c.query("SELECT id,turn_id AS \"turnId\",fence FROM workpivot.task_runs WHERE id=$1 AND status='running' AND lease_until>now()", [row.run_id])).rows[0];
      if (!run) throw new RepositoryError(409, '任务执行已失效');
      await c.query(
        'UPDATE workpivot.run_permissions SET state=$2,decision=$3,resolved_at=now(),feedback=$4 WHERE id=$1',
        [id, decision === 'allow' ? 'allowed' : 'denied', decision, feedback?.trim() || null],
      );
      await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision, ...(feedback?.trim() ? { feedback: feedback.trim() } : {}) }));
      // 等待执行器消费审批决定后再继续，避免界面提前宣称已恢复执行。
    }, actor);
  }
  /** 旧调用方只关心三元决策；执行器使用带反馈的方法继续模型循环。 */
  async consumePermission(actor: string, run: RunHandle, id: string, expected?: ToolAccessRequest): Promise<'pending' | 'allow' | 'deny'> {
    return (await this.consumePermissionResult(actor, run, id, expected)).decision;
  }
  async consumePermissionResult(actor: string, run: RunHandle, id: string, expected?: ToolAccessRequest): Promise<{ decision: 'pending' | 'allow' | 'deny'; feedback?: string }> {
    uuid(id);
    return transaction(this.db, async c => {
      await this.active(c, run);
      const row = (await c.query('SELECT state,request,feedback,expires_at>now() AS live FROM workpivot.run_permissions WHERE id=$1 AND run_id=$2 AND task_id=$3 FOR UPDATE', [id, run.id, run.taskId])).rows[0];
      if (!row) throw new RepositoryError(404, '授权请求不存在');
      if (row.state === 'pending' && row.live) return { decision: 'pending' };
      if (row.state === 'allowed' && row.live && row.request.invocation) {
        // risk 与 authorizationHash 是服务端派生字段，不属于模型实际调用参数；
        // 兼容修复前持久化的待审批记录时必须剔除它们再核对。
        const stored = { ...row.request } as ToolAccessRequest & { authorizationHash?: string };
        delete stored.risk;
        delete stored.authorizationHash;
        if (!expected || authorizationDigest(stored) !== authorizationDigest(expected)) throw new RepositoryError(409, '审批与实际调用不一致');
      }
      if (!row.live && ['pending', 'allowed'].includes(row.state)) {
        await c.query(`UPDATE workpivot.run_permissions SET state='expired',resolved_at=now(),request=${permissionSummarySql} WHERE id=$1`, [id]);
        await event(c, actor, run, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision: 'deny', reason: 'timeout' }));
      }
      const allow = row.state === 'allowed' && row.live;
      if (allow) await c.query(`UPDATE workpivot.run_permissions SET state='consumed',request=${permissionSummarySql} WHERE id=$1`, [id]);
      await c.query("UPDATE workpivot.tasks SET status='running',revision=revision+1 WHERE id=$1 AND status='waiting'", [run.taskId]);
      return { decision: allow ? 'allow' : 'deny', ...(allow || !row.feedback ? {} : { feedback: String(row.feedback) }) };
    }, actor);
  }
}
