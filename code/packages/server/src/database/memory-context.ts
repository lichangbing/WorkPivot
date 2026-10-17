import type { PoolClient } from 'pg';
import { RepositoryError, uuid } from './connection.js';

export interface MemorySource { runId: string; evidence: string }

/** 只读取较早的用户消息，不包含未来轮次、助手输出或其他任务。 */
export async function memoryContext(c: PoolClient, taskId: string, runId: string, currentLength: number): Promise<MemorySource[]> {
  const rows = (await c.query(`SELECT DISTINCT ON (t.sequence) r.id AS "runId",e.content AS evidence,t.sequence
    FROM workpivot.task_runs current_run
    JOIN workpivot.conversation_turns current_turn ON current_turn.id=current_run.turn_id
    JOIN workpivot.conversation_turns t ON t.task_id=current_run.task_id AND t.sequence<current_turn.sequence
    JOIN workpivot.task_runs r ON r.turn_id=t.id AND r.status='completed' AND NOT r.context_revoked
    JOIN workpivot.conversation_events e ON e.turn_id=t.id AND e.kind='user'
    WHERE current_run.id=$1 AND current_run.task_id=$2 AND NOT current_run.context_revoked
    ORDER BY t.sequence DESC,r.id LIMIT 5`, [runId, taskId])).rows;
  let remaining = 24000 - currentLength;
  const context: MemorySource[] = [];
  for (const row of rows) {
    // 不得截断事实或跳过中间的大轮次后重新解释旧事实。
    if (!row.evidence || row.evidence.length > remaining) break;
    remaining -= row.evidence.length;
    context.unshift({ runId: row.runId, evidence: row.evidence });
  }
  return context;
}

/** 创建建议和确认建议时均重新检查全部依赖。 */
export async function validateMemoryContext(c: PoolClient, taskId: string, source: MemorySource, context: MemorySource[]) {
  if (!Array.isArray(context) || context.length > 5) throw new RepositoryError(400, '参考对话数量无效');
  const seen = new Set<string>();
  let length = 0;
  let currentSequence: bigint | undefined;
  for (const item of [source, ...context]) {
    uuid(item.runId);
    if (seen.has(item.runId) || typeof item.evidence !== 'string' || !item.evidence.trim()) throw new RepositoryError(400, '参考对话无效');
    seen.add(item.runId); length += item.evidence.length;
    if (length > 24000) throw new RepositoryError(400, '参考对话超过限制');
    const row = (await c.query(`SELECT e.content,t.sequence FROM workpivot.task_runs r
      JOIN workpivot.conversation_turns t ON t.id=r.turn_id
      JOIN workpivot.conversation_events e ON e.turn_id=r.turn_id AND e.kind='user'
      WHERE r.id=$1 AND r.task_id=$2 AND r.status='completed' AND NOT r.context_revoked`, [item.runId, taskId])).rows[0];
    if (!row || !row.content.includes(item.evidence)) throw new RepositoryError(409, '参考对话已失效');
    const sequence = BigInt(row.sequence);
    if (currentSequence === undefined) currentSequence = sequence;
    else if (sequence >= currentSequence) throw new RepositoryError(409, '不能引用当前轮之后的对话');
  }
}
