/**
 * W2 端到端评测：安全底线（模拟 LLM 零成本）。
 * 覆盖：只读档拒绝写入 / 界外读取授权卡（拒绝→放行→永久白名单免二次询问）/
 *       高危 bash 拦截（rm -rf）/ @文件引用 / 审计日志行。
 * 前置：复用 W1 的隔离环境模式；管理员注册后全程 Bearer。
 * 运行：pnpm eval:w2
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ---- 模拟供应商：按用户消息内容编排脚本 ----
const MOCK_PORT = 39911;
const OUTSIDE_DIR = join(workspace, 'outside');
const OUTSIDE_FILE = join(OUTSIDE_DIR, 'secret.txt');
mkdirSync(OUTSIDE_DIR, { recursive: true });
writeFileSync(OUTSIDE_FILE, '这是界外机密内容。', 'utf8');

const mock: Server = createHttpServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
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
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: args } }] } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (body.includes('--- 引用文件')) {
        // @引用场景：直接确认
        send({ choices: [{ delta: { content: '已确认引用内容。' } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (body.includes('"role":"tool"')) {
        // 工具已执行：总结收尾
        send({ choices: [{ delta: { content: '本轮处理完成。' } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (body.includes('rm -rf')) {
        toolCall('bash', '{"command": "rm -rf C:/Users"}');
      } else if (body.includes('界外')) {
        const abs = OUTSIDE_FILE.replace(/\\/g, '/');
        toolCall('read', JSON.stringify({ path: abs }));
      } else if (body.includes('写入报告')) {
        toolCall('write', '{"path": "报告 v1.0 2026-09-05.md", "content": "# 报告"}');
      } else {
        send({ choices: [{ delta: { content: '（默认回复）' } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const server = await startServer({ port: 39911 + 1 });
const base = `http://127.0.0.1:${server.port}`;

// 注册管理员
await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'w2-smoke-123' }),
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

interface RunResult {
  events: Array<Record<string, unknown>>;
  text: string;
}

async function runTurn(taskId: string, content: string, onPermission: () => 'allow' | 'deny' | 'session' | 'forever'): Promise<RunResult> {
  const events: Array<Record<string, unknown>> = [];
  const response = await fetch(`${base}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content }),
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('SSE 读取超时（30s）');
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
      if (event['type'] === 'permission_request') {
        const decision = onPermission();
        await json(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id: event['id'], decision }) });
      }
    }
  }
  return { events, text };
}

function eventsOf(run: RunResult, type: string): Array<Record<string, unknown>> {
  return run.events.filter((e) => e['type'] === type);
}

try {
  // 准备供应商 + 任务
  await json('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });
  const { task } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: 'W2 冒烟' }),
  });
  writeFileSync(join(task.directory, '简介.txt'), 'WorkPivot 简介内容。', 'utf8');

  // 1. 默认档 workdir：界外读取 → 授权卡 → 拒绝
  const run1 = await runTurn(task.id, '请读取界外的机密文件', () => 'deny');
  const req1 = eventsOf(run1, 'permission_request')[0] as { reason?: string } | undefined;
  assert('T2-05 界外读取触发授权卡', Boolean(req1), req1?.reason);
  const denyResult = eventsOf(run1, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('T2-05 拒绝后工具被拦（含权限不足提示）', denyResult?.ok === false && (denyResult.message ?? '').includes('权限不足'));
  assert('循环正常收尾', (eventsOf(run1, 'done')[0] as { stopReason?: string } | undefined)?.stopReason === 'completed');

  // 2. 界外读取 → 永久白名单 → 再次访问不再询问
  const run2 = await runTurn(task.id, '请读取界外的机密文件', () => 'forever');
  assert('T2-05 二次触发授权卡（本次授权永久）', eventsOf(run2, 'permission_request').length === 1);
  const ok2 = eventsOf(run2, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('T2-05 授权后真实读到界外内容', ok2?.ok === true && (ok2.message ?? '').includes('界外机密内容'));
  const run3 = await runTurn(task.id, '请再读取一次界外的机密文件', () => 'deny');
  assert('T2-05 永久白名单生效（不再询问）', eventsOf(run3, 'permission_request').length === 0);
  const ok3 = eventsOf(run3, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('白名单路径第三次读取成功', ok3?.ok === true);

  // 3. 高危命令：rm -rf（I05 bypass-immune）
  const run4 = await runTurn(task.id, '帮我执行 rm -rf C:/Users', () => 'deny');
  const req4 = eventsOf(run4, 'permission_request')[0] as { reason?: string; scope?: string } | undefined;
  assert('I05 高危命令触发拦截询问', Boolean(req4), req4?.reason);
  assert('I05 高危命令不提供永久放行', req4?.scope === 'once');
  const deny4 = eventsOf(run4, 'tool_result')[0] as { ok?: boolean } | undefined;
  assert('I05 拒绝后命令未执行', deny4?.ok === false);

  // 4. readonly 档：write 被拒
  await json('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier: 'readonly' }) });
  const run5 = await runTurn(task.id, '请写入报告', () => 'allow');
  const deny5 = eventsOf(run5, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('T2-04 只读档拒绝写入', deny5?.ok === false && (deny5.message ?? '').includes('权限不足'));
  assert('T2-04 只读档无授权卡（直接策略拒绝）', eventsOf(run5, 'permission_request').length === 0);
  await json('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });

  // 5. @文件引用（T2-02）
  const run6 = await runTurn(task.id, '帮我看看 @简介.txt', () => 'allow');
  assert('T2-02 @文件引用展开并被确认', run6.text.includes('已确认引用内容'));

  // 6. 审计日志（T2-07/I03）
  const auditDir = join(home, 'audit');
  assert('I03 审计目录存在', existsSync(auditDir));
  const auditText = readdirSync(auditDir)
    .map((f) => readFileSync(join(auditDir, f), 'utf8'))
    .join('');
  assert('I03 审计含工具访问判定', auditText.includes('"event":"tool_access"'));
  assert('I03 审计含拒绝决策', auditText.includes('"decision":"deny"'));
  assert('I03 审计含参数哈希（非明文）', auditText.includes('"argsHash"'));
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W2 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
