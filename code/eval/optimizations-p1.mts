/**
 * 优化第二批（O-05、O-06、O-16、O-17）验收：用量累计、转写参数限长、计划闸门与联网首次确认判定。
 */
import assert from 'node:assert/strict';
import { runAgentLoop } from '../packages/core/src/loop.js';
import type { AgentEvent, ModelClient, StreamEvent, Tool } from '../packages/core/src/index.js';
import { transcriptArgs, TRANSCRIPT_ARG_LIMIT } from '../packages/server/src/transcript-args.js';
import { needsPlanGate, shouldAskNetwork, NETWORK_TOOLS } from '../packages/server/src/database/plan-gate.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

const probe: Tool = {
  name: 'probe', kind: 'read', description: 'probe', parameters: { type: 'object', properties: {} },
  async run() { return 'ok'; },
};

function clientWith(turns: Array<{ text?: string; calls?: Array<{ name: string; args: string }>; usage?: { input: number; output: number } }>) {
  let index = 0;
  return {
    providerId: 'test', model: 'test',
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const turn = turns[index++];
      if (!turn) return;
      if (turn.text) yield { type: 'delta', text: turn.text };
      if (turn.calls) yield { type: 'tool_calls', tool_calls: turn.calls.map((call, i) => ({ id: `c${index}-${i}`, type: 'function' as const, function: { name: call.name, arguments: call.args } })) };
      if (turn.usage) yield { type: 'usage', inputTokens: turn.usage.input, outputTokens: turn.usage.output };
    },
  } as unknown as ModelClient;
}

await check('O-05 用量跨多次采样累计，并作为 usage 事件发出', async () => {
  const events: AgentEvent[] = [];
  const client = clientWith([
    { calls: [{ name: 'probe', args: '{}' }], usage: { input: 100, output: 20 } },
    { text: '完成', usage: { input: 150, output: 30 } },
  ]);
  const result = await runAgentLoop({
    client, tools: [probe], system: 'sys', taskDir: process.cwd(),
    messages: [{ role: 'user', content: '跑一下' }], maxSteps: 5,
    onEvent: (event) => { events.push(event); },
  });
  assert.deepEqual(result.usage, { inputTokens: 250, outputTokens: 50 });
  const usage = events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 1, '整轮只发一次累计用量');
  assert.equal(usage[0]?.inputTokens, 250);
  assert.equal(usage[0]?.outputTokens, 50);
});

await check('O-05 供应商不上报用量时为 0，不影响循环', async () => {
  const client = clientWith([{ text: '没有用量' }]);
  const result = await runAgentLoop({ client, tools: [probe], system: 'sys', taskDir: process.cwd(), messages: [{ role: 'user', content: 'hi' }], maxSteps: 3 });
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
});

await check('O-06 转写参数超长字段截断并标记，其余参数原样保留', async () => {
  const big = 'x'.repeat(TRANSCRIPT_ARG_LIMIT + 500);
  const result = transcriptArgs({ language: 'python', code: big, inputs: ['file-1'] }) as Record<string, unknown>;
  const code = result['code'] as { truncated: boolean; length: number; head: string };
  assert.equal(code.truncated, true);
  assert.equal(code.length, big.length);
  assert.equal(code.head.length, TRANSCRIPT_ARG_LIMIT);
  assert.equal(result['language'], 'python');
  assert.deepEqual(result['inputs'], ['file-1']);
});

await check('O-06 非对象参数原样返回', async () => {
  assert.equal(transcriptArgs('plain'), 'plain');
  assert.equal(transcriptArgs(undefined), undefined);
});

await check('O-16 计划闸门只拦写入/执行类工具', async () => {
  assert.equal(needsPlanGate({ kind: 'read', effects: ['read'] }), false);
  assert.equal(needsPlanGate({ kind: 'write', effects: ['write'] }), true);
  assert.equal(needsPlanGate({ kind: 'bash', effects: [] }), true);
  assert.equal(needsPlanGate({ kind: 'read', effects: ['network'] }), false);
  assert.equal(needsPlanGate({ kind: 'write', effects: ['execution'] }), true);
});

await check('O-17 联网首次确认后本轮其余网络工具放行，MCP 不共享', async () => {
  for (const tool of NETWORK_TOOLS) {
    assert.equal(shouldAskNetwork(tool, false), true, `${tool} 首次应确认`);
    assert.equal(shouldAskNetwork(tool, true), false, `${tool} 已确认后不再问`);
  }
  assert.equal(shouldAskNetwork('mcp__demo__search', true), false, 'MCP 不在共享列表');
  assert.equal(shouldAskNetwork('mcp__demo__search', false), false, 'MCP 不参与该判定');
  assert.equal(shouldAskNetwork('execute_skill', true), false);
});

console.log(`\n优化第二批：${checks} 项通过`);
