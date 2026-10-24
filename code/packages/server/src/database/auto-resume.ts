/**
 * R006 P4：有限自动续跑。
 *
 * 只对"没有已派发未完成工具调用"的中断任务自动续跑一次——这类中断发生在两次工具之间，
 * 没有未知副作用；有未完成的派发说明可能有副作用，必须等人确认，不能自动重放。
 *
 * 默认关闭，需要 WORKPIVOT_AUTO_RESUME=1 显式开启；每个任务最多自动续跑 1 次
 * （`tasks.resume_attempts`），避免崩溃循环。
 */
import type { Pool } from 'pg';
import type { DatabaseExecution } from './execution.js';
import { randomUUID } from 'node:crypto';

export const AUTO_RESUME_LIMIT = 1;

export interface AutoResumeCandidate {
  taskId: string;
  runId: string;
}

/** 纯判定：没有未完成派发且未超过自动续跑次数才允许。 */
export function eligibleForAutoResume(input: { openDispatches: number; attempts: number }): boolean {
  return input.openDispatches === 0 && input.attempts < AUTO_RESUME_LIMIT;
}

export function autoResumeEnabled(): boolean {
  return process.env['WORKPIVOT_AUTO_RESUME'] === '1';
}

/**
 * 找出可自动续跑的任务并发起执行（不等待完成，避免阻塞恢复循环）。
 * 返回实际发起的数量。
 */
export async function autoResumeInterrupted(db: Pool, actor: string, execution: DatabaseExecution): Promise<number> {
  if (!autoResumeEnabled()) return 0;
  const candidates: AutoResumeCandidate[] = (await db.query(`
    SELECT t.id AS "taskId", r.id AS "runId",
      (SELECT count(*) FROM workpivot.tool_dispatches d WHERE d.run_id=r.id AND d.status='dispatched') AS "openDispatches",
      t.resume_attempts AS "attempts"
    FROM workpivot.tasks t
    JOIN LATERAL (SELECT id, task_id, owner_user_id FROM workpivot.task_runs WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
    WHERE t.status='interrupted' AND t.owner_user_id=$1 AND t.deleted_at IS NULL
    ORDER BY t.updated_at DESC LIMIT 20`, [actor])).rows
    .filter((row: { openDispatches: string | number; attempts: number }) => eligibleForAutoResume({ openDispatches: Number(row.openDispatches), attempts: Number(row.attempts) }));

  let started = 0;
  for (const candidate of candidates) {
    try {
      // 先占用自动续跑额度：即使本次启动失败也不会无限重试。
      const claimed = await db.query('UPDATE workpivot.tasks SET resume_attempts=resume_attempts+1 WHERE id=$1 AND resume_attempts < $2 RETURNING id', [candidate.taskId, AUTO_RESUME_LIMIT]);
      if (!claimed.rowCount) continue;
      const startedRun = await execution.begin(actor, candidate.taskId, '自动继续上次中断的任务', randomUUID());
      if (!startedRun.execute) continue;
      // 审计：自动续跑是系统行为，必须在时间线里留痕。
      try {
        await execution.runs.append(actor, startedRun.run, { type: 'recovery', action: 'auto_resumed', from: candidate.runId });
      } catch { /* 留痕失败不阻塞续跑 */ }
      void startedRun.execute(() => { /* 事件走持久化通道，这里不推送。 */ }).catch(() => { /* 失败保持中断状态，等人工处理。 */ });
      started += 1;
    } catch { /* 单个任务失败不影响其他任务。 */ }
  }
  return started;
}
