/**
 * W5 端到端评测：记忆系统（E01 双层 + E02 项目记忆，模拟 LLM 零成本）。
 * 覆盖：remember 静默写入与下轮注入 / promote 确认卡（deny 不写、allow 写手写区）/
 *       forget 删除 / 一键关闭零注入 / 项目记忆跨任务共享（同目录）。
 * 运行：pnpm eval:w5
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'wp5-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp5-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟供应商：按"最后一条消息"精确路由 ----
const MOCK_PORT = 39931;
const mock: Server = createHttpServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const toolCall = (name: string, args: string): void => {
      send({ choices: [{ delta: { role: 'assistant' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: args } }] } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const final = (text: string): void => {
      send({ choices: [{ delta: { content: text } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };

    let lastUser = '';
    let lastRole = '';
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string | null }> };
      const msgs = parsed.messages ?? [];
      lastRole = msgs[msgs.length - 1]?.role ?? '';
      const users = msgs.filter((m) => m.role === 'user');
      lastUser = String(users[users.length - 1]?.content ?? '');
    } catch {
      lastUser = body;
    }

    // 工具结果轮：一律收尾（W5 场景不测试多轮工具链）
    if (lastRole === 'tool') {
      final('好的。');
      return;
    }
    if (lastUser.includes('写入项目记忆')) {
      toolCall('write', JSON.stringify({ path: '.workpivot/memory/MEMORY.md', content: '# 项目记忆\n\n预算 100 万（W5 评测写入）' }));
      return;
    }
    if (lastUser.includes('请记住')) {
      toolCall('remember', JSON.stringify({ content: '用户最喜欢的颜色是蓝色' }));
      return;
    }
    if (lastUser.includes('忘掉')) {
      toolCall('forget', JSON.stringify({ query: '颜色' }));
      return;
    }
    if (lastUser.includes('晋升为长期记忆')) {
      toolCall('promote_memory', JSON.stringify({ content: '用户最喜欢的颜色是蓝色' }));
      return;
    }
    if (body.includes('预算 100 万')) {
      final('项目预算是 100 万。');
      return;
    }
    if (body.includes('蓝色')) {
      final('蓝色。');
      return;
    }
    final('（默认回复）');
  });
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const server = await startServer({ port: 39931 + 1 });
const base = `http://127.0.0.1:${server.port}`;

await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'w5-smoke-123' }),
}).then(async (r) => {
  const { token } = (await r.json()) as { token: string };
  (globalThis as { __tok?: string }).__tok = token;
});
const auth = { authorization: `Bearer ${(globalThis as { __tok?: string }).__tok ?? ''}` };

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, { headers: { 'content-type': 'application/json', ...auth }, ...init });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function runTurn(taskId: string, content: string, decide?: () => 'allow' | 'deny'): Promise<{ events: Array<Record<string, unknown>>; text: string }> {
  const events: Array<Record<string, unknown>> = [];
  let text = '';
  const response = await fetch(`${base}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5)) as Record<string, unknown>;
      events.push(event);
      if (event['type'] === 'assistant_delta') text += String(event['text']);
      if (event['type'] === 'memory_confirm') {
        const decision = decide ? decide() : 'allow';
        await json(`/api/tasks/${taskId}/memory/confirm`, {
          method: 'POST',
          body: JSON.stringify({ id: event['id'], approve: decision !== 'deny' }),
        });
      }
    }
  }
  return { events, text };
}

try {
  await json('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });

  // ---- E01 双层记忆 ----
  const { task } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: '记忆测试' }),
  });

  const run1 = await runTurn(task.id, '请记住:我最喜欢的颜色是蓝色。');
  assert('E01 remember 静默写入并收尾', run1.text.includes('好的'));

  const view1 = await json<{ entries: Array<{ content: string }> }>(`/api/memory?taskId=${task.id}`);
  assert('E01 条目区恰有一条"蓝色"（幂等去重）', view1.entries.length === 1 && view1.entries[0]!.content.includes('蓝色'), JSON.stringify(view1.entries));

  const run2 = await runTurn(task.id, '我最喜欢什么颜色?');
  assert('E01 下轮注入:AI 答对颜色', run2.text.trim() === '蓝色。', run2.text.slice(0, 60));

  // 晋升确认流：先拒绝
  const run3 = await runTurn(task.id, '把颜色偏好晋升为长期记忆', () => 'deny');
  assert('E01 晋升触发确认卡', run3.events.some((e) => e['type'] === 'memory_confirm'));
  const denyResult = run3.events.find((e) => e['type'] === 'tool_result') as { message?: string } | undefined;
  assert('E01 拒绝后未写入', (denyResult?.message ?? '').includes('用户拒绝'));

  const view2 = await json<{ handbook: string }>(`/api/memory?taskId=${task.id}`);
  assert('E01 拒绝后手写区为空', !view2.handbook.includes('蓝色'));

  // 再晋升：允许
  await runTurn(task.id, '把颜色偏好晋升为长期记忆', () => 'allow');
  const view3 = await json<{ handbook: string }>(`/api/memory?taskId=${task.id}`);
  assert('E01 允许后写入手写区', view3.handbook.includes('用户最喜欢的颜色是蓝色'));

  // 遗忘
  await runTurn(task.id, '忘掉颜色偏好');
  const view4 = await json<{ entries: Array<{ content: string }> }>(`/api/memory?taskId=${task.id}`);
  assert('E01 forget 删除条目', !view4.entries.some((e) => e.content.includes('蓝色')));

  // 一键关闭：注入消失（手写区有内容作为判别物）
  await json('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled: false }) });
  const view5 = await json<{ enabled: boolean; handbook: string }>(`/api/memory?taskId=${task.id}`);
  assert('E01 一键关闭后 enabled=false 且手写区仍保留', view5.enabled === false && view5.handbook.includes('蓝色'));
  await json('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled: true }) });

  // ---- E02 项目记忆（同目录两任务共享）----
  const sharedDir = task.directory;
  const { task: taskB } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: '项目记忆写入', directory: sharedDir }),
  });
  await runTurn(taskB.id, '把项目关键事实:预算 100 万 写入项目记忆');
  const pmPath = join(task.directory, '.workpivot', 'memory', 'MEMORY.md');
  assert('E02 项目记忆文件存在', existsSync(pmPath));
  assert('E02 项目记忆含预算', readFileSync(pmPath, 'utf8').includes('100 万'));

  const { task: taskC } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: '项目记忆读取', directory: sharedDir }),
  });
  const runC = await runTurn(taskC.id, '项目预算是多少?');
  assert('E02 跨任务共享:AI 答对预算', runC.text.includes('100 万'), runC.text.slice(0, 60));
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W5 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
