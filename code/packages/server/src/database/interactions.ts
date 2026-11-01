import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ClarificationPayload,
  InteractionEnvelope,
  InteractionKind,
  InteractionResponse,
  InteractionRisk,
} from '@workpivot/shared';
import { RepositoryError, transaction, uuid } from './connection.js';
import type { RunHandle } from './runs.js';
import { authorizationDigest } from './tool-authorization.js';

interface InteractionRow {
  id: string;
  owner_user_id: string;
  task_id: string;
  run_id: string;
  kind: InteractionKind;
  revision: number;
  state: InteractionEnvelope['state'];
  blocking: boolean;
  risk: InteractionRisk;
  reason: string;
  payload: InteractionEnvelope['payload'];
  response: unknown;
  created_at: Date;
  expires_at: Date;
}

function envelope(row: InteractionRow): InteractionEnvelope {
  return {
    id: row.id,
    kind: row.kind,
    userId: row.owner_user_id,
    taskId: row.task_id,
    runId: row.run_id,
    revision: Number(row.revision),
    state: row.state,
    blocking: row.blocking,
    risk: row.risk,
    reason: row.reason,
    payload: row.payload,
    response: row.response ?? undefined,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

function sameResponse(left: unknown, right: unknown): boolean {
  return authorizationDigest(left) === authorizationDigest(right);
}

export class InteractionRepository {
  constructor(private readonly db: Pool) {}

  /** 创建澄清或成果验收；同一运行只能有一个阻塞项。 */
  async create(
    actor: string,
    run: RunHandle,
    input: {
      kind: InteractionKind;
      reason: string;
      payload: InteractionEnvelope['payload'];
      risk?: InteractionRisk;
      blocking?: boolean;
      ttlMinutes?: number;
    },
  ): Promise<InteractionEnvelope> {
    uuid(actor);
    uuid(run.id);
    uuid(run.taskId);
    if (input.reason.trim().length < 1 || input.reason.length > 2000) throw new RepositoryError(400, '交互原因无效');
    const ttl = input.ttlMinutes ?? 30;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 1440) throw new RepositoryError(400, '交互有效期无效');
    return transaction(this.db, async (c) => {
      const live = await c.query(
        "SELECT id FROM workpivot.task_runs WHERE id=$1 AND owner_user_id=$2 AND task_id=$3 AND lease_until>now()",
        [run.id, actor, run.taskId],
      );
      if (!live.rowCount) throw new RepositoryError(409, '运行已结束，不能创建等待交互');
      try {
        const result = await c.query(
          `INSERT INTO workpivot.interactions(
             id,owner_user_id,task_id,run_id,kind,revision,blocking,risk,reason,payload,expires_at
           ) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,now()+$10*interval '1 minute')
           RETURNING *`,
          [
            randomUUID(),
            actor,
            run.taskId,
            run.id,
            input.kind,
            input.blocking ?? true,
            input.risk ?? 'low',
            input.reason.trim(),
            JSON.stringify(input.payload),
            ttl,
          ],
        );
        return envelope(result.rows[0] as InteractionRow);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23505') throw new RepositoryError(409, '当前运行已有待处理的阻塞交互');
        throw error;
      }
    }, actor);
  }

  async pending(actor: string, taskId: string): Promise<InteractionEnvelope[]> {
    uuid(taskId);
    return transaction(this.db, async (c) => {
      const task = await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [taskId]);
      if (!task.rowCount) throw new RepositoryError(404, '任务不存在');
      await c.query(
        "UPDATE workpivot.interactions SET state='expired',resolved_at=now(),updated_at=now() WHERE task_id=$1 AND state='pending' AND expires_at<=now()",
        [taskId],
      );
      const rows = await c.query(
        "SELECT * FROM workpivot.interactions WHERE task_id=$1 AND state='pending' AND expires_at>now() ORDER BY blocking DESC,created_at,id",
        [taskId],
      );
      return rows.rows.map((row) => envelope(row as InteractionRow));
    }, actor);
  }

  async get(actor: string, taskId: string, id: string, c?: PoolClient): Promise<InteractionEnvelope> {
    uuid(taskId);
    uuid(id);
    const read = async (client: PoolClient): Promise<InteractionEnvelope> => {
      const row = (await client.query(
        'SELECT * FROM workpivot.interactions WHERE id=$1 AND task_id=$2 FOR UPDATE',
        [id, taskId],
      )).rows[0];
      if (!row) throw new RepositoryError(404, '交互不存在');
      return envelope(row as InteractionRow);
    };
    return c ? read(c) : transaction(this.db, read, actor);
  }

  async respond(
    actor: string,
    taskId: string,
    id: string,
    revision: number,
    response: InteractionResponse,
  ): Promise<{ interaction: InteractionEnvelope; changed: boolean }> {
    uuid(taskId);
    uuid(id);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RepositoryError(400, '交互版本无效');
    if (response.feedback !== undefined && response.feedback.length > 2000) throw new RepositoryError(400, '反馈不能超过2000字');
    return transaction(this.db, async (c) => {
      await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 FOR UPDATE', [taskId]);
      const current = await this.get(actor, taskId, id, c);
      if (current.revision !== revision) throw new RepositoryError(409, '交互内容已变化，请刷新后重试');
      if (current.state !== 'pending') {
        if (sameResponse(current.response, response)) return { interaction: current, changed: false };
        throw new RepositoryError(409, '交互已经处理');
      }
      if (new Date(current.expiresAt).getTime() <= Date.now()) {
        await c.query("UPDATE workpivot.interactions SET state='expired',resolved_at=now(),updated_at=now() WHERE id=$1", [id]);
        throw new RepositoryError(409, '交互已过期');
      }
      const payload = current.payload as ClarificationPayload;
      if (current.kind === 'clarification') {
        if (!Array.isArray(response.answers) || response.answers.length !== payload.questions.length) {
          throw new RepositoryError(400, '请回答全部问题');
        }
        const expected = new Map(payload.questions.map((question) => [question.id, question]));
        const seen = new Set<string>();
        for (const answer of response.answers) {
          const question = expected.get(answer.questionId);
          if (!question || seen.has(answer.questionId)) throw new RepositoryError(400, '回答与问题不匹配');
          seen.add(answer.questionId);
          const values = Array.isArray(answer.value) ? answer.value : [answer.value];
          if (!question.multiSelect && values.length !== 1) throw new RepositoryError(400, '该问题只能选择一个答案');
          if (!values.length || values.length > 4 || values.some((value) => typeof value !== 'string' || !value.trim() || value.length > 500)) {
            throw new RepositoryError(400, '回答内容无效');
          }
          const labels = new Set(question.options.map((option) => option.label));
          if (values.some((value) => !labels.has(value)) && (!question.allowFreeText || values.length !== 1)) {
            throw new RepositoryError(400, '请选择有效选项或填写自由回答');
          }
        }
      } else if (current.kind === 'artifact_review') {
        if (response.decision !== 'approve' && response.decision !== 'deny') throw new RepositoryError(400, '请选择确认或退回');
        if (response.decision === 'deny' && !response.feedback?.trim()) throw new RepositoryError(400, '退回成果时需要填写原因');
      }
      const state = current.kind === 'artifact_review'
        ? response.decision === 'approve' ? 'approved' : 'denied'
        : 'answered';
      const row = (await c.query(
        'UPDATE workpivot.interactions SET state=$2,response=$3,resolved_at=now(),updated_at=now() WHERE id=$1 RETURNING *',
        [id, state, JSON.stringify(response)],
      )).rows[0];
      const remaining = await c.query(
        "SELECT 1 FROM workpivot.interactions WHERE task_id=$1 AND state='pending' AND blocking LIMIT 1",
        [taskId],
      );
      const permission = await c.query(
        "SELECT 1 FROM workpivot.run_permissions WHERE task_id=$1 AND state='pending' LIMIT 1",
        [taskId],
      );
      if (!remaining.rowCount && !permission.rowCount) await c.query("UPDATE workpivot.tasks SET status='idle',revision=revision+1 WHERE id=$1 AND status='waiting'", [taskId]);
      return { interaction: envelope(row as InteractionRow), changed: true };
    }, actor);
  }

  async cancelTask(actor: string, taskId: string, c?: PoolClient): Promise<void> {
    const cancel = async (client: PoolClient) => {
      await client.query(
        "UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE task_id=$1 AND state='pending'",
        [taskId],
      );
    };
    if (c) await cancel(c);
    else await transaction(this.db, cancel, actor);
  }

  async cancelRun(actor: string, runId: string, c?: PoolClient): Promise<void> {
    const cancel = async (client: PoolClient) => {
      await client.query(
        "UPDATE workpivot.interactions SET state='cancelled',resolved_at=now(),updated_at=now() WHERE run_id=$1 AND state='pending'",
        [runId],
      );
    };
    if (c) await cancel(c);
    else await transaction(this.db, cancel, actor);
  }
}
