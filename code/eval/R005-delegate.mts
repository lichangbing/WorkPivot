/**
 * R005 子代理（delegate）验收：上下文隔离、禁止递归、取消传播、失败回落、串行化与预算收敛。
 * 不依赖模型与网络：用假的 ModelClient 驱动真实 runAgentLoop 与真实 delegateTool。
 */
import assert from 'node:assert/strict';
import { runAgentLoop } from '../packages/core/src/loop.js';
import type { ChatMessage, ModelClient, StreamEvent, Tool, ToolSchema } from '../packages/core/src/index.js';
import { delegateTool } from '../packages/server/src/database/delegation.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

type Turn = { text?: string; calls?: Array<{ name: string; args: string }>; fail?: string };
/** 按系统提示判断是子代理还是父代理，分别取不同的脚本。 */
function fakeClient(parent: Turn[], child: Turn[]) {
  const calls: Array<{ system: string; messages: ChatMessage[]; tools: string[] }> = [];
  let parentIndex = 0;
  let childIndex = 0;
  const client = {
    providerId: 'test',
    model: 'test',
    async *streamChat(messages: ChatMessage[], schemas: ToolSchema[]): AsyncGenerator<StreamEvent> {
      const system = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      const isChild = system.includes('[子代理模式]');
      calls.push({ system, messages: structuredClone(messages), tools: schemas.map((schema) => schema.name) });
      const turn = isChild ? child[childIndex++] : parent[parentIndex++];
      if (!turn) return;
      if (turn.fail) throw new Error(turn.fail);
      if (turn.text) yield { type: 'delta', text: turn.text };
      if (turn.calls) {
        yield {
          type: 'tool_calls',
          tool_calls: turn.calls.map((call, index) => ({
            id: `${isChild ? 'child' : 'parent'}-${index}-${calls.length}`,
            type: 'function' as const,
            function: { name: call.name, arguments: call.args },
          })),
        };
      }
    },
  } as unknown as ModelClient;
  return { client, calls };
}

const probe: Tool = {
  name: 'probe', kind: 'read', description: 'probe', parameters: { type: 'object', properties: {} },
  async run() { return 'probe-ok'; },
};

await check('子代理只拿任务与背景，父对话历史不进入子请求', async () => {
  const { client, calls } = fakeClient(
    [{ calls: [{ name: 'delegate', args: JSON.stringify({ task: '总结这份资料', context: '背景材料' }) }] }, { text: '父代理完成' }],
    [{ text: '子结论：共 3 条' }],
  );
  const delegate = delegateTool({ client, tools: [probe], system: '父规则', emit: () => undefined });
  const result = await runAgentLoop({
    client, tools: [probe, delegate], system: '父规则', taskDir: process.cwd(),
    messages: [{ role: 'user', content: '父对话机密-PARENT-SECRET' }], maxSteps: 6,
  });
  assert.equal(result.stopReason, 'completed');
  const child = calls.filter((call) => call.system.includes('[子代理模式]'));
  assert.equal(child.length, 1, '子代理应只被调用一次');
  const childText = JSON.stringify(child[0]!.messages);
  assert.ok(childText.includes('总结这份资料'), '子请求应包含任务');
  assert.ok(childText.includes('背景材料'), '子请求应包含背景');
  assert.ok(!childText.includes('PARENT-SECRET'), '父历史不能进入子请求');
  assert.equal(child[0]!.messages.length, 2, '子请求只有 system + 一条 user');
});

await check('子工具集剔除 delegate 与 ask_user，禁止递归与二次提问', async () => {
  const { client, calls } = fakeClient(
    [{ calls: [{ name: 'delegate', args: JSON.stringify({ task: '独立子任务' }) }] }, { text: '父代理完成' }],
    [{ text: '子结论' }],
  );
  const other: Tool = { name: 'ask_user', kind: 'read', description: 'ask', parameters: { type: 'object', properties: {} }, async run() { return '{}'; } };
  const delegate = delegateTool({ client, tools: [probe, other], system: '父规则', emit: () => undefined });
  await runAgentLoop({ client, tools: [probe, other, delegate], system: '父规则', taskDir: process.cwd(), messages: [{ role: 'user', content: '委派一下' }], maxSteps: 6 });
  const child = calls.find((call) => call.system.includes('[子代理模式]'));
  assert.deepEqual(child?.tools.sort(), ['probe'], '子工具集只应有 probe');
});

await check('子循环失败不炸父任务，错误以工具结果文本返回', async () => {
  // 循环对首个请求有一次重试，因此让两次采样都失败才能稳定复现。
  const { client } = fakeClient([], [{ fail: '供应商 500' }, { fail: '供应商 500' }]);
  const delegate = delegateTool({ client, tools: [probe], system: '父规则', emit: () => undefined });
  const text = await delegate.run({ task: '会失败的子任务' }, { taskDir: process.cwd() });
  const parsed = JSON.parse(text) as { stopReason: string; result: string };
  assert.equal(parsed.stopReason, 'error');
});

await check('父级取消立即传播，子循环不再采样', async () => {
  const { client, calls } = fakeClient(
    [{ calls: [{ name: 'delegate', args: JSON.stringify({ task: '长任务' }) }] }, { text: '不应走到这里' }],
    [{ text: '子代理第一段' }],
  );
  const delegate = delegateTool({ client, tools: [probe], system: '父规则', emit: () => undefined });
  const controller = new AbortController();
  controller.abort();
  const text = await delegate.run({ task: '长任务' }, { taskDir: process.cwd(), signal: controller.signal });
  const parsed = JSON.parse(text) as { stopReason: string };
  assert.equal(parsed.stopReason, 'aborted');
  assert.equal(calls.filter((call) => call.system.includes('[子代理模式]')).length, 0, '已取消时不应再发起子采样');
});

await check('并发两次委派串行执行，不并行叠加', async () => {
  let active = 0;
  let peak = 0;
  const { client } = fakeClient([], [{ text: '子结论' }, { text: '子结论' }]);
  const slow = {
    ...client,
    async *streamChat(messages: ChatMessage[], schemas: ToolSchema[]): AsyncGenerator<StreamEvent> {
      if (String(messages[0]?.content ?? '').includes('[子代理模式]')) {
        active += 1; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      }
      yield* client.streamChat(messages, schemas);
    },
  } as unknown as ModelClient;
  const delegate = delegateTool({ client: slow, tools: [probe], system: '父规则', emit: () => undefined });
  await Promise.all([
    delegate.run({ task: '任务 A' }, { taskDir: process.cwd() }),
    delegate.run({ task: '任务 B' }, { taskDir: process.cwd() }),
  ]);
  assert.equal(peak, 1, '两次委派不能并行');
});

await check('max_steps 越界直接拒绝，合法值收敛到子循环', async () => {
  const { client } = fakeClient([], [{ text: '子结论' }]);
  const delegate = delegateTool({ client, tools: [probe], system: '父规则', emit: () => undefined });
  await assert.rejects(() => delegate.run({ task: '越界', max_steps: 999 }, { taskDir: process.cwd() }), /max_steps/);
  await assert.rejects(() => delegate.run({ task: '零步', max_steps: 0 }, { taskDir: process.cwd() }), /max_steps/);
  await assert.rejects(() => delegate.run({ task: '' }, { taskDir: process.cwd() }), /task/);
  const ok = JSON.parse(await delegate.run({ task: '正常', max_steps: 50 }, { taskDir: process.cwd() })) as { steps: number };
  assert.equal(ok.steps, 1);
});

await check('子代理事件带 delegateId 前缀转发', async () => {
  const { client } = fakeClient([], [{ text: '子结论' }]);
  const forwarded: Array<{ type: string; delegateId?: string }> = [];
  const delegate = delegateTool({ client, tools: [probe], system: '父规则', emit: (event) => { forwarded.push(event); } });
  await delegate.run({ task: '带事件' }, { taskDir: process.cwd() });
  assert.ok(forwarded.length > 0, '应有子事件转发');
  assert.ok(forwarded.every((event) => typeof event.delegateId === 'string' && event.delegateId.length > 0), '子事件必须带 delegateId');
});

console.log(`\nR005 子代理：${checks} 项通过`);
