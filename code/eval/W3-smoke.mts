/**
 * W3 端到端评测：长任务韧性（模拟 LLM 零成本）。
 * 真实冷杀：spawn 子进程服务 → 任务运行中 SIGKILL → 重启 → 断点续跑。
 * 覆盖：启动扫描 running→interrupted、断点续跑、核验闸门打回、卡循环 3 提醒/5 拦截、
 *       强制收尾（三要素）、工具结果落盘、多版本产物、转写端点。
 * 运行：pnpm eval:w3
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'wp3-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp3-ws-'));

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟 OpenAI 兼容供应商（按请求体内容编排脚本）----
const MOCK_PORT = 39912;
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

    // 解析最后一条用户消息，按其内容编排（历史里的旧关键词不影响）
    let lastUser = '';
try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string | null }> };
      const users = (parsed.messages ?? []).filter((m) => m.role === 'user');
      lastUser = String(users[users.length - 1]?.content ?? '');
    } catch {
      lastUser = body;
    }

    if (!body.includes('"tools"')) {
      // 强制收尾请求（无工具面）：三要素
      final('已完成:文件读取与内容核对。实际产出:无新文件,修改均在现有文件内。下次:从 PROGRESS.md 的剩余项继续。');
    } else if (lastUser.includes('挂起')) {
      // 故意不响应（供冷杀场景）
    } else if (body.includes('已连续多次产生完全相同的调用')) {
      final('明白,不再重复。改为直接完成剩余工作。');
    } else if (lastUser.includes('断点继续')) {
      final('已从断点继续,完成剩余工作。');
    } else if (lastUser.includes('循环测试')) {
      toolCall('read', '{"path": "简介.txt"}');
    } else if (body.includes('核验失败')) {
      toolCall('write', '{"path": "总结.md", "content": "# 总结\\n真实生成。"}');
    } else if (lastUser.includes('总结.md')) {
      final('已生成 总结.md,内容完美无误。');
    } else if (lastUser.includes('大文件')) {
      toolCall('read', '{"path": "big.txt"}');
    } else if (lastUser.includes('三个版本')) {
      send({ choices: [{ delta: { role: 'assistant' } }] });
      const versions: Array<[string, string]> = [
        ['方案 v1.0 2026-09-05.md', '# 方案 v1.0'],
        ['方案 v1.1 2026-09-05.md', '# 方案 v1.1'],
        ['方案 v1.2 2026-09-05.md', '# 方案 v1.2'],
      ];
      for (const [i, [path, content]] of versions.entries()) {
        send({ choices: [{ delta: { tool_calls: [{ index: i, id: `c_v${i}`, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }] } }] });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } else if (body.includes('"role":"tool"')) {
      final('本轮处理完成。');
    } else {
      final('（默认回复）');
    }
  });
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const children: ChildProcess[] = [];
function spawnServer(maxSteps: string, port: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: codeDir,
    env: {
      ...process.env,
      WORKPIVOT_INSECURE_SECRETS: '1',
      WORKPIVOT_HOST: '127.0.0.1',
      WORKPIVOT_HOME: home,
      WORKPIVOT_WORKSPACE: workspace,
      WORKPIVOT_PORT: port,
      WORKPIVOT_MAX_STEPS: maxSteps,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (text.includes('[core][DEBUG]')) console.log('[child stderr]', text.trim().slice(0, 300));
  });
  return child;
}

async function waitHealth(port: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务 ${port} 未在时限内就绪`);
}

async function api(port: string, token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...init,
  });
}

async function register(port: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'w3-smoke-123' }),
  });
  if (!r.ok) throw new Error(`注册失败 HTTP ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

interface SseRun {
  events: Array<Record<string, unknown>>;
  text: string;
}

async function runTurn(port: string, token: string, taskId: string, content: string, timeoutMs = 30_000): Promise<SseRun> {
  const events: Array<Record<string, unknown>> = [];
  let text = '';
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(timeoutMs),
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
    }
  }
  return { events, text };
}

function eventsOf(run: SseRun, type: string): Array<Record<string, unknown>> {
  return run.events.filter((e) => e['type'] === type);
}

try {
  // ===== Phase A：maxSteps=3 —— 卡循环提醒 + 强制收尾 + 挂起任务被冷杀 =====
  const portA = '39913';
  const childA = spawnServer('3', portA);
  await waitHealth(portA);
  const tokenA = await register(portA);
  await fetch(`http://127.0.0.1:${portA}/api/providers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });

  const { task: loopTask } = (await (
    await api(portA, tokenA, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: '循环测试' }) })
  ).json()) as { task: { id: string; directory: string } };
  writeFileSync(join(loopTask.directory, '简介.txt'), 'WorkPivot 简介内容。', 'utf8');

  const loopRun = await runTurn(portA, tokenA, loopTask.id, '请循环测试读取简介');
  const warned = loopRun.events.some(
    (e) => e['type'] === 'tool_result' && String((e as { message?: string }).message ?? '').includes('第 3 次完全相同'),
  );
  assert('F05 卡循环第 3 次提醒', warned);
  assert(
    'F03 强制收尾触发（stopReason=max_steps）',
    (loopRun.events.find((e) => e['type'] === 'done') as { stopReason?: string } | undefined)?.stopReason === 'max_steps',
  );
  assert('F03 强制收尾含三要素（模拟固定话术）', loopRun.text.includes('已完成') && loopRun.text.includes('下次'));

  const { task: hangTask } = (await (
    await api(portA, tokenA, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: '挂起任务' }) })
  ).json()) as { task: { id: string; directory: string } };

  // 保持请求连接，确认运行后使用 SIGKILL，避免优雅关闭把任务标为 stopped。
  await fetch(`http://127.0.0.1:${portA}/api/tasks/${hangTask.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenA}` },
    body: JSON.stringify({ content: '挂起' }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 800));

  // 冷杀子进程（SIGKILL 等效——TerminateProcess，无任何清理逻辑）
  const beforeKill = await (await api(portA, tokenA, '/api/tasks/' + hangTask.id)).json() as { task: { status: string } };
  assert('冷杀前任务确实正在运行', beforeKill.task.status === 'running');
  const exited = new Promise<void>(r => childA.once('exit', () => r()));
  childA.kill('SIGKILL');
  await exited;
  console.log('🔪 Phase A 子进程已冷杀（挂起任务保持 running 态）');

  // ===== Phase B：重启（maxSteps=25）——启动扫描 + 断点续跑 + 闸门 + 预算 + 版本链 =====
  const portB = '39914';
  const childB = spawnServer('25', portB);
  await waitHealth(portB);

  // T2-01：重启后令牌仍有效（会话持久化）
  const state = await (await fetch(`http://127.0.0.1:${portB}/api/auth/state`, { headers: { authorization: `Bearer ${tokenA}` } })).json();
  assert('T2-01 重启后令牌仍有效', (state as { authenticated: boolean }).authenticated === true);
  const tokenB = (state as { user: unknown }).user ? tokenA : await register(portB);

  const taskList = await (await api(portB, tokenB, '/api/tasks')).json() as { tasks: Array<{ id: string; name: string; status: string }> };
  const resumedTask = taskList.tasks.find((t) => t.id === hangTask.id);
  assert('T3-02 启动扫描:running → interrupted', resumedTask?.status === 'interrupted', resumedTask?.status);

  // 断点续跑
  const resumeRun = await runTurn(portB, tokenB, hangTask.id, '断点继续');
  assert(
    'T3-02 断点续跑完成',
    (resumeRun.events.find((e) => e['type'] === 'done') as { stopReason?: string } | undefined)?.stopReason === 'completed',
    resumeRun.text.slice(0, 40),
  );

  // 核验闸门：诱导谎报
  const { task: gateTask } = (await (
    await api(portB, tokenB, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: '闸门测试' }) })
  ).json()) as { task: { id: string; directory: string } };
  const gateRun = await runTurn(portB, tokenB, gateTask.id, '生成总结.md');
  assert('T3-03 谎报触 发核验闸门', gateRun.events.some((e) => e['type'] === 'gate_reject'));
  assert('T3-03 打回后真实写盘', existsSync(join(gateTask.directory, '总结.md')), 'gate 目录: ' + JSON.stringify(readdirSync(gateTask.directory)) + ' | 工具事件: ' + JSON.stringify(eventsOf(gateRun, 'tool_result')));
  assert(
    'T3-03 闸门后正常收尾',
    (gateRun.events.find((e) => e['type'] === 'done') as { stopReason?: string } | undefined)?.stopReason === 'completed',
  );

  // 工具结果预算（T3-06）：60KB 读取结果落盘
  const { task: bigTask } = (await (
    await api(portB, tokenB, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: '大文件' }) })
  ).json()) as { task: { id: string; directory: string } };
  writeFileSync(join(bigTask.directory, 'big.txt'), 'X'.repeat(60_000), 'utf8');
  const bigRun = await runTurn(portB, tokenB, bigTask.id, '读取大文件');
  const bigResult = bigRun.events.find((e) => e['type'] === 'tool_result') as { message?: string } | undefined;
  assert('T3-06 大结果落盘（工具结果含"已落盘"）', (bigResult?.message ?? '').includes('已落盘'), bigResult?.message?.slice(0, 120));
  const resultsDir = join(bigTask.directory, '.workpivot', 'results');
  const stashed = existsSync(resultsDir) ? readdirSync(resultsDir) : [];
  assert(
  'T3-06 落盘文件真实存在（>50KB）',
  stashed.length >= 1 && stashed.every((f) => statSize(join(resultsDir, f)) > 50_000),
  'resultsDir=' + resultsDir + ' | exists=' + existsSync(resultsDir) + ' | stashed=' + JSON.stringify(stashed),
);

  // 版本链（T3-08/B02）
  const { task: verTask } = (await (
    await api(portB, tokenB, '/api/tasks', { method: 'POST', body: JSON.stringify({ name: '版本' }) })
  ).json()) as { task: { id: string; directory: string } };
  await runTurn(portB, tokenB, verTask.id, '请创建三个版本');
  assert(
    'T3-08 三个版本文件并存',
    ['v1.0', 'v1.1', 'v1.2'].every((v) => existsSync(join(verTask.directory, `方案 ${v} 2026-09-05.md`))),
  );

  // 转写端点（T3-01）
  const transcript = await (await api(portB, tokenB, `/api/tasks/${gateTask.id}/transcript`)).json() as { rows: Array<{ kind: string; uuid?: string; parentUuid?: string | null }> };
  assert('T3-01 转写端点返回含工具事件', transcript.rows.some((r) => r.kind === 'tool_use'));

  // M1 收尾：parentUuid 链预埋（每行有 uuid；从第二行起 parentUuid 指向前一行 uuid）
  assert('T3-01 转写行全部带 uuid', transcript.rows.length > 0 && transcript.rows.every((r) => typeof r.uuid === 'string' && r.uuid.length > 0));
  const chainOk = transcript.rows.every((r, i) => (i === 0 ? r.parentUuid === null || r.parentUuid === undefined : r.parentUuid === transcript.rows[i - 1]?.uuid));
  assert('T3-01 parentUuid 链首尾相接（fork/rewind 前置）', chainOk, JSON.stringify(transcript.rows.slice(0, 3).map((r) => [r.kind, r.parentUuid?.slice(0, 8)])));

  childB.kill();
  await new Promise((r) => setTimeout(r, 500));
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.stack ?? err.message : String(err));
} finally {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* 忽略 */
    }
  }
  mock.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W3 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
