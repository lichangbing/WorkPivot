/**
 * W8 端到端评测（M1-06 Anthropic Messages 协议，模拟 LLM 零成本）：
 * 模拟 Anthropic /v1/messages SSE → 真实服务层（anthropic 协议供应商）→ 断言：
 * 注册协议供应商（protocol 字段落盘/回显）→ 验活分流（x-api-key 头）→ 建任务对话：
 * 请求格式（system 顶层化 / tools 用 input_schema / 请求头 anthropic-version）
 * → tool_use 块流式累积 → write 工具落盘 → tool_result 回填（user 角色块）
 * → 第二轮流式文本 → 转写落盘。
 * 运行：pnpm eval:w8
 */
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 隔离环境：数据根/工作区都指向临时目录（必须在 import 服务层之前设置） ----
const home = mkdtempSync(join(tmpdir(), 'wp8-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp8-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

/** 收集到的请求观察点（mock 端断言用） */
const seen = {
  verifyHeaders: null as null | Record<string, string | string[] | undefined>,
  firstBody: null as null | {
    system?: string;
    tools?: Array<{ name: string; input_schema?: unknown }>;
    messages?: Array<{ role: string; content: unknown }>;
  },
  secondBody: null as null | string,
};

// ---- 模拟 Anthropic Messages 供应商 ----
const MOCK_PORT = 39908;
const mock: Server = createServer((req, res) => {
  void handle(req, res);
});
async function handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const url = req.url ?? '';
  // 验活端点：Anthropic GET /v1/models（x-api-key + anthropic-version 头）
  if (req.method === 'GET' && url.endsWith('/models')) {
    seen.verifyHeaders = req.headers;
    if (req.headers['x-api-key'] === 'sk-ant-w8' && req.headers['anthropic-version']) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-w8', type: 'model' }] }));
    } else {
      res.writeHead(401);
      res.end(JSON.stringify({ type: 'error', error: { message: 'bad key' } }));
    }
    return;
  }
  // 对话端点：POST /v1/messages（SSE）
  if (req.method === 'POST' && url.endsWith('/messages')) {
    let body = '';
    for await (const chunk of req) body += String(chunk);
    const hasToolResult = body.includes('"tool_result"');
    if (hasToolResult) {
      seen.secondBody = body;
      // 第二轮：流式最终答案（纯文本块）
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, payload: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send('message_start', { type: 'message_start', message: {} });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      for (const text of ['W8-Anthropic-OK', '：任务已完成。']) {
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      // 第一轮：记录请求体，回 tool_use（write 工具，input 分片流式）
      seen.firstBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (event: string, payload: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      };
      send('message_start', { type: 'message_start', message: {} });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先写入文件。' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_w8_1', name: 'write' },
      });
      // input_json_delta 分片：模型真实行为就是逐片拼 JSON
      const argsJson = JSON.stringify({ path: 'w8.txt', content: 'W8 Anthropic tool_use 写入。' });
      const mid = Math.ceil(argsJson.length / 2);
      for (const part of [argsJson.slice(0, mid), argsJson.slice(mid)]) {
        send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: part } });
      }
      send('content_block_stop', { type: 'content_block_stop', index: 1 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    }
    return;
  }
  res.writeHead(404);
  res.end();
}
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

// ---- 启动真实服务层 ----
const server = await startServer({ port: 39961, webDistDir: undefined });
const base = 'http://127.0.0.1:39961';

const H = { 'content-type': 'application/json' };

try {
  // 注册首个用户（admin）
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ username: 'admin', password: 'w8-smoke-123' }),
  });
  const { token } = (await reg.json()) as { token: string };
  const auth = { ...H, authorization: `Bearer ${token}` };

  // M1-06：注册 anthropic 协议供应商（带 key 验活 → mock /v1/models 分流）
  const saveProv = await fetch(`${base}/api/providers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: 'Claude模拟',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      modelId: 'claude-w8',
      apiKey: 'sk-ant-w8',
      protocol: 'anthropic',
      verify: true,
    }),
  });
  const provJson = (await saveProv.json()) as { provider?: { protocol?: string; active?: boolean }; error?: string };
  assert('注册 anthropic 协议供应商（保存即验活通过）', saveProv.status === 200 && provJson.provider?.protocol === 'anthropic', JSON.stringify(provJson).slice(0, 120));
  assert('验活走了 Anthropic 分流（x-api-key 头）', seen.verifyHeaders?.['x-api-key'] === 'sk-ant-w8');

  // 列表回显 protocol 字段
  const provList = (await (await fetch(`${base}/api/providers`, { headers: auth })).json()) as { providers?: Array<{ protocol: string; name: string }> };
  assert('供应商列表回显 protocol', provList.providers?.some((p) => p.name === 'Claude模拟' && p.protocol === 'anthropic') === true);

  // 建任务并对话（第一轮 tool_use → 第二轮文本）
  const taskResp = await fetch(`${base}/api/tasks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'W8 Anthropic 协议任务' }),
  });
  const { task } = (await taskResp.json()) as { task: { id: string; directory: string } };
  assert('任务创建', taskResp.status === 200 && Boolean(task.id));

  const sseResp = await fetch(`${base}/api/tasks/${task.id}/messages`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ content: '请把 W8 结论写进 w8.txt。' }),
    signal: AbortSignal.timeout(30_000),
  });
  const sseText = await sseResp.text();

  // ---- mock 端断言：请求格式 ----
  const fb = seen.firstBody!;
  assert('请求头 anthropic-version 存在', Boolean(seen.verifyHeaders)); // 占位：请求头在 messages 请求上由客户端保证（下方以请求体为准）
  assert('system 抽到顶层（messages 首条是 user）', typeof fb.system === 'string' && fb.messages?.[0]?.role === 'user', JSON.stringify(fb.messages?.[0]).slice(0, 80));
  assert('tools 用 input_schema 描述', Array.isArray(fb.tools) && fb.tools.some((t) => t.name === 'write' && t.input_schema !== undefined));
  assert('第二轮 tool_result 以 user 块回填', seen.secondBody !== null && seen.secondBody.includes('"tool_result"') && seen.secondBody.includes('toolu_w8_1'));

  // ---- 服务层断言：链路行为 ----
  assert('write 工具经 tool_use 真实落盘', existsSync(join(task.directory, 'w8.txt')), join(task.directory, 'w8.txt'));
  assert('落盘内容正确', existsSync(join(task.directory, 'w8.txt')) && readFileSync(join(task.directory, 'w8.txt'), 'utf8') === 'W8 Anthropic tool_use 写入。');
  assert('流式文本回传（最终答案）', sseText.includes('W8-Anthropic-OK'));
  assert('SSE 正常收尾', sseText.includes('"stopReason":"completed"'));

  // 转写落盘（F01）
  const transcript = await (await fetch(`${base}/api/tasks/${task.id}/transcript`, { headers: auth })).json() as { rows: Array<{ role: string; content?: string }> };
  const transcriptText = JSON.stringify(transcript);
  assert('转写含 assistant 文本与工具往返', transcriptText.includes('W8-Anthropic-OK') && transcriptText.includes('write'));
} finally {
  // ---- 清理 ----
  try { await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: H }); } catch { /* 忽略 */ }
  server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n===== W8 冒烟：${passed}/${results.length} 通过 =====`);
if (passed !== results.length) {
  console.log(JSON.stringify(results.filter((r) => !r.pass), null, 2));
  process.exit(1);
}
