/**
 * W10 端到端评测（M1-09/F06 定时任务，模拟 LLM 零成本）：
 * 子进程启动真实服务层（WORKPIVOT_SCHEDULE_TICK_MS=300 快跑）→
 * 建 `* * * * *`（每分钟=每 tick 匹配）调度 → 等 tick 自动运行（任务创建+对话+通知）→
 * 停用后不再运行 → 手动运行端点 → 停服改 lastRunAt 为 10 分钟前（catchup=true）→
 * 重启 → 启动补跑（missed_catchup 通知 + 补跑成功）。
 * 运行：pnpm eval:w10
 */
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'wp10-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp10-ws-'));
const codeDir = resolve(import.meta.dirname, '..');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- 模拟供应商 ----
const MOCK_PORT = 39910;
let modelCalls = 0;
const mock: Server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      modelCalls += 1;
      let body = '';
      for await (const chunk of req) body += String(chunk);
      void body;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'W10 定时运行完成。' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  })();
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

// ---- 子进程服务层 ----
const PORT = '39981';
const children: ChildProcess[] = [];
function spawnServer(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: codeDir,
    env: {
      ...process.env,
      WORKPIVOT_HOME: home,
      WORKPIVOT_WORKSPACE: workspace,
      WORKPIVOT_PORT: PORT,
      WORKPIVOT_SCHEDULE_TICK_MS: '300',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  child.stderr?.on('data', (d: Buffer) => {
    const t = d.toString();
    if (t.includes('Error')) console.log('[child]', t.trim().slice(0, 200));
  });
  return child;
}
async function waitHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* 未就绪 */
    }
    await sleep(200);
  }
  throw new Error('服务未就绪');
}
async function stopServer(child: ChildProcess): Promise<void> {
  child.kill();
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 3000);
    child.on('exit', () => { clearTimeout(t); resolve(); });
  });
}

const base = `http://127.0.0.1:${PORT}`;
const H = { 'content-type': 'application/json' };

try {
  spawnServer();
  await waitHealth();
  const reg = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: H, body: JSON.stringify({ username: 'admin', password: 'w10-smoke-123' }),
  });
  const { token } = (await reg.json()) as { token: string };
  const auth = { ...H, authorization: `Bearer ${token}` };
  await fetch(`${base}/api/providers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });

  // 非法 cron 拒绝
  const badCron = await fetch(`${base}/api/schedules`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ name: 'x', cron: 'not-a-cron', content: 'x', taskName: 'x' }),
  });
  assert('F06 非法 cron 被拒（400）', badCron.status === 400);

  // 建调度：每分钟匹配（tick 300ms → 下一个 tick 即触发）+ 补跑开
  const createResp = await fetch(`${base}/api/schedules`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      name: 'W10 巡检', cron: '* * * * *', content: '例行巡检，回复完成即可。',
      taskName: '巡检任务', catchup: true,
    }),
  });
  const created = (await createResp.json()) as { schedule?: { id: string; enabled: boolean } };
  assert('F06 创建定时任务', createResp.status === 200 && created.schedule?.enabled === true, JSON.stringify(created).slice(0, 100));

  // 等 tick 自动运行（最多 8 秒）
  let ran = false;
  for (let i = 0; i < 40; i++) {
    await sleep(200);
    const list = (await (await fetch(`${base}/api/schedules`, { headers: auth })).json()) as {
      schedules: Array<{ lastRunAt?: string; lastResult?: string }>;
    };
    if (list.schedules[0]?.lastRunAt) { ran = true; break; }
  }
  const listAfter = (await (await fetch(`${base}/api/schedules`, { headers: auth })).json()) as {
    schedules: Array<{ lastRunAt?: string; lastResult?: string; taskId?: string }>;
  };
  const schedule0 = listAfter.schedules[0];
  assert('F06 tick 自动触发运行', ran, schedule0?.lastResult ?? '未运行');
  assert('F06 运行结果 done:completed', schedule0?.lastResult === 'done:completed', schedule0?.lastResult);

  // 通知有 run_ok
  const notes1 = (await (await fetch(`${base}/api/schedules/notifications`, { headers: auth })).json()) as {
    notifications: Array<{ event: string; name: string }>;
  };
  assert('F06 运行通知落盘（run_ok）', notes1.notifications.some((n) => n.event === 'run_ok' && n.name === 'W10 巡检'));

  // 同一分钟内不重复运行（tick 300ms 已跑多次，但 lastRunAt 分钟键去重）
  const callsAfterFirst = modelCalls;
  await sleep(1200);
  assert('F06 同分钟去重（不重复触发）', modelCalls - callsAfterFirst <= 1, `+${modelCalls - callsAfterFirst} 次`);

  // 停用 → 不再运行
  await fetch(`${base}/api/schedules/${created.schedule?.id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ enabled: false }),
  });
  const callsDisabled = modelCalls;
  await sleep(1500);
  assert('F06 停用后不再触发', modelCalls - callsDisabled <= 1, `+${modelCalls - callsDisabled} 次`);

  // 手动运行
  const manual = await fetch(`${base}/api/schedules/${created.schedule?.id}/run`, { method: 'POST', headers: auth });
  assert('F06 手动运行 200', manual.status === 200);
  await sleep(1500);
  const notes2 = (await (await fetch(`${base}/api/schedules/notifications`, { headers: auth })).json()) as {
    notifications: Array<{ event: string }>;
  };
  assert('F06 手动运行产生通知', notes2.notifications.filter((n) => n.event === 'run_ok').length >= 2, `${notes2.notifications.length} 条`);

  // 错过补跑：停服 → lastRunAt 改到 10 分钟前 → 重启 → missed_catchup
  await stopServer(children[children.length - 1]!);
  const schedulesFile = join(home, 'data', 'schedules', 'schedules.json');
  const raw = JSON.parse(readFileSync(schedulesFile, 'utf8')) as {
    schedules: Array<{ id: string; lastRunAt?: string; enabled: boolean }>;
  };
  const target = raw.schedules.find((s) => s.id === created.schedule?.id);
  if (target) {
    target.enabled = true;
    target.lastRunAt = new Date(Date.now() - 10 * 60_000).toISOString();
  }
  writeFileSync(schedulesFile, JSON.stringify(raw, null, 2), 'utf8');

  spawnServer();
  await waitHealth();
  await sleep(2500);
  const notes3 = (await (await fetch(`${base}/api/schedules/notifications`, { headers: auth })).json()) as {
    notifications: Array<{ event: string }>;
  };
  assert('F06 错过补跑（missed_catchup 通知）', notes3.notifications.some((n) => n.event === 'missed_catchup'), notes3.notifications.map((n) => n.event).join(','));
  const listFinal = (await (await fetch(`${base}/api/schedules`, { headers: auth })).json()) as {
    schedules: Array<{ lastRunAt?: string }>;
  };
  assert('F06 补跑后 lastRunAt 刷新（晚于改写值）', Boolean(listFinal.schedules[0]?.lastRunAt && new Date(listFinal.schedules[0]!.lastRunAt!).getTime() > Date.now() - 60_000));
} finally {
  for (const c of children) c.kill();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

// 注：sessions.json 持久化，重启后原 token 仍有效（上方直接复用 auth）
const passed = results.filter((r) => r.pass).length;
console.log(`\n===== W10 冒烟：${passed}/${results.length} 通过 =====`);
if (passed !== results.length) process.exit(1);
