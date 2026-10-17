import type { Pool } from 'pg';
import { transaction } from './connection.js';
import { RunRepository } from './runs.js';

/** 只恢复状态，不重放结果不明的任意命令。 */
export async function recoverExecutions(db: Pool, actor: string) {
  const runs = new RunRepository(db);
  const tasks = await transaction(db, async c => (await c.query("SELECT DISTINCT task_id FROM workpivot.task_runs WHERE status IN ('running','stopping') AND lease_until<=now() LIMIT 100")).rows, actor);
  for (const task of tasks) await runs.recover(actor, task.task_id);
  return transaction(db, async c => (await c.query(`UPDATE workpivot.skill_executions j SET status='interrupted',error='执行中断，结果未确认；请检查已有产物后重新发起',finished_at=now()
    FROM workpivot.task_runs r WHERE j.run_id=r.id AND j.status='running' AND (r.status NOT IN ('running','stopping') OR r.context_revoked OR r.lease_until<=now()) RETURNING j.id`)).rowCount, actor);
}
