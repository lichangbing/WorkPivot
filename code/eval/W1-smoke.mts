/**
 * W1 端到端评测（K01 第一题，模拟 LLM 零成本）：
 * 模拟 OpenAI 兼容供应商 → 真实服务层 → 断言完整链路：
 * 验活 → 建任务 → SSE 对话（流式文本 + read 工具调用 + 结果回填）→ 转写落盘 → 历史可读。
 * 运行：pnpm eval:w1 （tsx 解释，允许 import TS 源码）
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 隔离环境：数据根/工作区都指向临时目录（必须在 import 服务层之前设置） ----
const home = mkdtempSync(join(tmpdir(), 'wp-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟 OpenAI 兼容供应商 ----
const MOCK_PORT = 39901;
let modelCalls = 0;
const mock: Server = createHttpServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
    modelCalls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    // 收集请求体判断轮次（tool 结果回填计数）
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const toolResultCount = (body.match(/"role":"tool"/g) ?? []).length;
      if (toolResultCount === 0) {
        send({ choices: [{ delta: { role: 'assistant' } }] });
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_w1_plan1',
                    function: {
                      name: 'update_plan',
                      arguments: JSON.stringify({ steps: [
                        { step: '读取简介文件', status: 'in_progress' },
                        { step: '输出总结', status: 'pending' },
                      ] }),
                    },
                  },
                  { index: 1, id: 'call_w1_1', function: { name: 'read', arguments: '{"path": "简介.txt"}' } },
                ],
              },
            },
          ],
        });
        send('data: [DONE]');
        res.end();
      } else if (toolResultCount === 2) {
        // 第二轮（update_plan+read 两个结果回填）：计划推进（读取完成→总结进行中）
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_w1_plan2',
                    function: {
                      name: 'update_plan',
                      arguments: JSON.stringify({ steps: [
                        { step: '读取简介文件', status: 'completed' },
                        { step: '输出总结', status: 'in_progress' },
                      ] }),
                    },
                  },
                ],
              },
            },
          ],
        });
        send('data: [DONE]');
        res.end();
      } else {
        // 第三轮（计划推进结果回填，3 个 tool 结果）：思考过程 + 流式最终答案
        for (const text of ['用户要求读取文件并总结，', '我已拿到内容，组织语言。']) {
          send({ choices: [{ delta: { reasoning_content: text } }] });
        }
        for (const text of ['读取完成。', '该文件介绍了 WorkPivot 的定位：', '面向企业的私有化智能工作台。']) {
          send({ choices: [{ delta: { content: text } }] });
        }
        send('data: [DONE]');
        res.end();
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

// ---- 启动真实服务层 ----
const server = await startServer({ port: 39910, webDistDir: undefined });
const base = `http://127.0.0.1:${server.port}`;

// T2-01：注册首个管理员（隔离环境内），后续请求全部带 Bearer 令牌
const reg = await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'w1-smoke-123' }),
});
if (!reg.ok) throw new Error(`管理员注册失败 HTTP ${reg.status}`);
const { token } = (await reg.json()) as { token: string };
const auth = { authorization: `Bearer ${token}` };

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, { headers: { 'content-type': 'application/json', ...auth }, ...init });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

try {
  // 1. 供应商：验活 + 保存
  const verify = await json<{ ok: boolean; detail: string }>('/api/providers/verify', {
    method: 'POST',
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` }),
  });
  assert('C02 验活（GET /models 真实请求）', verify.ok, verify.detail);

  await json('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: '模拟供应商', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1', verify: true }),
  });
  const providerList = await json<{ providers: Array<{ active: boolean }> }>('/api/providers');
  assert('C02 供应商保存并激活', providerList.providers.length === 1 && providerList.providers[0]!.active === true);

  // 2. 建任务 + 准备工作区文件
  const { task } = await json<{ task: { id: string; name: string; directory: string; status: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: 'W1 冒烟' }),
  });
  assert('B01 建任务（工作目录已创建）', existsSync(task.directory), task.directory);
  writeFileSync(join(task.directory, '简介.txt'), 'WorkPivot 是一个面向企业的私有化智能工作台。', 'utf8');

  // 3. SSE 对话：读文件并总结
  const events: Array<Record<string, unknown>> = [];
  const response = await fetch(`${base}/api/tasks/${task.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content: '请读取 简介.txt 并总结' }),
  });
  assert('SSE 响应 200 且为 event-stream', response.status === 200 && (response.headers.get('content-type') ?? '').includes('event-stream'));

  const reader = response.body!.getReader();
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
      if (line) events.push(JSON.parse(line.slice(5)) as Record<string, unknown>);
    }
  }

  const deltas = events.filter((e) => e['type'] === 'assistant_delta') as Array<{ text: string }>;
  if (events.some((e) => e['type'] === 'error')) {
    console.log('（调试）错误事件：', JSON.stringify(events.filter((e) => e['type'] === 'error')));
    console.log('（调试）全部事件类型：', events.map((e) => e['type']).join(','));
  }
  const fullText = deltas.map((d) => d.text).join('');
  const toolUse = events.find((e) => e['type'] === 'tool_use' && (e as { toolName?: string }).toolName === 'read') as { toolName?: string; args?: { path?: string } } | undefined;
  const toolResult = events.find((e) => e['type'] === 'tool_result' && (e as { toolName?: string }).toolName === 'read') as { ok?: boolean; message?: string } | undefined;
  const done = events.find((e) => e['type'] === 'done') as { stopReason?: string } | undefined;

  assert('T1-04 循环：三轮采样（计划轮+读取轮+总结轮）', modelCalls === 3, `modelCalls=${modelCalls}`);
  assert('T1-05 read 工具被调用', toolUse?.toolName === 'read' && toolUse.args?.['path'] === '简介.txt');
  assert('T1-05 工具真实读到了文件内容', toolResult?.ok === true && (toolResult.message ?? '').includes('私有化智能工作台'), toolResult?.message?.slice(0, 60));
  assert('T1-06 流式输出 deltas', deltas.length >= 3, `${deltas.length} 个增量`);
  assert('最终总结内容完整', fullText.includes('读取完成') && fullText.includes('私有化智能工作台'), fullText.slice(0, 60));
  assert('F03 雏形：done 事件且 stopReason=completed', done?.stopReason === 'completed');

  // S228 思考过程：reasoning_content 增量以 reasoning_delta 事件透传（不入正文/历史）
  const thoughtEvents = events.filter((e) => e['type'] === 'reasoning_delta') as Array<{ text: string }>;
  assert('S228 思考过程 reasoning_delta 透传', thoughtEvents.length >= 2, `${thoughtEvents.length} 个增量`);
  const thoughtText = thoughtEvents.map((d) => d.text).join('');
  assert('S228 思考内容不混入正文', thoughtText.includes('组织语言') && !fullText.includes('组织语言'));

  // M1-12/A03：计划工具链路
  const planEvents = events.filter((e) => e['type'] === 'plan_update') as Array<{ steps: Array<{ step: string; status: string }> }>;
  assert('A03 update_plan 推送 plan_update 事件（两次）', planEvents.length === 2, `${planEvents.length} 次`);
  assert('A03 计划事件含阶段条目', planEvents[0]?.steps?.some((s) => s.step === '读取简介文件' && s.status === 'in_progress') === true, JSON.stringify(planEvents[0]?.steps));
  const planView = await json<{ steps: Array<{ step: string; status: string }> }>(`/api/tasks/${task.id}/plan`);
  assert('A03 计划落盘可回读（最终状态）', planView.steps.some((s) => s.step === '读取简介文件' && s.status === 'completed') === true, JSON.stringify(planView.steps));

  // 4. 转写落盘（F01 v0）
  const transcriptPath = join(home, 'data', 'tasks', task.id, 'transcript.jsonl');
  assert('F01 转写文件存在', existsSync(transcriptPath), transcriptPath);
  const transcript = readFileSync(transcriptPath, 'utf8');
  assert('F01 转写含 用户/工具/助手 全部事件', transcript.includes('user_message') && transcript.includes('tool_use') && transcript.includes('assistant_message'));

  // 5. 历史可读（UI 重开任务）
  const detail = await json<{ history: Array<{ role: string; content: string }> }>(`/api/tasks/${task.id}`);
  assert('历史可读（用户+助手）', detail.history.length === 2 && detail.history[0]!.role === 'user' && detail.history[1]!.role === 'assistant');

  // 6. 密钥落盘加密检查（I04）：providers.json 无明文 key
  const providersFile = existsSync(join(home, 'config', 'providers.json'))
    ? readFileSync(join(home, 'config', 'providers.json'), 'utf8')
    : '';
  assert('I04 providers.json 无明文 key', !providersFile.includes('sk-') && !providersFile.includes('apiKey'));
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W1 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
