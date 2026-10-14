import { compactedHistory } from './compaction.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentEvent, ChatMessage, StopReason, ToolAccessRequest } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface RunHandle { id: string; taskId: string; turnId: string; fence: string; duplicate: boolean }
const leaseSeconds = 30;
/** Interrupted tool groups cannot be replayed as unmatched model protocol messages. */
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
  async start(actor: string, taskId: string, requestId: string, content: string, attachments: string[] = []): Promise<RunHandle> {
    uuid(taskId); uuid(requestId);
    if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(id => typeof id !== 'string')) throw new RepositoryError(400, '附件列表无效');
    attachments.forEach(uuid); attachments = attachments.map(id => id.toLowerCase());
    if (new Set(attachments).size !== attachments.length) throw new RepositoryError(400, '附件不能重复');
    if (typeof content !== 'string' || !content.trim() || content.length > 200000) throw new RepositoryError(400, '消息内容无效');
    return transaction(this.db, async c => {
      const task = await lock(c, taskId);
      const old = (await c.query('SELECT id,turn_id AS "turnId",fence,attachment_ids FROM workpivot.task_runs WHERE task_id=$1 AND request_id=$2', [taskId, requestId])).rows[0];
      if (old) {
        const original = (await c.query("SELECT content FROM workpivot.conversation_events WHERE turn_id=$1 AND kind='user' ORDER BY sequence LIMIT 1", [old.turnId])).rows[0];
        if (original?.content !== content || JSON.stringify(old.attachment_ids) !== JSON.stringify(attachments)) throw new RepositoryError(409, '重复请求内容不同');
        return { ...old, taskId, duplicate: true };
      }
      if (['queued', 'running', 'waiting'].includes(task.status)) throw new RepositoryError(409, '任务仍在执行，请先停止或恢复中断状态');
      if (attachments.length) {
        const valid = await c.query('SELECT v.id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.task_id=$1 AND v.id=ANY($2::uuid[])', [taskId, attachments]);
        if (valid.rowCount !== attachments.length) throw new RepositoryError(404, '附件已删除或不属于当前任务');
      }
      const run: RunHandle = { id: randomUUID(), taskId, turnId: randomUUID(), fence: randomUUID(), duplicate: false };
      const seq = (await c.query("UPDATE workpivot.tasks SET next_turn_sequence=next_turn_sequence+1,status='running',revision=revision+1 WHERE id=$1 RETURNING next_turn_sequence-1 AS sequence", [taskId])).rows[0].sequence;
      await c.query('INSERT INTO workpivot.conversation_turns(id,owner_user_id,task_id,sequence,request_id) VALUES($1,$2,$3,$4,$5)', [run.turnId, actor, taskId, seq, requestId]);
      await c.query("INSERT INTO workpivot.task_runs(id,owner_user_id,task_id,turn_id,request_id,fence,status,lease_until) VALUES($1,$2,$3,$4,$5,$6,'running',now()+$7*interval '1 second')", [run.id, actor, taskId, run.turnId, requestId, run.fence, leaseSeconds]);
      await event(c, actor, run, 'user', content);
      await c.query("UPDATE workpivot.task_runs SET expert_snapshot=(SELECT jsonb_build_object('id',e.id,'revision',e.revision,'settings',e.settings) FROM workpivot.tasks t JOIN workpivot.experts e ON e.id=t.expert_id WHERE t.id=$2 AND NOT e.public AND NOT e.disabled) WHERE id=$1",[run.id,taskId]);
      await c.query('UPDATE workpivot.task_runs SET attachment_ids=$2,memory_epoch=COALESCE((SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=workpivot.actor_id()),0) WHERE id=$1', [run.id, attachments]);
      return run;
    }, actor);
  }
  private async active(c: PoolClient, run: RunHandle, allowStopping = false) {
    await lock(c, run.taskId);
    const row = (await c.query('SELECT status,context_revoked,lease_until>now() AS live FROM workpivot.task_runs WHERE id=$1 AND task_id=$2 AND fence=$3 FOR UPDATE', [run.id, run.taskId, run.fence])).rows[0];
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
    const content = value.type === 'assistant_delta' || value.type === 'reasoning_delta' ? value.text ?? '' : JSON.stringify(value);
    if (content.length > 200000) throw new RepositoryError(413, '运行事件过大');
    const kind = value.type === 'assistant_delta' ? 'assistant' : value.type === 'reasoning_delta' ? 'thinking' : value.type === 'tool_use' || value.type === 'tool_result' ? value.type : 'meta';
    return transaction(this.db, async c => { await this.active(c, run); return event(c, actor, run, kind, content); }, actor);
  }
  async stop(actor: string, taskId: string): Promise<void> {
    uuid(taskId);
    await transaction(this.db, async c => {
      await lock(c, taskId);
      await c.query("UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now() WHERE task_id=$1 AND state IN ('pending','allowed')", [taskId]);
      await c.query("UPDATE workpivot.task_runs SET status='stopping' WHERE task_id=$1 AND status='running'", [taskId]);
    }, actor);
  }
  async finish(actor: string, run: RunHandle, reason: StopReason, messages: ChatMessage[]): Promise<StopReason> {
    if (JSON.stringify(messages).length > 2000000) throw new RepositoryError(413, '运行上下文过大');
    return transaction(this.db, async c => {
      const current = await this.active(c, run, true);
      await c.query("UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now() WHERE run_id=$1 AND state IN ('pending','allowed')", [run.id]);
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
      const runs = (await c.query("UPDATE workpivot.task_runs SET status='interrupted',stop_reason='lease_expired',finished_at=now() WHERE task_id=$1 AND status IN ('running','stopping') AND lease_until<=now() RETURNING id,turn_id AS \"turnId\",fence", [taskId])).rows;
      for (const run of runs) await c.query("UPDATE workpivot.run_permissions SET state='cancelled',resolved_at=now() WHERE run_id=$1 AND state IN ('pending','allowed')", [run.id]);
      for (const run of runs) await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'done', stopReason: 'interrupted' }));
      if (runs.length) await c.query("UPDATE workpivot.tasks SET status='interrupted',revision=revision+1 WHERE id=$1", [taskId]);
      return runs.length > 0;
    }, actor);
  }
  async history(actor: string, run: RunHandle): Promise<ChatMessage[]> {
    return transaction(this.db, async c => {
      await this.active(c, run);
      return compactedHistory(c, run.taskId);
    }, actor);
  }
  async requestPermission(actor: string, run: RunHandle, request: ToolAccessRequest) {
    // Initial port only supports one-shot external calls, never arbitrary paths or shell approval.
    if (!request.external || request.paths.length || request.kind !== 'write' || !request.tool || JSON.stringify(request).length > 24000) throw new RepositoryError(400, '此类授权尚未接入数据库');
    return transaction(this.db, async c => {
      await this.active(c, run);
      const id = randomUUID();
      const automatic = request.tool === 'execute_skill' && (await c.query("SELECT value FROM workpivot.user_settings WHERE key='execution.mode'")).rows[0]?.value === 'auto';
      await c.query("INSERT INTO workpivot.run_permissions(id,owner_user_id,task_id,run_id,request,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '3 minutes')", [id, actor, run.taskId, run.id, JSON.stringify(request)]);
      if (automatic) await c.query("UPDATE workpivot.run_permissions SET state='allowed',decision='allow',resolved_at=now() WHERE id=$1", [id]);
      else await c.query("UPDATE workpivot.tasks SET status='waiting',revision=revision+1 WHERE id=$1", [run.taskId]);
      const payload = { type: 'permission_request' as const, id, tool: request.tool, command: request.command, paths: [], scope: 'once', reason: request.tool === 'execute_skill' ? '本次隔离执行需要确认' : '本次MCP外部调用需要确认' };
      const saved = await event(c, actor, run, 'meta', JSON.stringify(automatic ? { type: 'permission_resolved', id, decision: 'allow', reason: '自动模式：本次隔离执行', tool: request.tool } : payload));
      return { ...saved, ...payload, automatic, eventId: saved.id };
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
      await c.query('UPDATE workpivot.run_permissions SET state=$2,decision=$3,resolved_at=now() WHERE id=$1', [id, decision === 'allow' ? 'allowed' : 'denied', decision]);
      await event(c, actor, { ...run, taskId, duplicate: false }, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision }));
      // Keep waiting until the executor consumes the decision, so UI cannot claim execution resumed early.
    }, actor);
  }
  async consumePermission(actor: string, run: RunHandle, id: string): Promise<'pending' | 'allow' | 'deny'> {
    uuid(id);
    return transaction(this.db, async c => {
      await this.active(c, run);
      const row = (await c.query('SELECT state,expires_at>now() AS live FROM workpivot.run_permissions WHERE id=$1 AND run_id=$2 AND task_id=$3 FOR UPDATE', [id, run.id, run.taskId])).rows[0];
      if (!row) throw new RepositoryError(404, '授权请求不存在');
      if (row.state === 'pending' && row.live) return 'pending';
      if (!row.live && ['pending', 'allowed'].includes(row.state)) {
        await c.query("UPDATE workpivot.run_permissions SET state='expired',resolved_at=now() WHERE id=$1", [id]);
        await event(c, actor, run, 'meta', JSON.stringify({ type: 'permission_resolved', id, decision: 'deny', reason: 'timeout' }));
      }
      const allow = row.state === 'allowed' && row.live;
      if (allow) await c.query("UPDATE workpivot.run_permissions SET state='consumed' WHERE id=$1", [id]);
      await c.query("UPDATE workpivot.tasks SET status='running',revision=revision+1 WHERE id=$1 AND status='waiting'", [run.taskId]);
      return allow ? 'allow' : 'deny';
    }, actor);
  }
}
