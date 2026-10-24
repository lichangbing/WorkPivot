import {publicToolEvent} from './tool-events.js';
import {delegateTool} from './delegation.js';
import {askUserTool} from './ask-user.js';
import {needsPlanGate, shouldAskNetwork} from './plan-gate.js';
import type {RunResourceScope} from './resource-scope.js';
import {authorizeTools} from './tool-authorization.js';
import { runAgentLoop, type AgentEvent, type RunAgentOptions, type StopReason } from '@workpivot/core';
import type { Pool } from 'pg';
import { RepositoryError } from './connection.js';
import { RunRepository, type RunHandle } from './runs.js';
import type { CompactionService } from './compaction.js';

/** 由可信服务器服务配置，不接受 HTTP 提供的路径、密钥或工具。 */
export type PrepareExecution = (actor: string, taskId: string, context: { run?: RunHandle; resources?:RunResourceScope }) => Promise<Omit<RunAgentOptions, 'messages' | 'onEvent' | 'signal'>>;
export type DurableEvent = Omit<AgentEvent, 'type'> & { type: AgentEvent['type'] | 'permission_request' | 'permission_resolved'; id: string; sequence: string; turnId: string; runId: string; eventId?: string };
export class DatabaseExecution {
  readonly runs: RunRepository;
  private readonly controllers = new Map<string, { actor: string; taskId: string; controller: AbortController }>();
  constructor(db: Pool, private readonly prepare: PrepareExecution, private readonly onCompleted?: (actor: string, taskId: string, runId: string) => Promise<void>, readonly compaction?: CompactionService) { this.runs = new RunRepository(db); }
  async begin(actor: string, taskId: string, content: string, requestId: string, attachments: string[] = [], resourceSelection?:unknown) {
    await this.runs.recover(actor, taskId);
    const resources=await this.runs.resources(actor,taskId,resourceSelection,attachments,requestId);
    const context: { run?: RunHandle; resources?:RunResourceScope } = {resources};
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
        // O-16：确认模式下首个写入/执行动作前确认一次执行计划，本轮不再逐次拦。
        let planApproved = false;
        const baseAccess: NonNullable<RunAgentOptions['requestAccess']> = options.requestAccess ?? (async request => {
          const gate = request.tool === 'plan';
          if (!gate && (!request.external || request.paths.length || request.kind !== 'write')) return false;
          if (!gate && !shouldAskNetwork(request.tool, networkApproved)) return true;
          const permission = await this.runs.requestPermission(actor, run, request);
          // 静默执行已在登记时记为已批准并已消费，不弹卡也不等待人工决定。
          if (permission.automatic) return true;
          try { send(permission); } catch { /* 断线后仍可查询待处理请求。 */ }
          while (!controller.signal.aborted) {
            const decision = await this.runs.consumePermission(actor, run, permission.id, request);
            if (decision !== 'pending') {
              const allowed = decision === 'allow';
              // approved=false 时只有网络工具需要询问，这里正好用来判断“是不是网络工具”。
              if (allowed && !gate && shouldAskNetwork(request.tool, false)) networkApproved = true;
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
        const requestAccess: NonNullable<RunAgentOptions['requestAccess']> = async request => {
          const allowed = await baseAccess(request);
          if (allowed && request.tool === 'plan') planApproved = true;
          return allowed;
        };
        const authorized = authorizeTools(options.tools,async(tool,args)=>{
          if(resources)await this.runs.checkResources(actor,run,resources,args);
          // O-16：确认模式下，只读阶段不打扰；第一个写入/执行动作前确认一次计划，本轮随后不再拦。
          if(planApproved)return;
          if(!needsPlanGate(tool))return;
          const allowed=await requestAccess({tool:'plan',kind:'write',paths:[],effects:['write'],external:false});
          if(!allowed)throw Error('用户未确认执行计划，本次执行已停止');
        },async(tool,result)=>{
          if(resources&&tool.name==='propose_schedule'){await this.runs.grantSchedule(actor,run,resources,JSON.parse(result).id);return;}
          if(!resources||!['save_artifact','execute_skill','run_code','browser_visit'].includes(tool.name))return;
          const value=JSON.parse(result);const ids=tool.name==='save_artifact'?[value.id]:(value.artifacts??(value.artifact?[value.artifact]:[])).map((v:{id:string})=>v.id);
          await this.runs.grantArtifacts(actor,run,resources,ids);
        });
        // 子代理事件与父事件共用同一条持久化通道，靠 delegateId 区分父子。
        const emit = async (value: AgentEvent) => {
          value=publicToolEvent(value);
          try {
            const saved = await this.runs.append(actor, run, value);
            // 事件提交成功后才能通知客户端。
            try { send({ ...value, ...saved }); } catch { /* 客户端可通过持久化事件重连。 */ }
          } catch (error) { persistenceFailed = true; controller.abort(); throw error; }
        };
        const asking = askUserTool({
          // 提问本身写成可重放事件；回答走普通发消息接口，不需要挂起状态机。
          emit: (question) => emit({
            type: 'ask_user',
            questionId: question.questionId,
            question: question.question,
            options: question.options,
            allowFreeText: question.allowFreeText,
          }),
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
        const result = await runAgentLoop({ ...options, tools: [...authorized, delegation, asking], requestAccess, messages, signal: controller.signal,
          onEvent: emit,
        });
        reason = await this.runs.finish(actor, run, persistenceFailed ? 'error' : result.stopReason, result.messages.slice(messages.length + 1));
      } catch {
        reason = controller.signal.aborted && !persistenceFailed ? 'aborted' : 'error';
        // 过期执行器不得将新运行标记完成；仓库层对每次写入检查栅栏。
        try { reason = await this.runs.finish(actor, run, reason, []); } catch { /* 租约恢复保留中断状态。 */ }
      } finally { clearInterval(timer); this.controllers.delete(run.id); }
      if (reason === 'completed' && this.onCompleted) { try { await this.onCompleted(actor, taskId, run.id); } catch { /* 持久化恢复稍后可将已完成运行加入队列。 */ } }
      return reason;
    } };
  }
  async stop(actor: string, taskId: string): Promise<void> {
    await this.runs.stop(actor, taskId);
    for (const local of this.controllers.values()) if (local.actor === actor && local.taskId === taskId) local.controller.abort();
    // 其他服务器进程通过持久化心跳感知停止。
  }
}
