import {publicToolEvent} from './tool-events.js';
import {delegateTool} from './delegation.js';
import {askUserTool} from './ask-user.js';
import {needsPlanGate, shouldAskNetwork} from './plan-gate.js';
import type {RunResourceScope} from './resource-scope.js';
import {authorizeTools} from './tool-authorization.js';
import { runAgentLoop, type AgentEvent, type RunAgentOptions, type StopReason } from '@workpivot/core';
import type { Pool } from 'pg';
import { RepositoryError, transaction } from './connection.js';
import { RunRepository, type RunHandle } from './runs.js';
import type { CompactionService } from './compaction.js';
import { InteractionRepository } from './interactions.js';
import { PlanRepository, planForApproval } from './plans.js';
import { interactionCapabilities, type SteeringMessage } from '@workpivot/shared';
import { classifySteering } from './steering-router.js';

/** 由可信服务器服务配置，不接受 HTTP 提供的路径、密钥或工具。 */
export type PrepareExecution = (actor: string, taskId: string, context: { run?: RunHandle; resources?:RunResourceScope; content?: string }) => Promise<Omit<RunAgentOptions, 'messages' | 'onEvent' | 'signal'>>;
export type DurableEvent = Omit<AgentEvent, 'type'> & { type: AgentEvent['type'] | 'permission_request' | 'permission_resolved'; id: string; sequence: string; turnId: string; runId: string; eventId?: string };
export class DatabaseExecution {
  readonly runs: RunRepository;
  readonly interactions: InteractionRepository;
  readonly plans: PlanRepository;
  private readonly controllers = new Map<string, { actor: string; taskId: string; controller: AbortController }>();
  constructor(private readonly db: Pool, private readonly prepare: PrepareExecution, private readonly onCompleted?: (actor: string, taskId: string, runId: string) => Promise<void>, readonly compaction?: CompactionService) {
    this.runs = new RunRepository(db);
    this.interactions = new InteractionRepository(db);
    this.plans = new PlanRepository(db);
  }
  async begin(actor: string, taskId: string, content: string, requestId: string, attachments: string[] = [], resourceSelection?:unknown) {
    await this.runs.recover(actor, taskId);
    const resources=await this.runs.resources(actor,taskId,resourceSelection,attachments,requestId);
    const context: { run?: RunHandle; resources?:RunResourceScope; content?: string } = {resources, content};
    const options = await this.prepare(actor, taskId, context);
    await this.compaction?.guard(actor, taskId, content, {system:options.system,tools:options.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))}, requestId,resources?.epoch);
    const run = await this.runs.start(actor, taskId, requestId, content, attachments,resources);
    context.run = run;
    if (run.duplicate) return { run, execute: undefined };
    const controller = new AbortController(); this.controllers.set(run.id, { actor, taskId, controller });
    let executed = false;
    return { run, execute: async (send: (event: DurableEvent) => void): Promise<StopReason> => {
      if (executed) throw new RepositoryError(409, '运行已经启动');
      executed = true;
      let reason: StopReason = 'error', heartbeatPending = false, persistenceFailed = false;
      const timer = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        void this.runs.heartbeat(actor, run).then(live => { if (!live) controller.abort(); }).catch(() => { persistenceFailed = true; controller.abort(); }).finally(() => { heartbeatPending = false; });
      }, 5000);
      timer.unref();
      try {
        const messages = await this.runs.history(actor, run);
        // O-17：确认模式下联网只在首次确认，本轮其余网络工具放行（MCP 仍逐次）。
        let networkApproved = false;
        let networkDenied = false;
        // O-16：确认模式下首个写入/执行动作前确认一次执行计划，本轮不再逐次拦。
        let planApproved = false;
        let approvedPlanHash: string | null = null;
        const interactionFlags = interactionCapabilities();
        const completedArtifacts = new Map<string, { id: string; name: string; versionId?: string }>();
        // 同一轮可能有多个只读工具并发。授权表只保留一个待处理请求，
        // 因此访问判定必须串行；首个联网许可会覆盖后续同类只读调用。
        let accessQueue: Promise<void> = Promise.resolve();
        const serializedAccess = async <T>(action: () => Promise<T>): Promise<T> => {
          const previous = accessQueue;
          let release!: () => void;
          accessQueue = new Promise<void>(resolve => { release = resolve; });
          await previous;
          try { return await action(); } finally { release(); }
        };
        const performAccess: NonNullable<RunAgentOptions['requestAccess']> = options.requestAccess ?? (async request => {
          const gate = request.tool === 'plan';
          if (!gate && (!request.external || request.paths.length || request.kind !== 'write')) return false;
          const networkRequest = !gate && shouldAskNetwork(request.tool, networkApproved);
          if (!gate && networkDenied && networkRequest) return false;
          // 非网络写入和隔离执行也必须进入统一许可登记；不能因“不是网络工具”直接放行，
          // 否则发布事务会找不到与本次调用摘要匹配的 consumed 记录。
          const permission = await this.runs.requestPermission(actor, run, request);
          // 静默执行已在登记时记为已批准并已消费，不弹卡也不等待人工决定。
          if (permission.automatic) return true;
          try { send(permission); } catch { /* 断线后仍可查询待处理请求。 */ }
          while (!controller.signal.aborted) {
            const decision = await this.runs.consumePermissionResult(actor, run, permission.id, request);
            if (decision.decision !== 'pending') {
              const allowed = decision.decision === 'allow';
              // approved=false 时只有网络工具需要询问，这里正好用来判断“是不是网络工具”。
              if (allowed && networkRequest) networkApproved = true;
              else if (!allowed && networkRequest) networkDenied = true;
              if (!allowed) throw new Error(`用户拒绝了本次操作，操作未执行。${decision.feedback ? `拒绝原因：${decision.feedback}` : '请调整方案或停止，不得原样重试。'}`);
              return allowed;
            }
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, 500); controller.signal.addEventListener('abort', done, { once: true });
              if (controller.signal.aborted) done();
            });
          }
          return false;
        });
        const baseAccess: NonNullable<RunAgentOptions['requestAccess']> = request => serializedAccess(() => performAccess(request));
        const requestAccess: NonNullable<RunAgentOptions['requestAccess']> = async request => {
          const allowed = await baseAccess(request);
          if (allowed && request.tool === 'plan') planApproved = true;
          return allowed;
        };
        const authorized = authorizeTools(options.tools,async(tool,args)=>{
          if(resources)await this.runs.checkResources(actor,run,resources,args);
          // O-16：确认模式下，只读阶段不打扰；第一个写入/执行动作前确认一次计划，本轮随后不再拦。
          if(planApproved&&approvedPlanHash){
            const current=await this.plans.latest(actor,taskId);
            if(current?.hash!==approvedPlanHash){planApproved=false;approvedPlanHash=null;}
          }
          if(planApproved)return;
          if(!needsPlanGate(tool))return;
          if(!interactionFlags.planApproval){planApproved=true;return;}
          let plan=await this.plans.latest(actor,taskId);
          let completeness=planForApproval(plan);
          if(!plan||!completeness.complete){
            // 简单任务可能直接进入执行；用当前目标、已选范围和真实工具补成可审阅的最小计划。
            plan=await this.plans.save(actor,taskId,{
              goal:content.trim().slice(0,4000),
              assumptions:[...(plan?.assumptions??[]),'用户未另行指定模板时采用当前资料可支持的标准结构'],
              data_scope:plan?.dataScope.length?plan.dataScope:[
                ...(resources?.versionIds.length?[`已选文件版本 ${resources.versionIds.length} 个`]:[]),
                ...(resources?.memoryScopes.length?[`记忆层级：${resources.memoryScopes.join('、')}`]:[]),
                '当前任务已确认的读取范围',
              ],
              business_rules:plan?.businessRules??[],
              steps:plan?.steps.length?plan.steps:[{step:`执行 ${tool.displayName??tool.name} 并核对结果`,status:'in_progress'}],
              external_actions:plan?.externalActions??[],
              outputs:plan?.outputs.length?plan.outputs:['用户要求的最终成果'],
              risks:plan?.risks.length?plan.risks:['自动生成的最小计划可能未覆盖全部业务约束'],
              verification:plan?.verification.length?plan.verification:['核对成果已登记、格式可打开且内容符合当前请求'],
            });
            completeness=planForApproval(plan);
          }
          if(!completeness.complete)throw Error(`执行计划不完整，缺少：${completeness.missing.join('、')}。请先调用 update_plan 补全后再执行。`);
          const planRequest={
            tool:'plan',kind:'write' as const,paths:[],effects:['write' as const],external:true,
            risk:'medium' as const,
            binding:{planId:plan.id,planRevision:plan.revision,planHash:plan.hash},
            interactionPayload:{plan},
          };
          const allowed=await requestAccess(planRequest);
          if(!allowed)throw Error('用户未确认执行计划，本次执行已停止');
          await this.plans.markApproved(actor,taskId,plan.id,plan.revision);
          approvedPlanHash=plan.hash;
        },async(tool,result)=>{
          if(resources&&tool.name==='propose_schedule'){await this.runs.grantSchedule(actor,run,resources,JSON.parse(result).id);return;}
          if(!resources||!['save_artifact','execute_skill','run_code','browser_visit'].includes(tool.name))return;
          const value=JSON.parse(result);const ids=tool.name==='save_artifact'?[value.id]:(value.artifacts??(value.artifact?[value.artifact]:[])).map((v:{id:string})=>v.id);
          await this.runs.grantArtifacts(actor,run,resources,ids);
        });
        // 子代理事件与父事件共用同一条持久化通道，靠 delegateId 区分父子。
        const emit = async (value: AgentEvent) => {
          value=publicToolEvent(value);
          if(value.type==='tool_result'&&value.ok&&['save_artifact','execute_skill','run_code','create_pdf'].includes(value.toolName??'')){
            try{
              const parsed=JSON.parse(value.message??'') as Record<string,unknown>;
              const candidates=[parsed,...(Array.isArray(parsed['artifacts'])?parsed['artifacts']:[])].filter(item=>item&&typeof item==='object'&&typeof (item as Record<string,unknown>)['id']==='string') as Array<Record<string,unknown>>;
              for(const artifact of candidates){
                const id=String(artifact['id']);
                completedArtifacts.set(id,{id,name:String(artifact['name']??artifact['filename']??'成果'),...(typeof artifact['versionId']==='string'?{versionId:artifact['versionId']}:{})});
              }
            }catch{
              // 工具结果不是结构化成果时仍可由文件列表完成验收。
            }
          }
          try {
            // R006：父代理的工具派发与结束都要落库，恢复时据此判断"已派发但结果未知"。
            if (!value.delegateId && value.callId) {
              if (value.type === 'tool_use') await this.runs.dispatch(actor, run, value.callId, value.toolName ?? 'unknown');
              else if (value.type === 'tool_result') await this.runs.settle(actor, run, value.callId, value.ok ? 'completed' : 'failed');
            }
            const saved = await this.runs.append(actor, run, value);
            // 事件提交成功后才能通知客户端。
            try { send({ ...value, ...saved }); } catch { /* 客户端可通过持久化事件重连。 */ }
          } catch (error) { persistenceFailed = true; controller.abort(); throw error; }
        };
        const asking = askUserTool({
          emit: async batch => {
            const first=batch.questions[0]!;
            if(!interactionFlags.clarifyV2){
              await emit({
                type:'ask_user',
                questionId:batch.interactionId,
                question:first.question,
                options:first.options,
                allowFreeText:first.allowFreeText,
              });
              return;
            }
            const interaction=await this.interactions.create(actor,run,{
              kind:'clarification',
              reason:first.question,
              risk:'low',
              payload:{questions:batch.questions},
            });
            await emit({
              type:'interaction_request',
              interaction,
            });
            // 兼容尚未升级的客户端：同时写入旧 ask_user 事件。
            await emit({
              type:'ask_user',
              questionId:batch.interactionId,
              question:first.question,
              options:first.options,
              allowFreeText:first.allowFreeText,
            });
          },
        });
        const planning=this.plans.tool(actor,taskId,async plan=>{
          planApproved=false;approvedPlanHash=null;
          await emit({type:'plan_update',steps:plan.steps,plan});
        });
        const delegation = delegateTool({
          client: options.client,
          tools: authorized,
          system: options.system,
          requestAccess,
          filePolicy: options.filePolicy,
          executeCommand: options.executeCommand,
          contextBudget: options.contextBudget,
          signal: controller.signal,
          emit: (event, delegateId) => emit({ ...event, delegateId }),
        });
        const result = await runAgentLoop({ ...options, tools: [...authorized, delegation, asking, planning], requestAccess, messages, signal: controller.signal,
          consumeSteering: async currentMessages => {
            const candidates = await this.runs.unclassifiedSteering(actor, taskId);
            const related: SteeringMessage[] = [];
            for (const candidate of candidates) {
              const classification = candidate.relation === 'related'
                ? { relation: 'related' as const, reason: candidate.classificationReason ?? '用户确认的资源范围变更' }
                : await classifySteering(options.client, currentMessages, candidate.content, controller.signal);
              if (classification.relation === 'related') {
                const applied = await this.runs.applyClassifiedSteering(actor, run, candidate.id, classification.reason);
                if (applied) related.push(applied);
              } else {
                await this.runs.deferSteering(actor, run, candidate.id, classification.reason);
              }
            }
            if (related.length) { planApproved = false; approvedPlanHash = null; }
            return related;
          },
          onEvent: emit,
          // R006：每个 step 结束写检查点（完整消息数组 + 步数），中断恢复以它为准。
          onCheckpoint: (checkpointMessages, step) => this.runs.checkpoint(actor, run, checkpointMessages, step, options.maxSteps ?? 0),
        });
        if(result.stopReason==='completed'&&interactionFlags.artifactReview&&completedArtifacts.size){
          const interaction=await this.interactions.create(actor,run,{
            kind:'artifact_review',
            reason:'成果已生成，请核对内容与验收要求',
            risk:'low',
            blocking:false,
            payload:{artifacts:[...completedArtifacts.values()],machineVerified:true,verificationNotes:['文件已登记为当前任务成果','内容正确性与业务口径仍需用户确认']},
          });
          await emit({type:'interaction_request',interaction});
        }
        reason = await this.runs.finish(actor, run, persistenceFailed ? 'error' : result.stopReason, result.messages.slice(messages.length + 1));
      } catch {
        reason = controller.signal.aborted && !persistenceFailed ? 'aborted' : 'error';
        // 过期执行器不得将新运行标记完成；仓库层对每次写入检查栅栏。
        try { reason = await this.runs.finish(actor, run, reason, []); } catch { /* 租约恢复保留中断状态。 */ }
      } finally { clearInterval(timer); this.controllers.delete(run.id); }
      if (reason === 'completed' && this.onCompleted) { try { await this.onCompleted(actor, taskId, run.id); } catch { /* 持久化恢复稍后可将已完成运行加入队列。 */ } }
      if (reason === 'completed') {
        const deferred = await this.runs.nextDeferredSteering(actor, taskId);
        if (deferred) {
          const next = await this.begin(actor, taskId, deferred.content, deferred.requestId);
          if (next.execute) {
            await this.runs.markDeferredApplied(actor, next.run, deferred.id);
            await next.execute(send);
          }
        }
      }
      return reason;
    } };
  }
  async stop(actor: string, taskId: string): Promise<void> {
    await this.runs.stop(actor, taskId);
    for (const local of this.controllers.values()) if (local.actor === actor && local.taskId === taskId) local.controller.abort();
    // 其他服务器进程通过持久化心跳感知停止。
  }
  /**
   * 服务完成当前运行后若在启动后续队列前退出，deferred 消息会留在数据库。
   * 恢复扫描只领取已空闲且没有活动运行的任务，保持原 requestId 与幂等语义。
   */
  async resumeDeferred(actor: string): Promise<number> {
    const candidates = await transaction(this.db, async c => (await c.query(`
      SELECT t.id
      FROM workpivot.tasks t
      WHERE t.owner_user_id=$1 AND t.deleted_at IS NULL AND t.status='idle'
        AND EXISTS(SELECT 1 FROM workpivot.run_steering_messages s WHERE s.task_id=t.id AND s.status='deferred')
        AND NOT EXISTS(SELECT 1 FROM workpivot.task_runs r WHERE r.task_id=t.id AND r.status IN ('running','stopping'))
      ORDER BY t.updated_at,t.id LIMIT 20`, [actor])).rows.map(row => String(row.id)), actor);
    let started = 0;
    for (const taskId of candidates) {
      const deferred = await this.runs.nextDeferredSteering(actor, taskId);
      if (!deferred) continue;
      try {
        const next = await this.begin(actor, taskId, deferred.content, deferred.requestId);
        if (!next.execute) continue;
        await this.runs.markDeferredApplied(actor, next.run, deferred.id);
        void next.execute(() => { /* 事件由持久化通道补拉。 */ }).catch(() => { /* 失败保留中断/停止状态供用户处理。 */ });
        started += 1;
      } catch { /* 单个任务失败不阻塞其他任务恢复。 */ }
    }
    return started;
  }
}
