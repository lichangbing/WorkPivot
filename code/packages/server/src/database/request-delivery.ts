import type { Pool } from 'pg';
import {
  deriveRequestDeliveries,
  interactionCapabilities,
  type RequestDeliveryResumeLink,
  type RequestDeliveryRun,
  type RequestDeliveryView,
} from '@workpivot/shared';
import { RepositoryError, transaction, uuid } from './connection.js';

interface DeliveryRunRow extends Omit<RequestDeliveryRun, 'createdAt' | 'finishedAt' | 'lastVisibleAt'> {
  sequence: string;
  createdAt: Date | string;
  finishedAt: Date | string | null;
  lastVisibleAt: Date | string | null;
}

const iso = (value: Date | string | null | undefined): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * 从现有运行和事件派生交付状态，不复制正文，也不把工具过程当作助手答复。
 * 最多读取最近 200 个运行，覆盖当前会话页和续跑链；历史页按根 turn 再过滤。
 */
export class RequestDeliveryRepository {
  constructor(private readonly db: Pool) {}

  async views(actor: string, taskId: string, rootTurnIds?: readonly string[]): Promise<RequestDeliveryView[]> {
    uuid(taskId);
    rootTurnIds?.forEach(uuid);
    if (!interactionCapabilities().deliveryState) return [];
    return transaction(this.db, async (client) => {
      const task = await client.query(
        'SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL',
        [taskId],
      );
      if (!task.rowCount) throw new RepositoryError(404, '任务不存在');
      const runs = (await client.query<DeliveryRunRow>(
        `SELECT r.id, r.turn_id AS "turnId", r.request_id AS "requestId", r.status,
                r.stop_reason AS "stopReason", r.created_at AS "createdAt",
                r.finished_at AS "finishedAt", t.sequence,
                EXISTS(
                  SELECT 1 FROM workpivot.conversation_events u
                  WHERE u.run_id=r.id AND u.kind='user'
                ) AS "hasUserEvent",
                visible.id AS "lastVisibleEventId",
                visible.created_at AS "lastVisibleAt"
         FROM workpivot.task_runs r
         JOIN workpivot.conversation_turns t ON t.id=r.turn_id AND t.task_id=r.task_id
         LEFT JOIN LATERAL (
           SELECT e.id, e.created_at
           FROM workpivot.conversation_events e
           WHERE e.run_id=r.id AND e.kind='assistant' AND btrim(e.content)<>''
           ORDER BY e.sequence DESC LIMIT 1
         ) visible ON true
         WHERE r.task_id=$1
         ORDER BY t.sequence DESC
         LIMIT 200`,
        [taskId],
      )).rows;
      if (!runs.length) return [];
      const blocked = new Set<string>((await client.query(
        `SELECT run_id::text AS id FROM workpivot.interactions
          WHERE task_id=$1 AND state='pending' AND blocking AND expires_at>now()
         UNION
         SELECT run_id::text AS id FROM workpivot.run_permissions
          WHERE task_id=$1 AND state='pending' AND expires_at>now()`,
        [taskId],
      )).rows.map((row) => String(row.id)));
      const resumes: RequestDeliveryResumeLink[] = [];
      const meta = (await client.query(
        `SELECT run_id AS "toRunId", content
           FROM workpivot.conversation_events
          WHERE task_id=$1 AND kind='meta' AND content LIKE '%"type":"resumed"%'
          ORDER BY sequence DESC LIMIT 200`,
        [taskId],
      )).rows;
      for (const row of meta) {
        try {
          const value = JSON.parse(String(row.content)) as { type?: unknown; from?: unknown };
          if (value.type !== 'resumed' || typeof value.from !== 'string') continue;
          resumes.push({ fromRunId: value.from, toRunId: String(row.toRunId) });
        } catch {
          // 历史损坏的 meta 不影响其他运行的交付投影。
        }
      }
      return deriveRequestDeliveries({
        taskId,
        runs: runs.map((run) => ({
          ...run,
          createdAt: iso(run.createdAt) ?? new Date(0).toISOString(),
          finishedAt: iso(run.finishedAt),
          lastVisibleAt: iso(run.lastVisibleAt),
          blocked: blocked.has(run.id),
        })),
        resumeLinks: resumes,
        ...(rootTurnIds === undefined ? {} : { rootTurnIds }),
      }).slice(0, 50);
    }, actor);
  }
}
