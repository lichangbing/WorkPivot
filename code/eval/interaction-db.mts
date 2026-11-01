/** 真实 PostgreSQL 交互/计划仓库验收；只使用临时项目和任务，结束后物理清理。 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { transaction } from '../packages/server/src/database/connection.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { RunRepository } from '../packages/server/src/database/runs.js';
import { InteractionRepository } from '../packages/server/src/database/interactions.js';
import { PlanRepository } from '../packages/server/src/database/plans.js';
import { DatabaseExecution } from '../packages/server/src/database/execution.js';
import type { ModelClient, StreamEvent } from '../packages/core/src/index.js';

process.env['WORKPIVOT_CODE_APPROVAL'] = 'confirm';
const databaseUrl = process.env['WORKPIVOT_DATABASE_URL'];
const actor = process.env['WORKPIVOT_TEST_ACTOR'];
const baseUrl = process.env['WORKPIVOT_BASE_URL'];
const token = process.env['WORKPIVOT_TEST_TOKEN'];
if (!databaseUrl || !actor || !baseUrl || !token) throw Error('需要 WORKPIVOT_DATABASE_URL、WORKPIVOT_TEST_ACTOR、WORKPIVOT_BASE_URL 与 WORKPIVOT_TEST_TOKEN');
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Pool } = require('pg') as typeof import('pg');
const db = new Pool({ connectionString: databaseUrl, max: 2 });
const workspace = new WorkspaceRepository(db);
const runs = new RunRepository(db);
const interactions = new InteractionRepository(db);
const plans = new PlanRepository(db);
let projectId = '', taskId = '', queuedTaskId = '', runId = '', interactionId = '';
let checks = 0;
const check = (value: unknown, label: string) => { assert.ok(value, label); checks++; };

try {
  const project = await workspace.createProject(actor, '交互验收临时项目');
  projectId = project.id;
  const task = await workspace.createTask(actor, '交互验收临时任务', project.id);
  taskId = task.id;
  let run = await runs.start(actor, task.id, randomUUID(), '生成测试交付');
  runId = run.id;

  const steeringRequest = randomUUID();
  const steeringResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/steering`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: steeringRequest, content: '金额按200万计算，不沿用旧值' }),
  });
  assert.equal(steeringResponse.status, 202);
  const steering = ((await steeringResponse.json()) as { steering: { id: string; status: string } }).steering;
  check(steering.status === 'pending' && (await runs.pendingSteering(actor, task.id)).length === 1, '运行中补充要求持久化排队');
  const appliedSteering = await runs.applyClassifiedSteering(actor, run, steering.id, '属于当前报告金额口径纠正');
  check(appliedSteering?.status === 'applied' && appliedSteering.relation === 'related', '相关消息在安全边界更新当前运行');
  check((await runs.pendingSteering(actor, task.id)).length === 0, '已应用补充从等待队列移除');
  const duplicateSteering = await runs.queueSteering(actor, task.id, steeringRequest, '金额按200万计算，不沿用旧值');
  check(duplicateSteering.id === steering.id, '同一 requestId 的运行中补充保持幂等');
  const unrelatedSteering = await runs.queueSteering(actor, task.id, randomUUID(), '另外再生成一份产品路线图');
  const deferred = await runs.deferSteering(actor, run, unrelatedSteering.id, '属于当前报告完成后的独立交付');
  check(deferred?.status === 'deferred' && deferred.relation === 'unrelated', '无关请求进入当前任务之后的队列');
  check((await runs.unclassifiedSteering(actor, task.id)).length === 0, '已分类后续请求不会再次注入当前上下文');

  const plan = await plans.save(actor, task.id, {
    goal: '生成测试交付',
    data_scope: ['当前任务资料'],
    business_rules: ['测试数据不得外发'],
    steps: [{ step: '生成成果', status: 'in_progress' }],
    outputs: ['测试.txt'],
    verification: ['核对文件已登记'],
  });
  check(plan.revision === 1 && plan.hash.length === 64, '计划保存并生成稳定哈希');
  await plans.markApproved(actor, task.id, plan.id, plan.revision);
  check((await plans.latest(actor, task.id))?.status === 'approved', '计划批准状态持久化');

  const clarification = await interactions.create(actor, run, {
    kind: 'clarification',
    reason: '请选择报告格式',
    payload: {
      questions: [{
        id: randomUUID(),
        question: '请选择报告格式',
        options: [{ label: 'PDF', recommended: true }, { label: 'Word' }],
        allowFreeText: true,
        multiSelect: false,
      }],
    },
  });
  interactionId = clarification.id;
  check((await interactions.pending(actor, task.id)).length === 1, '澄清交互按任务持久化');
  await assert.rejects(() => interactions.create(actor, run, {
    kind: 'clarification', reason: '第二个阻塞问题', payload: { questions: [] },
  }), /阻塞交互/);
  runId = run.id;
  await runs.finish(actor, run, 'completed', []);
  check((await workspace.listTasks(actor)).find(item => item.id === task.id)?.status === 'waiting', '完成运行存在待回答澄清时任务进入等待');
  const waitingSteeringResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/steering`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), content: '澄清期间补充：报告需要包含风险页' }),
  });
  check(waitingSteeringResponse.status === 202, '等待澄清时仍可先提交通知后续补充');
  const question = (clarification.payload as { questions: Array<{ id: string }> }).questions[0]!;
  const answered = await interactions.respond(actor, task.id, clarification.id, clarification.revision, {
    answers: [{ questionId: question.id, value: ['PDF'] }],
  });
  check(answered.changed && answered.interaction.state === 'answered', '回答后交互进入终态');
  check((await workspace.listTasks(actor)).find(item => item.id === task.id)?.status === 'idle', '回答澄清后任务退出等待');
  const repeated = await interactions.respond(actor, task.id, clarification.id, clarification.revision, {
    answers: [{ questionId: question.id, value: ['PDF'] }],
  });
  check(!repeated.changed, '重复回答保持幂等');
  await assert.rejects(() => interactions.respond(actor, task.id, clarification.id, clarification.revision, {
    answers: [{ questionId: question.id, value: ['Word'] }],
  }), /已经处理/);

  run = await runs.start(actor, task.id, randomUUID(), '继续执行测试交付');
  runId = run.id;
  const waitingSteering = await runs.takeSteering(actor, run);
  check(waitingSteering.some(item => item.content.includes('风险页')), '下一运行在首个安全边界应用等待期间补充');
  const currentPlan = await plans.latest(actor, task.id);
  assert.ok(currentPlan);
  const planPermission = await runs.requestPermission(actor, run, {
    external: true, tool: 'plan', kind: 'write', paths: [], effects: ['write'],
    binding: { planId: currentPlan.id, planRevision: currentPlan.revision, planHash: currentPlan.hash },
    interactionPayload: { plan: currentPlan },
  });
  const planList = await (await fetch(`${baseUrl}/api/tasks/${task.id}/interactions`, { headers: { authorization: `Bearer ${token}` } })).json() as { interactions: Array<{ id: string; kind: string }> };
  check(planList.interactions.some(item => item.id === planPermission.id && item.kind === 'plan_approval'), 'HTTP 统一列表展示计划审批');
  const changedPlan = {
    ...currentPlan,
    goal: '生成测试交付并增加业务复核',
    outputs: ['测试.txt', '复核说明.md'],
  };
  const changedResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/interactions/${planPermission.id}/respond`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, response: { decision: 'deny', feedback: '计划已修改', plan: changedPlan } }),
  });
  assert.equal(changedResponse.status, 200);
  check((await plans.latest(actor, task.id))?.revision === currentPlan.revision + 1, '用户修改计划生成新 revision');
  check((await plans.latest(actor, task.id))?.goal.includes('业务复核'), '用户修改后的计划内容持久化');
  const planDecision = await runs.consumePermissionResult(actor, run, planPermission.id);
  check(planDecision.decision === 'deny' && planDecision.feedback?.includes('用户修改了计划'), '计划修改使旧动作许可失效并反馈模型');

  const permission = await runs.requestPermission(actor, run, {
    external: true, tool: 'synthetic_send', kind: 'write', paths: [], command: '发送测试成果', effects: ['external'],
  });
  const pendingResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/interactions`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(pendingResponse.status, 200);
  const pendingBody = await pendingResponse.json() as { interactions: Array<{ id: string; kind: string; risk: string; runId: string }> };
  const pendingAction = pendingBody.interactions.find(item => item.id === permission.id);
  check(pendingAction?.kind === 'action_permission' && pendingAction.risk === 'high' && pendingAction.runId === run.id, 'HTTP 统一列表绑定高风险动作与运行');
  const decisionResponse = await fetch(`${baseUrl}/api/tasks/${task.id}/interactions/${permission.id}/respond`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, response: { decision: 'deny', feedback: '收件人未确认' } }),
  });
  assert.equal(decisionResponse.status, 200);
  const decision = await runs.consumePermissionResult(actor, run, permission.id);
  check(decision.decision === 'deny' && decision.feedback === '收件人未确认', '拒绝原因持久化并回传执行器');

  const artifact = await interactions.create(actor, run, {
    kind: 'artifact_review', blocking: false, reason: '测试成果验收',
    payload: { artifacts: [{ id: randomUUID(), name: '测试.txt' }], machineVerified: true, verificationNotes: ['完整性检查通过'] },
  });
  check((await interactions.pending(actor, task.id)).some(item => item.id === artifact.id), '非阻塞成果验收可与运行终态共存');
  await interactions.respond(actor, task.id, artifact.id, artifact.revision, { decision: 'approve' });
  check((await interactions.pending(actor, task.id)).length === 0, '成果验收确认后从待处理列表移除');

  await runs.finish(actor, run, 'completed', []);
  const nextDeferred = await runs.nextDeferredSteering(actor, task.id);
  check(nextDeferred?.content.includes('产品路线图'), '当前运行完成后可取到下一条独立请求');
  assert.ok(nextDeferred);
  const deferredRun = await runs.start(actor, task.id, nextDeferred.requestId, nextDeferred.content);
  await runs.markDeferredApplied(actor, deferredRun, nextDeferred.id);
  check((await runs.pendingSteering(actor, task.id)).length === 0, '后续独立请求开始新运行后从队列移除');
  await runs.finish(actor, deferredRun, 'completed', []);

  const interruptedRun = await runs.start(actor, task.id, randomUUID(), '恢复前原始任务');
  await runs.checkpoint(actor, interruptedRun, [{ role: 'user', content: '恢复前原始任务' }], 1, 20);
  await runs.queueSteering(actor, task.id, randomUUID(), '恢复后补充：补齐2025年数据');
  await transaction(db, c => c.query("UPDATE workpivot.task_runs SET lease_until=now()-interval '1 second' WHERE id=$1", [interruptedRun.id]), actor);
  await runs.recover(actor, task.id);
  check((await workspace.listTasks(actor)).find(item => item.id === task.id)?.status === 'interrupted', '租约失效后任务进入中断状态');
  check((await runs.pendingSteering(actor, task.id)).length === 1, '崩溃恢复保留尚未应用的运行中补充');
  const resumed = await runs.resume(actor, task.id);
  const recoveredSteering = await runs.takeSteering(actor, resumed);
  check(recoveredSteering.length === 1 && recoveredSteering[0]?.runId === resumed.id, '续跑在新的运行中应用恢复前补充要求');
  check((await runs.pendingSteering(actor, task.id)).length === 0, '续跑应用后补充队列清空');
  await runs.finish(actor, resumed, 'completed', []);
  const currentTask = (await workspace.listTasks(actor)).find(item => item.id === task.id);
  assert.ok(currentTask);
  await new WorkspaceRepository(db, false).deleteTask(actor, task.id, currentTask.revision);
  check(!(await workspace.listTasks(actor)).some(item => item.id === task.id), '删除任务会级联清理计划、交互和运行中补充');

  const queuedTask = await workspace.createTask(actor, '自动队列验收任务', project.id);
  queuedTaskId = queuedTask.id;
  const fakeClient = {
    providerId: 'test',
    model: 'test',
    async *streamChat(messages: Array<{ role: string; content: string | null }>): AsyncGenerator<StreamEvent> {
      const system = messages.find(message => message.role === 'system')?.content ?? '';
      if (system.includes('任务关系分类器')) {
        yield { type: 'delta', text: '{"relation":"unrelated","reason":"路线图是当前报告完成后的独立交付"}' };
      } else if (messages.some(message => message.content?.includes('产品路线图'))) {
        yield { type: 'delta', text: '产品路线图已完成。' };
      } else {
        yield { type: 'delta', text: '当前季度报告已完成。' };
      }
    },
  } as unknown as ModelClient;
  const execution = new DatabaseExecution(db, async () => ({
    client: fakeClient,
    tools: [],
    system: '测试系统',
    taskDir: '.',
    maxSteps: 4,
  }));
  const first = await execution.begin(actor, queuedTask.id, '生成季度经营报告', randomUUID());
  assert.ok(first.execute);
  await runs.queueSteering(actor, queuedTask.id, randomUUID(), '另外再生成一份产品路线图');
  const finalReason = await first.execute!(() => undefined);
  check(finalReason === 'completed', '当前任务完成后自动执行后续队列');
  const queuedRunCount = await transaction(db, c => c.query(
    'SELECT count(*)::int AS n FROM workpivot.task_runs WHERE task_id=$1',
    [queuedTask.id],
  ).then(result => Number(result.rows[0].n)), actor);
  check(queuedRunCount === 2, '独立请求自动创建下一轮运行而不混入当前上下文');
  const queuedSteering = await transaction(db, c => c.query(
    'SELECT status,relation FROM workpivot.run_steering_messages WHERE task_id=$1',
    [queuedTask.id],
  ).then(result => result.rows[0]), actor);
  check(queuedSteering?.status === 'applied' && queuedSteering.relation === 'unrelated', '后续请求完成状态和分类原因持久化');
  await new WorkspaceRepository(db, false).deleteTask(actor, queuedTask.id, (await workspace.listTasks(actor)).find(item => item.id === queuedTask.id)!.revision);

  console.log(`真实 PostgreSQL 交互与计划：${checks} 项通过`);
} finally {
  await transaction(db, async c => {
    for (const id of [taskId, queuedTaskId].filter(Boolean)) {
      await c.query('DELETE FROM workpivot.run_steering_messages WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.interactions WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.task_plans WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.run_permissions WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.tool_dispatches WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.conversation_events WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.task_runs WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.conversation_turns WHERE task_id=$1', [id]);
      await c.query('DELETE FROM workpivot.tasks WHERE id=$1', [id]);
    }
    await c.query('DELETE FROM workpivot.project_members WHERE project_id=$1', [projectId]);
    await c.query('DELETE FROM workpivot.projects WHERE id=$1', [projectId]);
  }, actor).catch(() => undefined);
  await db.end();
  void runId;
  void interactionId;
}
