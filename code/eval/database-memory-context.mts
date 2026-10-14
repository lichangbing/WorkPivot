import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { MemorySuggestions } from '../packages/server/src/database/memory-suggestions.js';
import { MemoryWorker } from '../packages/server/src/database/memory-worker.js';
import { memoryContext } from '../packages/server/src/database/memory-context.js';
import { transaction } from '../packages/server/src/database/connection.js';

export async function testMemoryContext(db: Pool, actor: string, check: (v: unknown, label: string) => void) {
  const workspace = new WorkspaceRepository(db), runs = new RunRepository(db), proposals = new MemorySuggestions(db);
  const task = await workspace.createTask(actor, 'multi-turn memory');
  const complete = async (text: string, taskId = task.id) => {
    const run = await runs.start(actor, taskId, randomUUID(), text);
    await runs.finish(actor, run, 'completed', [{ role: 'assistant', content: '不可作为用户事实的回答' }]);
    return run;
  };
  const turns = [];
  for (let i = 0; i < 7; i++) turns.push(await complete(`历史要求${i}：报告包含引用来源。`));
  const current = await complete('改成英文，其他要求保持。');
  const future = await complete('未来轮次不可读取');
  const otherTask = await workspace.createTask(actor, 'unrelated memory');
  const other = await complete('其他任务不可读取', otherTask.id);
  let calls = 0;
  const worker = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat(messages) {
    calls++;
    if (calls === 1) {
      const data = JSON.parse(messages[1]!.content!);
      check(data.context.length === 5, 'memory context is bounded to five previous user turns');
      check(data.context[0].runId === turns[2]!.id && data.context[4].runId === turns[6]!.id, 'memory context uses chronological order and latest history');
      check(!JSON.stringify(data).includes('不可读取') && !JSON.stringify(data).includes('不可作为用户事实'), 'context excludes future turns, other tasks and assistant statements');
    }
    yield { type: 'delta', text: JSON.stringify(calls === 1 ? [{ scope: 'task', content: '报告使用英文并包含引用来源', evidence: '改成英文', query: '报告要求' }] : { action: 'add', content: '报告使用英文并包含引用来源' }) };
  } }));
  await worker.enqueue(actor, task.id, current.id);
  await worker.process(actor);
  const suggestion = (await proposals.list(actor)).find(s => s.taskId === task.id)!;
  check(suggestion?.sourceContext.length === 5, 'pending proposal exposes contextual references for review');
  check(!(await workspace.listMemories(actor, 'task', task.id)).memories.length, 'multi-turn extraction does not publish without approval');
  const saved = await proposals.decide(actor, suggestion.id, true, '英文报告须标注引用来源');
  const sources = await transaction(db, async c => (await c.query('SELECT run_id FROM workpivot.memory_sources WHERE memory_id=$1', [saved.memoryId])).rows, actor);
  check(sources.length === 6 && sources.some(s => s.run_id === turns[2]!.id), 'accepted memory retains every contextual dependency');
  const contextAfterAccept = await transaction(db, async c => (await c.query('SELECT source_context FROM workpivot.memory_suggestions WHERE id=$1', [suggestion.id])).rows[0], actor);
  check(contextAfterAccept.source_context.length === 0, 'acceptance clears redundant proposal excerpts');
  check((await workspace.readMemory(actor, saved.memoryId!))?.content === '英文报告须标注引用来源', 'user edited multi-turn memory is saved');

  const source = { runId: current.id, evidence: '改成英文' };
  for (const [run, evidence] of [[future, '未来轮次不可读取'], [other, '其他任务不可读取']] as const) {
    let denied = false;
    try { await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '无效来源', undefined, undefined, { ...source, context: [{ runId: run.id, evidence }] }); } catch { denied = true; }
    check(denied, 'proposal rejects future or foreign-task context');
  }
  const prior = { runId: turns[6]!.id, evidence: '报告包含引用来源' };
  const pending = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '待拒绝建议', undefined, undefined, { ...source, context: [prior] });
  await proposals.decide(actor, pending.id, false);
  const duplicate = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '待拒绝建议', undefined, undefined, { ...source, context: [prior] });
  check(duplicate.id === pending.id && duplicate.status === 'rejected', 'rejected duplicate cannot be proposed again');
  const rejected = await transaction(db, async c => (await c.query('SELECT source_context FROM workpivot.memory_suggestions WHERE id=$1', [pending.id])).rows[0], actor);
  check(!rejected.source_context.length, 'rejection clears contextual quotations');
  const stale = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '来源变化的建议', undefined, undefined, { ...source, context: [prior] });
  await transaction(db, c => c.query('UPDATE workpivot.task_runs SET context_revoked=true WHERE id=$1', [prior.runId]), actor);
  let denied = false;
  try { await proposals.decide(actor, stale.id, true); } catch { denied = true; }
  check(denied, 'confirmation revalidates earlier sources after extraction');
  const filtered = await transaction(db, c => memoryContext(c, task.id, current.id, 23999), actor);
  check(!filtered.length, 'oversized contextual turn is omitted without partial quotations');
  const revision = await transaction(db, async c => (await c.query('SELECT revision FROM workpivot.tasks WHERE id=$1', [task.id])).rows[0].revision, actor);
  await workspace.deleteTask(actor, task.id, revision);
  check(await workspace.readMemory(actor, saved.memoryId!) === null, 'source task deletion also erases multi-turn derived memory');
}
