import type { Pool } from 'pg';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { MemorySuggestions } from '../packages/server/src/database/memory-suggestions.js';
import { MemoryWorker } from '../packages/server/src/database/memory-worker.js';
import { transaction } from '../packages/server/src/database/connection.js';
import { randomUUID } from 'node:crypto';

export async function testMemoryWorker(db: Pool, actor: string, check: (value: unknown, label: string) => void) {
  const workspace = new WorkspaceRepository(db), runs = new RunRepository(db), suggestions = new MemorySuggestions(db);
  const project = await workspace.createProject(actor, 'auto memory');
  const task = await workspace.createTask(actor, 'auto extraction', project.id);
  const initialScope = await runs.resources(actor, task.id, { versionIds: [], memoryScopes: [], expert: false });
  check(initialScope.memoryScopes.join(',') === 'project,task,user', '空记忆范围按三层默认启用范围规范化');
  const run = await runs.start(actor, task.id, randomUUID(), '我的报告需要使用中文。', [], initialScope);
  await runs.finish(actor, run, 'completed', [{ role: 'assistant', content: '好的。' }]);
  await transaction(db, c => c.query("UPDATE workpivot.task_runs SET resource_scope=jsonb_set(resource_scope,'{memoryScopes}','[]'::jsonb) WHERE id=$1", [run.id]), actor);
  let calls = 0;
  const worker = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat(messages) {
    calls++;
    const input=JSON.parse(messages[1]!.content!);
    yield { type: 'delta', text: JSON.stringify(input.candidate ? { action: 'add', content: input.candidate.content, dedupeKey: input.candidate.query } : [
      { scope: 'user', content: '长期偏好中文报告', evidence: '报告需要使用中文', query: '个人|报告语言|中文' },
      { scope: 'project', content: '项目要求中文报告', evidence: '报告需要使用中文', query: '项目|报告语言|中文' },
      { scope: 'task', content: '报告使用中文', evidence: '报告需要使用中文', query: '任务|报告语言|中文' },
    ]) };
  } }));
  await worker.enqueue(actor, task.id, run.id);
  await worker.enqueue(actor, task.id, run.id);
  check(await worker.process(actor), '旧空记忆范围仍执行三层记忆提取');
  check(calls === 4, '一次提取及三条语义整理调用完成');
  const memory = (await workspace.listMemories(actor, 'task',task.id)).memories.find(m => m.content === '报告使用中文')!;
  check(memory, '无冲突的新任务记忆自动保存');
  check((await workspace.listMemories(actor,'user',project.id)).memories.some(m=>m.content==='长期偏好中文报告')&&(await workspace.listMemories(actor,'project',project.id)).memories.some(m=>m.content==='项目要求中文报告'),'无冲突的用户和项目记忆也自动保存');
  check(!(await suggestions.list(actor)).some(s => s.content === '报告使用中文'), '自动保存后不留下重复确认项');
  check(!await worker.process(actor), 'completed extraction job not replayed');
  const updateRun = await runs.start(actor, task.id, randomUUID(), '现在报告需要使用英文。');
  await runs.finish(actor, updateRun, 'completed', []);
  let updateCalls = 0;
  const updater = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat(messages) {
    updateCalls++;
    if (updateCalls === 2) check(JSON.parse(messages[1]!.content!).existing.some((m: { id: string }) => m.id === memory.id), 'paraphrased keyword still supplies existing memory for semantic correction');
    yield { type: 'delta', text: JSON.stringify(updateCalls % 2 ? [{ scope: 'task', content: '报告使用英文', evidence: '报告需要使用英文', query: '报告语言偏好' }] : { action: 'update', content: '报告使用英文', targetId: memory.id, targetRevision: memory.revision }) };
  } }));
  await updater.recover(actor);
  check(await updater.process(actor), 'worker restart recovers completed run missing job');
  const update = (await suggestions.list(actor)).find(s => s.targetId === memory.id);
  check(update, 'semantic consolidation proposes update to existing memory');
  check((await workspace.readMemory(actor, memory.id))?.content === '报告使用中文', 'semantic update still requires confirmation');
  await suggestions.decide(actor, update!.id, true);
  check((await workspace.readMemory(actor, memory.id))?.content === '报告使用英文', 'confirmed semantic update preserves logical memory id');
  const interrupted = await runs.start(actor, task.id, randomUUID(), '删除期间仍在生成');
  await workspace.deleteMemory(actor, memory.id, 2);
  check(!await runs.heartbeat(actor, interrupted), 'forget stops active run heartbeat');
  let blocked = false;
  try { await runs.append(actor, interrupted, { type: 'assistant_delta', text: '迟到的内容' }); } catch { blocked = true; }
  check(blocked, 'forget rejects late model output');
  check(await runs.finish(actor, interrupted, 'completed', [{ role: 'assistant', content: '迟到的内容' }]) === 'aborted', 'revoked run cannot finish successfully');
  const late = await transaction(db, async c => (await c.query('SELECT model_messages FROM workpivot.task_runs WHERE id=$1', [interrupted.id])).rows[0], actor);
  check(late.model_messages.length === 0, 'late completion cannot restore erased model context');
  const revoked = await transaction(db, async c => (await c.query('SELECT context_revoked FROM workpivot.task_runs WHERE id=$1', [run.id])).rows[0], actor);
  check(revoked.context_revoked, 'forget revokes historical model context');
  const next = await runs.start(actor, task.id, randomUUID(), '继续下一件事');
  check(!(await runs.history(actor, next)).some(m => String(m.content).includes('中文')), 'forgotten source and replies not replayed to next model call');
  await runs.finish(actor, next, 'completed', []);
  const invalidRun = await runs.start(actor, task.id, randomUUID(), '这不是长期事实');
  await runs.finish(actor, invalidRun, 'completed', []);
  const invalid = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat() { yield { type: 'delta', text: JSON.stringify([{ scope: 'task', content: '伪造内容', evidence: '不在原文内的证据', query: '' }]) }; } }));
  await invalid.enqueue(actor, task.id, invalidRun.id);
  await workspace.saveSetting(actor, 'memory.auto-extraction', false, 0);
  check(!await invalid.process(actor), 'automatic extraction can be disabled');
  await workspace.saveSetting(actor, 'memory.auto-extraction', true, 1);
  for (let i=0;i<3;i++) await invalid.process(actor);
  const failed = await transaction(db, async c => (await c.query('SELECT status,attempts FROM workpivot.memory_jobs WHERE run_id=$1', [invalidRun.id])).rows[0], actor);
  check(failed.status === 'failed' && failed.attempts === 3, 'invalid evidence fails with bounded retries');
  check(!(await suggestions.list(actor)).some(s => s.content === '伪造内容'), 'forged evidence never becomes suggestion');
  const sourceMemory = await suggestions.propose(actor, task.id, await suggestions.epoch(actor), 'user', '来源关联测试', undefined, undefined, { runId: next.id, evidence: '继续下一件事' });
  const confirmed = await suggestions.decide(actor, sourceMemory.id, true);
  await workspace.deleteProject(actor, project.id, project.revision);
  check(await workspace.readMemory(actor, confirmed.memoryId!) === null, 'deleting source project invalidates derived personal memory');
  const mergeTask = await workspace.createTask(actor, 'merge memories');
  const a = await workspace.createMemory(actor, '研究新能源', 'task',mergeTask.id);
  const b = await workspace.createMemory(actor, '报告标注来源', 'task',mergeTask.id);
  const targets = [a, b];
  const propose = (text: string, items = targets) => suggestions.propose(actor, mergeTask.id, '', 'task', text, undefined, undefined, undefined, items);
  let duplicateBlocked = false;
  try { await propose('重复', [a, a]); } catch { duplicateBlocked = true; }
  check(duplicateBlocked, 'merge rejects duplicate memory ids');
  const rejectable = await suggestions.propose(actor, mergeTask.id, await suggestions.epoch(actor), 'task', '拒绝合并测试', undefined, undefined, undefined, targets);
  await suggestions.decide(actor, rejectable.id, false);
  check(await workspace.readMemory(actor, a.id) && await workspace.readMemory(actor, b.id), 'rejecting merge leaves originals unchanged');
  const foreignProject = await workspace.createProject(actor, 'different scope');
  const foreignMemory = await workspace.createMemory(actor, '不应跨范围合并', 'project', foreignProject.id);
  let scopeBlocked = false;
  try { await suggestions.propose(actor, mergeTask.id, await suggestions.epoch(actor), 'task', '错误范围', undefined, undefined, undefined, [a,foreignMemory]); } catch { scopeBlocked = true; }
  check(scopeBlocked, 'merge rejects mixed memory scopes');
  let staleBlocked = false;
  try { await suggestions.propose(actor, mergeTask.id, await suggestions.epoch(actor), 'task', '过期合并', undefined, undefined, undefined, [a,{ ...b, revision: 9 }]); } catch { staleBlocked = true; }
  check(staleBlocked, 'merge rejects stale source revision');
  const mergeRun = await runs.start(actor, mergeTask.id, randomUUID(), '请整理我的研究偏好');
  await runs.finish(actor, mergeRun, 'completed', []);
  let mergeCalls = 0;
  const merger = new MemoryWorker(db, async () => ({ providerId: 'test', model: 'test', async *streamChat() {
    mergeCalls++; yield { type: 'delta', text: JSON.stringify(mergeCalls % 2 ? [{ scope: 'task', content: '整理研究偏好', evidence: '整理我的研究偏好', query: '' }] : { action: 'merge', content: '研究新能源，报告标注来源', targets }) };
  } }));
  await merger.enqueue(actor, mergeTask.id, mergeRun.id);
  await merger.process(actor);
  const merge = (await suggestions.list(actor)).find(s => s.mergeTargets.length === 2);
  check(merge?.mergeOriginals.length === 2, 'merge proposal displays every original memory');
  check(await workspace.readMemory(actor, a.id) && await workspace.readMemory(actor, b.id), 'unconfirmed merge preserves both active originals');
  const competitor = await suggestions.propose(actor, mergeTask.id, await suggestions.epoch(actor), 'task', '竞争合并', undefined, undefined, undefined, targets);
  const merged = await suggestions.decide(actor, merge!.id, true, '研究新能源；报告必须注明来源');
  check((await workspace.readMemory(actor, merged.memoryId!))?.content === '研究新能源；报告必须注明来源', 'user edited merge publishes final text');
  check(await workspace.readMemory(actor, a.id) === null && await workspace.readMemory(actor, b.id) === null, 'accepted merge removes originals from active retrieval');
  check(!(await suggestions.list(actor)).some(s => s.id === competitor.id), 'competing merge is invalidated');
  const retained = await transaction(db, async c => (await c.query('SELECT count(*)::int n FROM workpivot.memory_revisions WHERE memory_id=ANY($1::uuid[])', [[a.id,b.id]])).rows[0].n, actor);
  check(retained === 2, 'merge retains original revisions');
  const extra = await workspace.createMemory(actor, '使用中文', 'task',mergeTask.id);
  const nested = await suggestions.propose(actor, mergeTask.id, await suggestions.epoch(actor), 'task', '新能源中文研究报告注明来源', undefined, undefined, undefined, [{ id: merged.memoryId!, revision: 1 }, extra]);
  const final = await suggestions.decide(actor, nested.id, true);
  await workspace.deleteMemory(actor, final.memoryId!, 1);
  const erased = await transaction(db, async c => (await c.query('SELECT count(*)::int n FROM workpivot.memory_revisions WHERE memory_id=ANY($1::uuid[])', [[a.id,b.id,merged.memoryId,extra.id,final.memoryId]])).rows[0].n, actor);
  check(erased === 0, 'forget erases original revisions across nested merges');

}
