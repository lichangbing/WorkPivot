import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { MemorySuggestions } from '../packages/server/src/database/memory-suggestions.js';
import { MemoryWorker } from '../packages/server/src/database/memory-worker.js';
import { transaction } from '../packages/server/src/database/connection.js';

export async function testMemoryReview(db: Pool, actor: string, check: (v: unknown, name: string) => void) {
  const w = new WorkspaceRepository(db), runs = new RunRepository(db), proposals = new MemorySuggestions(db);
  const task = await w.createTask(actor, 'pending memory review');
  const complete = async (text: string) => {
    const run = await runs.start(actor, task.id, randomUUID(), text);
    await runs.finish(actor, run, 'completed', []);
    return { runId: run.id, evidence: text };
  };
  const first = await complete('报告使用中文');
  const original = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', first.evidence, undefined, undefined, first, [], { dedupeKey: '报告|语言|中文' });
  const next = await complete('改用英文');
  let calls = 0;
  const worker = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat(messages) {
    calls++;
    if (calls === 2) check(JSON.parse(messages[1]!.content!).pending.some((p: { id: string }) => p.id === original.id), 'worker compares candidate with prior pending proposals');
    yield { type: 'delta', text: JSON.stringify(calls === 1 ? [{ scope: 'task', content: '报告使用英文', evidence: '改用英文', query: '报告语言' }] : { action: 'add', content: '报告使用英文', replaces: [original.id], dedupeKey: '报告|语言|英文' }) };
  } }));
  await worker.enqueue(actor, task.id, next.runId);
  await worker.process(actor);
  const active = (await proposals.list(actor)).filter(s => s.taskId === task.id);
  check(active.length === 1 && active[0].content === '报告使用英文' && active[0].replacedCount === 1, 'correction atomically replaces pending proposal and exposes replacement notice');
  const old = await transaction(db, async c => (await c.query('SELECT * FROM workpivot.memory_suggestions WHERE id=$1', [original.id])).rows[0], actor);
  check(old.status === 'stale' && old.replaced_by === active[0].id && !old.content && !old.source_context.length, 'superseded candidate loses its text and contextual copies');
  let denied = false;
  try { await proposals.decide(actor, original.id, true); } catch { denied = true; }
  check(denied, 'old confirmation button cannot save superseded proposal');
  check(!(await w.listMemories(actor, 'task', task.id)).memories.length, 'replacement never auto-publishes memory');
  await proposals.decide(actor, active[0].id, false);
  const rejectedRow = await transaction(db, async c => (await c.query('SELECT content,evidence,review_key FROM workpivot.memory_suggestions WHERE id=$1', [active[0].id])).rows[0], actor);
  check(!rejectedRow.content && !rejectedRow.evidence && rejectedRow.review_key === '报告|语言|英文', 'rejection keeps only compact semantic key, not rejected proposal text');
  const paraphrase = await complete('以后报告都用英语写');
  const duplicate = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '报告采用英语撰写', undefined, undefined, paraphrase, [], { dedupeKey: '报告 | 语言 | 英文' });
  check(duplicate.id === active[0].id && duplicate.status === 'rejected', 'normalized equivalent rejected fact stays suppressed');
  const changed = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '报告使用法语', undefined, undefined, paraphrase, [], { dedupeKey: '报告|语言|法语' });
  check(changed.status === 'pending', 'different fact value is not suppressed by rejection');
  const scoped = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'user', '个人报告使用英文', undefined, undefined, paraphrase, [], { dedupeKey: '报告|语言|英文' });
  check(scoped.status === 'pending', 'rejection does not cross memory scopes');
  const latest = await complete('这次改为德语');
  denied = false;
  try { await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '报告使用德语', undefined, undefined, { ...latest, context: [paraphrase] }, [], { replaces: [active[0].id] }); } catch { denied = true; }
  check(denied, 'late correction cannot override a user rejection');
  denied = false;
  try { await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '缺来源的替代', undefined, undefined, latest, [], { replaces: [changed.id] }); } catch { denied = true; }
  check(denied, 'replacement requires all original context dependencies');
  denied = false;
  try { await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '跨层替代', undefined, undefined, { ...latest, context: [paraphrase] }, [], { replaces: [scoped.id] }); } catch { denied = true; }
  check(denied, 'replacement cannot cross memory scopes');
  check((await proposals.list(actor)).some(s => s.id === changed.id), 'invalid replacements leave original pending card intact');
  await proposals.decide(actor, changed.id, true);
  denied = false;
  try { await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '迟到替代', undefined, undefined, { ...latest, context: [paraphrase] }, [], { replaces: [changed.id] }); } catch { denied = true; }
  check(denied, 'late correction cannot override confirmed memory');
  const size12 = await complete('报告字号12');
  const size14 = await complete('报告字号14');
  const back12 = await complete('还是改回字号12');
  const a = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '字号12', undefined, undefined, size12);
  const b = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '字号14', undefined, undefined, { ...size14, context: [size12] }, [], { replaces: [a.id] });
  const again = await proposals.propose(actor, task.id, await proposals.epoch(actor), 'task', '字号12', undefined, undefined, { ...back12, context: [size12, size14] }, [], { replaces: [b.id] });
  check(again.id !== a.id && again.status === 'pending', 'explicit correction can return to a previously superseded value');
  check(!(await proposals.list(actor)).some(s => s.id === b.id), 'reverting a correction also supersedes the intermediate proposal');
  await transaction(db, c => c.query('UPDATE workpivot.task_runs SET context_revoked=true WHERE id=$1', [next.runId]), actor);
  const cleared = await transaction(db, async c => (await c.query('SELECT review_key FROM workpivot.memory_suggestions WHERE id=$1', [active[0].id])).rows[0], actor);
  check(cleared.review_key === null, 'source revocation clears the rejection semantic key');
}
