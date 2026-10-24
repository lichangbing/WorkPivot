/**
 * R004 结构化提问（ask_user）验收：参数校验、重复调用同 id、asked 后结束本轮不触发 idle、
 * 不占用授权通道。
 */
import assert from 'node:assert/strict';
import { runAgentLoop } from '../packages/core/src/loop.js';
import type { ModelClient, StreamEvent, Tool } from '../packages/core/src/index.js';
import { askUserTool, type AskUserQuestion } from '../packages/server/src/database/ask-user.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

const probe: Tool = {
  name: 'probe', kind: 'read', description: 'probe', parameters: { type: 'object', properties: {} },
  async run() { return 'probe-ok'; },
};

function clientWith(turns: Array<{ text?: string; calls?: Array<{ name: string; args: string }> }>) {
  let index = 0;
  const client = {
    providerId: 'test', model: 'test',
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const turn = turns[index++];
      if (!turn) return;
      if (turn.text) yield { type: 'delta', text: turn.text };
      if (turn.calls) yield { type: 'tool_calls', tool_calls: turn.calls.map((call, i) => ({ id: `c${index}-${i}`, type: 'function' as const, function: { name: call.name, arguments: call.args } })) };
    },
  } as unknown as ModelClient;
  return client;
}

await check('参数校验：超长问题、选项数量与 label 长度都拒绝', async () => {
  const tool = askUserTool({ emit: () => undefined });
  await assert.rejects(() => tool.run({ question: '问'.repeat(201) }, { taskDir: '.' }), /200/);
  await assert.rejects(() => tool.run({ question: '选一个', options: [{ label: '只有一个' }] }, { taskDir: '.' }), /2-6/);
  await assert.rejects(() => tool.run({ question: '选一个', options: Array.from({ length: 7 }, (_, i) => ({ label: `选项${i}` })) }, { taskDir: '.' }), /2-6/);
  await assert.rejects(() => tool.run({ question: '选一个', options: [{ label: '长'.repeat(41) }, { label: 'B' }] }, { taskDir: '.' }), /40/);
  await assert.rejects(() => tool.run({ question: '   ' }, { taskDir: '.' }), /不能为空/);
  await assert.rejects(() => tool.run({ question: '选一个', allow_free_text: 'yes' }, { taskDir: '.' }), /allow_free_text/);
});

await check('同一轮重复调用返回同一 questionId，不重复弹卡', async () => {
  const events: AskUserQuestion[] = [];
  const tool = askUserTool({ emit: (question) => { events.push(question); } });
  const first = JSON.parse(await tool.run({ question: '要哪种格式？', options: [{ label: 'PPT' }, { label: 'Word' }] }, { taskDir: '.' })) as AskUserQuestion & { status: string };
  const second = JSON.parse(await tool.run({ question: '换个说法再问' }, { taskDir: '.' })) as AskUserQuestion & { status: string };
  assert.equal(first.status, 'asked');
  assert.equal(second.status, 'asked');
  assert.equal(first.questionId, second.questionId);
  assert.equal(events.length, 1, '只应弹一次卡');
  assert.equal(second.question, '要哪种格式？', '重复调用不能替换已提出的问题');
});

await check('asked 后本轮立即结束，且不触发 idle 追问', async () => {
  let idle = 0;
  const emitted: string[] = [];
  const tool = askUserTool({ emit: (question) => { emitted.push(question.questionId); } });
  const client = clientWith([
    { text: '我需要先确认一下。', calls: [{ name: 'ask_user', args: JSON.stringify({ question: '要包含财务数据吗？', options: [{ label: '包含' }, { label: '不包含' }] }) }] },
    { text: '这条不应被采样' },
  ]);
  const result = await runAgentLoop({
    client, tools: [probe, tool], system: 'sys', taskDir: process.cwd(),
    messages: [{ role: 'user', content: '做一份季度报告' }], maxSteps: 6,
    onIdle: () => { idle += 1; return '继续'; },
  });
  assert.equal(result.steps, 1, '提问后不应继续采样');
  assert.equal(idle, 0, '提问后不能触发 idle 追问');
  assert.equal(result.stopReason, 'completed');
  assert.equal(emitted.length, 1);
  assert.ok(!result.messages.some((message) => message.content === '这条不应被采样'));
});

await check('提问不经过授权通道，授权拒绝不会变成提问卡', async () => {
  let accessCalls = 0;
  const tool = askUserTool({ emit: () => undefined });
  const client = clientWith([{ calls: [{ name: 'ask_user', args: JSON.stringify({ question: '范围是？', options: [{ label: '全公司' }, { label: '本部门' }] }) }] }]);
  await runAgentLoop({
    client, tools: [probe, tool], system: 'sys', taskDir: process.cwd(),
    messages: [{ role: 'user', content: '整理数据' }], maxSteps: 4,
    requestAccess: async () => { accessCalls += 1; return false; },
  });
  assert.equal(accessCalls, 0, 'ask_user 不声明 access，不应走授权判定');
});

await check('自由回答：省略 options 时仍可提出并记录 allowFreeText', async () => {
  const events: AskUserQuestion[] = [];
  const tool = askUserTool({ emit: (question) => { events.push(question); } });
  const result = JSON.parse(await tool.run({ question: '请补充报告受众' }, { taskDir: '.' })) as AskUserQuestion;
  assert.equal(result.options.length, 0);
  assert.equal(result.allowFreeText, true);
  assert.equal(events[0]?.allowFreeText, true);
});

console.log(`\nR004 结构化提问：${checks} 项通过`);
