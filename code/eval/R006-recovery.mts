/**
 * R006 恢复逻辑验收：未闭合工具对账、幂等、续跑预算、检查点回调与工具结果分级修剪。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatMessage, ModelClient, StreamEvent, Tool } from '../packages/core/src/index.js';
import { runAgentLoop } from '../packages/core/src/loop.js';
import { pruneToolResult, TOOL_RESULT_HEAD, TOOL_RESULT_LIMIT, TOOL_RESULT_TAIL } from '../packages/core/src/context.js';
import {
  INTERRUPTED_TOOL_RESULT,
  lastAssistantHasOpenCalls,
  reconcileMessages,
  remainingSteps,
} from '../packages/server/src/database/recovery.js';

let checks = 0;
async function check(label: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

const call = (id: string, name = 'probe') => ({ id, type: 'function' as const, function: { name, arguments: '{}' } });

await check('未闭合的单个 tool_call 补一条“结果未知”，历史恢复合法', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: '删掉临时文件' },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'bash')] },
  ];
  const { messages: fixed, repaired } = reconcileMessages(messages);
  assert.equal(repaired.length, 1);
  assert.deepEqual(repaired[0], { callId: 'c1', tool: 'bash' });
  assert.equal(fixed.length, 3);
  assert.equal(fixed[2]!.role, 'tool');
  assert.equal(fixed[2]!.tool_call_id, 'c1');
  assert.equal(fixed[2]!.content, INTERRUPTED_TOOL_RESULT);
  assert.match(INTERRUPTED_TOOL_RESULT, /结果未知/);
  assert.match(INTERRUPTED_TOOL_RESULT, /重新调用/);
});

await check('部分回填：只补缺失的调用，已完成的保持不变', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'a', content: 'ok-a' },
  ];
  const { messages: fixed, repaired } = reconcileMessages(messages);
  assert.deepEqual(repaired.map((item) => item.callId), ['b']);
  assert.equal(fixed[1]!.content, 'ok-a');
  assert.equal(fixed[2]!.tool_call_id, 'b');
});

await check('全部闭合时不改写，且重复对账幂等', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: null, tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: 'done' },
    { role: 'assistant', content: '完成' },
  ];
  const first = reconcileMessages(messages);
  assert.equal(first.repaired.length, 0);
  assert.deepEqual(first.messages, messages);
  const second = reconcileMessages(first.messages);
  assert.equal(second.repaired.length, 0);
  assert.deepEqual(second.messages, messages);
});

await check('续跑预算继承剩余步数，越界时至少保留 1 步', () => {
  assert.equal(remainingSteps(0, 5), undefined, '0 表示不限制');
  assert.equal(remainingSteps(20, 8), 12);
  assert.equal(remainingSteps(20, 20), 1);
  assert.equal(remainingSteps(5, 9), 1);
});

await check('判断上下文末尾是否还有未完成的调用', () => {
  assert.equal(lastAssistantHasOpenCalls([
    { role: 'assistant', content: null, tool_calls: [call('a')] },
  ]), true);
  assert.equal(lastAssistantHasOpenCalls([
    { role: 'assistant', content: null, tool_calls: [call('a')] },
    { role: 'tool', tool_call_id: 'a', content: 'x' },
    { role: 'assistant', content: '完成' },
  ]), false);
});

await check('工具结果分级修剪：头 4096 + 尾 1024，短结果不动', () => {
  const short = 'x'.repeat(100);
  assert.equal(pruneToolResult(short), short);
  const long = `${'H'.repeat(5000)}${'M'.repeat(6000)}${'T'.repeat(2000)}`;
  const pruned = pruneToolResult(long);
  assert.ok(pruned.startsWith('H'.repeat(TOOL_RESULT_HEAD)));
  assert.ok(pruned.endsWith('T'.repeat(TOOL_RESULT_TAIL)));
  assert.match(pruned, /已裁剪 \d+ 字符/);
  assert.ok(pruned.length < long.length);
  assert.ok(long.length > TOOL_RESULT_LIMIT);
});

await check('每个 step 结束触发检查点，内容包含该步工具结果', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-r006-'));
  try {
    const checkpoints: Array<{ messages: ChatMessage[]; step: number }> = [];
    let turn = 0;
    const client = {
      providerId: 'test', model: 'test',
      async *streamChat(): AsyncGenerator<StreamEvent> {
        turn += 1;
        if (turn === 1) {
          yield { type: 'tool_calls', tool_calls: [call('c1')] };
          return;
        }
        yield { type: 'delta', text: '完成' };
      },
    } as unknown as ModelClient;
    const probe: Tool = { name: 'probe', kind: 'read', description: '', parameters: { type: 'object', properties: {} }, async run() { return '结果正文'; } };
    await runAgentLoop({
      client, tools: [probe], system: 's', taskDir: dir,
      messages: [{ role: 'user', content: '跑' }], maxSteps: 3,
      onCheckpoint: (messages, step) => { checkpoints.push({ messages: structuredClone(messages), step }); },
    });
    assert.equal(checkpoints.length, 1, '一个工具步只写一次检查点');
    const saved = checkpoints[0]!.messages;
    assert.ok(saved.some((message) => message.role === 'tool' && message.content === '结果正文'));
    assert.equal(checkpoints[0]!.step, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check('分批执行：读-写-读 不会跨写并行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-r006-batch-'));
  try {
    let active = 0, peak = 0;
    const make = (name: string, kind: 'read' | 'write'): Tool => ({
      name, kind, description: '', parameters: { type: 'object', properties: {} },
      async run() { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return name; },
    });
    let sent = false;
    const client = {
      providerId: 'test', model: 'test',
      async *streamChat(): AsyncGenerator<StreamEvent> {
        if (!sent) { sent = true; yield { type: 'tool_calls', tool_calls: [call('1', 'r1'), call('2', 'w1'), call('3', 'r2')] }; return; }
        yield { type: 'delta', text: '完成' };
      },
    } as unknown as ModelClient;
    await runAgentLoop({ client, tools: [make('r1', 'read'), make('w1', 'write'), make('r2', 'read')], system: 's', taskDir: dir, messages: [{ role: 'user', content: '跑' }], maxSteps: 3 });
    assert.equal(peak, 1, '被写操作隔开的只读调用不能并行');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

console.log(`\nR006 恢复逻辑：${checks} 项通过`);
