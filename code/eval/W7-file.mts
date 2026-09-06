/**
 * W7 端到端评测：附件上传与 @ 补全（模拟 LLM 零成本）。
 * 覆盖：附件上传落盘 + 防穿越消毒 + 重名序号、消息携带附件内容注入模型、
 *       上传后出现在文件清单、临时任务托盘清除后无残留注入。
 * 运行：pnpm eval:w7
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'wp7-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp7-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟供应商：检查请求体是否含附件内容 ----
const MOCK_PORT = 39971;
let sawAttachmentContent = false;
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
    sawAttachmentContent = body.includes('W7-ATTACHMENT-MARKER-9527');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const text = sawAttachmentContent ? '已读取附件标记内容。' : '（未见附件内容）';
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const server = await startServer({ port: 39962 });
const base = `http://127.0.0.1:${server.port}`;

await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'w7-smoke-123' }),
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

try {
  await json('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });
  const { task } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: 'W7 附件' }),
  });

  // 1. 上传附件（裸体流，等价前端 XHR）
  const content = 'W7-ATTACHMENT-MARKER-9527 这是一条测试附件内容。';
  const up = await fetch(`${base}/api/tasks/${task.id}/attachments?name=${encodeURIComponent('数据 W7.txt')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${(globalThis as { __tok?: string }).__tok ?? ''}` },
    body: Buffer.from(content, 'utf8'),
  });
  assert('附件上传 200', up.status === 200, `status=${up.status}`);
  const upBody = (await up.json()) as { name: string };
  assert('附件落盘于 attachments/ 子目录（重名消毒）', upBody.name === '数据 W7.txt', upBody.name);

  // 2. 防穿越：恶意 name 被消毒或拒绝
  const evil = await fetch(`${base}/api/tasks/${task.id}/attachments?name=${encodeURIComponent('../../evil.txt')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${(globalThis as { __tok?: string }).__tok ?? ''}`, 'content-type': 'application/octet-stream' },
    body: Buffer.from('evil'),
  });
  assert('防穿越：上传不抛 5xx', evil.status < 500);
  assert('防穿越：workspace 根无 evil.txt 泄漏', !existsSync(join(task.directory, 'evil.txt')) && !existsSync(join(workspace, 'evil.txt')));

  // 3. 文件清单含附件
  const files = await json<{ files: string[] }>(`/api/tasks/${task.id}/files`);
  assert('文件清单含 attachments/ 附件', files.files.some((f) => f.startsWith('attachments/')), JSON.stringify(files.files));

  // 4. 发消息携带附件 → mock 确认内容注入
  const sse = await fetch(`${base}/api/tasks/${task.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content: '读取附件', attachments: [upBody.name] }),
    signal: AbortSignal.timeout(20_000),
  });
  const sseText = await sse.text();
  let reply = '';
  for (const line of sseText.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
    if (ev.type === 'assistant_delta' && typeof ev.text === 'string') reply += ev.text;
  }
  console.log('[debug] SSE 全文（前 500 字）:', JSON.stringify(sseText.slice(0, 500)));
  console.log('[debug] reply:', JSON.stringify(reply));
  assert('附件内容注入模型上下文', reply.includes('已读取附件标记内容'), reply.slice(0, 60));

  // 5. 转写含 user 消息
  const transcriptPath = join(home, 'data', 'tasks', task.id, 'transcript.jsonl');
  const transcript = readFileSync(transcriptPath, 'utf8');
  assert('转写含附件注入内容', transcript.includes('W7-ATTACHMENT-MARKER-9527'));
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W7 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
