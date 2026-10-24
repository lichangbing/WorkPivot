/**
 * agent 循环韧性检查：早停兜底、上下文压缩、流错误重试、edit 工具、续跑判定。
 * 不依赖模型与网络：用假的 ModelClient 驱动真实 runAgentLoop。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runAgentLoop } from '../packages/core/src/loop.js';
import { compactMessages, contextChars } from '../packages/core/src/context.js';
import { editTool } from '../packages/core/src/tools.js';
import { continuationPrompt, IDLE_NUDGE } from '../packages/server/src/continuation.js';
import type { ChatMessage, ModelClient, StreamEvent } from '../packages/core/src/model/openai.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  try { await run(); checks += 1; console.log('ok', label); }
  catch (error) { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; }
}

type Turn = { text?: string; calls?: Array<{ name: string; args: string }>; fail?: boolean };
function fakeClient(turns: Turn[]) {
  let index = 0;
  const seen: ChatMessage[][] = [];
  const client = {
    providerId: 'test', model: 'test',
    async *streamChat(messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
      seen.push(structuredClone(messages));
      const turn = turns[index++];
      if (!turn) return;
      if (turn.fail) throw new Error('连接中断');
      if (turn.text) yield { type: 'delta', text: turn.text };
      if (turn.calls) yield { type: 'tool_calls', tool_calls: turn.calls.map((call, i) => ({ id: `c${index}-${i}`, type: 'function' as const, function: { name: call.name, arguments: call.args } })) };
    },
  } as unknown as ModelClient;
  return { client, seen };
}

const probe = {
  name: 'probe', kind: 'read' as const, description: 'probe', parameters: { type: 'object', properties: {} },
  async run() { return 'probe-ok'; },
};

const base = { system: 'sys', taskDir: process.cwd(), tools: [probe] };

await check('只表态不动手时追问一次并继续执行', async () => {
  const { client, seen } = fakeClient([
    { text: '我先看一下需求，接下来会整理。' },
    { calls: [{ name: 'probe', args: '{}' }] },
    { text: '已经完成。' },
  ]);
  let idleCalls = 0;
  const result = await runAgentLoop({
    ...base, client, messages: [{ role: 'user', content: '帮我生成一份周报' }], maxSteps: 10,
    idleLimit: 1,
    onIdle: ({ text }: { steps: number; toolCalls: number; text: string }) => { idleCalls += 1; assert.match(text, /我先看一下/); return IDLE_NUDGE; },
  });
  assert.equal(idleCalls, 1, '应追问一次');
  assert.equal(result.steps, 3);
  assert.equal(result.stopReason, 'completed');
  assert.ok(result.messages.some((m) => m.role === 'user' && m.content === IDLE_NUDGE));
  assert.ok(seen[1]!.some((m) => m.content === IDLE_NUDGE), '追问必须进入下一轮请求');
});

await check('onIdle 返回 null 时立即结束', async () => {
  const { client } = fakeClient([{ text: '这是直接回答。' }]);
  const result = await runAgentLoop({ ...base, client, messages: [{ role: 'user', content: '这是什么' }], maxSteps: 10, onIdle: () => null });
  assert.equal(result.steps, 1);
  assert.equal(result.stopReason, 'completed');
});

await check('idleLimit=0 关闭兜底', async () => {
  const { client } = fakeClient([{ text: '先想一下。' }]);
  let called = 0;
  const result = await runAgentLoop({ ...base, client, messages: [{ role: 'user', content: '帮我做一份表格' }], maxSteps: 10, idleLimit: 0, onIdle: () => { called += 1; return IDLE_NUDGE; } });
  assert.equal(called, 0);
  assert.equal(result.steps, 1);
});

await check('流错误且无输出时重试一次', async () => {
  const { client } = fakeClient([{ fail: true }, { text: '重试成功' }]);
  const result = await runAgentLoop({ ...base, client, messages: [{ role: 'user', content: '你好' }], maxSteps: 10 });
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.steps, 1);
  assert.match(result.messages.at(-1)?.content ?? '', /重试成功/);
});

await check('压缩旧工具结果但保留配对与近期消息', async () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 8; i += 1) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'probe', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'x'.repeat(20_000) });
  }
  messages.push({ role: 'assistant', content: '最近的结果' });
  const before = contextChars(messages);
  assert.ok(before > 120_000);
  const changed = compactMessages(messages, 120_000);
  assert.equal(changed, true);
  assert.ok(contextChars(messages) <= 120_000, '压缩后应回到预算内');
  assert.ok(messages.some((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('[已压缩]')));
  assert.ok(messages.every((m) => m.role !== 'tool' || typeof m.tool_call_id === 'string'), 'tool 消息必须保留配对 id');
  assert.equal(messages.at(-1)?.content, '最近的结果', '最近消息不动');
});

await check('预算充足时不压缩', async () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'tool', tool_call_id: 'a', content: 'y'.repeat(5000) }, { role: 'assistant', content: 'ok' }];
  assert.equal(compactMessages(messages, 120_000), false);
});

await check('edit 精确替换、歧义与 replace_all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wp-edit-'));
  try {
    const file = join(dir, 'a.md');
    await writeFile(file, '第一段\n第二段\n第二段\n', 'utf8');
    const ctx = { taskDir: dir } as never;
    assert.match(await editTool.run({ path: 'a.md', old_string: '第一段', new_string: '开头' }, ctx), /替换 1 处/);
    assert.equal(await readFile(file, 'utf8'), '开头\n第二段\n第二段\n');
    await assert.rejects(() => editTool.run({ path: 'a.md', old_string: '第二段', new_string: 'x' }, ctx), /出现 2 次/);
    await assert.rejects(() => editTool.run({ path: 'a.md', old_string: '不存在', new_string: 'x' }, ctx), /未找到目标文本/);
    assert.match(await editTool.run({ path: 'a.md', old_string: '第二段', new_string: '中间', replace_all: true }, ctx), /替换 2 处/);
    assert.equal(await readFile(file, 'utf8'), '开头\n中间\n中间\n');
    await assert.rejects(() => editTool.run({ path: 'missing.md', old_string: 'a', new_string: 'b' }, ctx), /文件不存在/);
    await assert.rejects(() => editTool.run({ path: 'a.md', old_string: '开头', new_string: '开头' }, ctx), /相同/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

await check('续跑判定只对产出型请求或已承诺动作生效', async () => {
  assert.ok(continuationPrompt('帮我生成一份周报', '好的，我先了解需求。'));
  assert.ok(continuationPrompt('继续', '接下来我会整理文件。'));
  assert.equal(continuationPrompt('这是什么？', '这是一个文件管理器。'), null);
  assert.equal(continuationPrompt('你好', '你好，有什么可以帮你？'), null);
});

console.log(`agent loop checks passed: ${checks}`);
