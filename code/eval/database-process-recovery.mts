import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository, type RunHandle } from '../packages/server/src/database/runs.js';
import { transaction } from '../packages/server/src/database/connection.js';

export async function testProcessRecovery(db: Pool, actor: string, check: (v: unknown, label: string) => void) {
  const w = new WorkspaceRepository(db), task = await w.createTask(actor, 'process recovery');
  const launch = async (recover: boolean) => {
    const child = fork(fileURLToPath(new URL('./process-recovery-child.mts', import.meta.url)), [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const reply = once(child, 'message', { signal: AbortSignal.timeout(15000) });
    child.send({ url: db.options.connectionString, actor, taskId: task.id, recover });
    try { const [message] = await reply; assert(!message.error, message.error); return { child, message }; }
    catch (error) { child.kill(); throw error; }
  };
  const started = await launch(false);
  const run = started.message.run as RunHandle;
  const exit = once(started.child, 'exit'); started.child.kill('SIGKILL'); await exit;
  check(!started.child.connected, 'executor process really exits before recovery');
  // Advance the lease in this disposable DB to avoid waiting 30 seconds for expiry.
  await transaction(db, c => c.query("UPDATE workpivot.task_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [run.id]), actor);
  const restored = await launch(true);
  check(restored.message.recovered === 1, 'fresh process marks orphaned execution interrupted');
  const again = await launch(true);
  check(again.message.recovered === 0, 'another restart does not replay interrupted work');
  await assert.rejects(new RunRepository(db).append(actor, run, { type: 'assistant_delta', text: 'late output' }));
  check(true, 'dead executor handle cannot publish late events');
  const state = await transaction(db, async c => (await c.query('SELECT status,error FROM workpivot.skill_executions WHERE run_id=$1', [run.id])).rows[0], actor);
  check(state.status === 'interrupted' && state.error.includes('结果未确认'), 'durable recovery explains uncertain result to the user');
  const current = (await w.listTasks(actor)).find(t => t.id === task.id)!;
  check(current.status === 'interrupted', 'task no longer remains running after process recovery');
  await w.deleteTask(actor, task.id, current.revision);
}
