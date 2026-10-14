import { randomUUID } from 'node:crypto';
import { pool, transaction } from '../packages/server/src/database/connection.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { recoverExecutions } from '../packages/server/src/database/execution-recovery.js';

process.once('message', async (input: { url: string; actor: string; taskId: string; recover: boolean }) => {
  const db = pool(input.url);
  try {
    if (input.recover) {
      const count = await recoverExecutions(db, input.actor);
      await db.end(); process.send?.({ recovered: count }); process.disconnect();
    } else {
      const runs = new RunRepository(db);
      const run = await runs.start(input.actor, input.taskId, randomUUID(), 'process interruption fixture');
      await transaction(db, c => c.query('INSERT INTO workpivot.skill_executions(id,owner_user_id,run_id,task_id) VALUES($1,$2,$3,$4)', [randomUUID(), input.actor, run.id, input.taskId]), input.actor);
      process.send?.({ run });
      setInterval(() => { void runs.heartbeat(input.actor, run).catch(() => undefined); }, 5000);
    }
  } catch {
    await db.end(); process.send?.({ error: 'Fixture failed; credentials withheld' }); process.disconnect();
  }
});
