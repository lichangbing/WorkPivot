/**
 * W6 端到端评测：M1 批次 2 结构整改（模拟 LLM 零成本）。
 * 覆盖：F1 存量任务迁移默认项目 + 项目/任务两级（项目目录共享）、
 *       F2 临时任务（零记忆注入/可删除）、F3 权限面（member 403/管理端点）+ /admin 页。
 * 运行：pnpm eval:w6（spawn 子进程服务，验证真实启动迁移）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const codeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'wp6-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp6-ws-'));

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟供应商 ----
const MOCK_PORT = 39941;
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
    const final = (text: string): void => {
      send(text);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    function send(text: string): void {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    }
    // F2 零记忆注入判别：临时任务的请求体不应出现记忆段
    if (body.includes('随便分析')) {
      final(body.includes('# 长期记忆') ? 'FAIL-记忆被注入' : 'TEMP-ZERO-MEM');
    } else if (body.includes('docx-report') === false && body.includes('技能目录')) {
      final(body.includes('SKILL-HIDDEN-OK') || body.includes('docx-report') ? 'FAIL-技能未隐藏' : 'SKILL-HIDDEN-OK');
    } else {
      final('（默认回复）');
    }
  });
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));

const children: ChildProcess[] = [];
function spawnServer(port: string): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], {
    cwd: codeDir,
    env: {
      ...process.env,
      WORKPIVOT_HOME: home,
      WORKPIVOT_WORKSPACE: workspace,
      WORKPIVOT_PORT: port,
      WORKPIVOT_WEB_DIST: resolve(codeDir, 'apps', 'web', 'dist'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(child);
  child.stderr?.on('data', (d: Buffer) => {
    const t = d.toString();
    if (t.includes('Error') || t.includes('error')) console.log('[child stderr]', t.trim().slice(0, 200));
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
  throw new Error(`服务 ${port} 未就绪`);
}

async function register(port: string): Promise<string> {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'w6-smoke-123' }),
  });
  if (!r.ok) throw new Error(`注册失败 HTTP ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

function api(port: string, token: string): {
  get: <T>(path: string) => Promise<{ status: number; body: T }>;
  post: <T>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  put: <T>(path: string, body?: unknown) => Promise<{ status: number; body: T }>;
  del: (path: string) => Promise<{ status: number; body: unknown }>;
} {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  return {
    get: async <T,>(path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      return { status: r.status, body: (await r.json()) as T };
    },
    post: async <T,>(path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
      return { status: r.status, body: (await r.json()) as T };
    },
    put: async <T,>(path: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'PUT', headers, body: JSON.stringify(body ?? {}) });
      return { status: r.status, body: (await r.json()) as T };
    },
    del: async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'DELETE', headers });
      return { status: r.status, body: await r.json() };
    },
  };
}

try {
  // ===== 存量任务（无 projectId）预写入数据目录 =====
  const legacyId = 't-legacy-0001';
  const legacyDir = join(workspace, 'legacy-dir');
  mkdirSync(join(home, 'data', 'tasks', legacyId), { recursive: true });
  writeFileSync(
    join(home, 'data', 'tasks', legacyId, 'task.json'),
    JSON.stringify({ id: legacyId, name: '存量任务', directory: legacyDir, status: 'idle', createdAt: '2026-09-01T00:00:00.000Z' }),
    'utf8',
  );

  // ===== Phase A：member 视角 + 结构 =====
  const portA = '39951';
  const childA = spawnServer(portA);
  await waitHealth(portA);
  const adminToken = await register(portA);
  const admin = api(portA, adminToken);
  // 供应商：必须在任务对话前保存（resolveActiveProvider 依赖）
  await admin.post('/api/providers', {
    name: '模拟',
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
    modelId: 'mock-1',
  });

  // F1 迁移
  const tasksAfter = await admin.get<{ tasks: Array<{ id: string; projectId?: string }> }>('/api/tasks');
  const legacy = tasksAfter.body.tasks.find((t) => t.id === legacyId);
  assert('F1 存量任务迁移至默认项目', legacy?.projectId === 'p-default', `projectId=${legacy?.projectId}`);
  const projects0 = await admin.get<{ projects: Array<{ id: string; name: string }> }>('/api/projects');
  assert('F1 默认项目存在', projects0.body.projects.some((p) => p.id === 'p-default' && p.name === '默认项目'));

  // F1 建项目 + 项目下任务（目录共享）
  const proj = await admin.post<{ project: { id: string; directory: string; name: string } }>('/api/projects', { name: '项目A' });
  assert('F1 创建项目', proj.status === 200 && proj.body.project.name === '项目A');
  const taskIn = await admin.post<{ task: { id: string; directory: string; projectId: string } }>('/api/tasks', {
    name: '项目A的任务',
    projectId: proj.body.project.id,
  });
  assert('F1 项目任务共享项目目录', taskIn.body.task.directory === proj.body.project.directory, taskIn.body.task.directory);

  // F3 权限面：member 无法建项目/配模型/看技能
  await admin.post<{ user: { username: string } }>('/api/users', {
    username: 'member1',
    password: 'member-123',
    role: 'member',
  });
  const memberLogin = await fetch(`http://127.0.0.1:${portA}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member1', password: 'member-123' }),
  });
  const memberToken = ((await memberLogin.json()) as { token: string }).token;
  const member = api(portA, memberToken);
  const projDenied = await member.post('/api/projects', { name: 'x' });
  assert('F3 member 建项目被拒（403）', projDenied.status === 403);
  const providerDenied = await member.post('/api/providers', {
    name: 'x', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'm',
  });
  assert('F3 member 配模型被拒（403）', providerDenied.status === 403);
  const skillsDenied = await member.get<{ error?: string }>('/api/skills');
  assert('F3 member 看技能被拒（403）', skillsDenied.status === 403);

  // F3 供应商编辑/删除（PUT/DELETE /api/providers/:id）
  const provs0 = await admin.get<{ providers: Array<{ id: string; baseUrl: string; modelId: string; active: boolean }> }>('/api/providers');
  const p0 = provs0.body.providers[0]!;
  const memberPut = await member.put(`/api/providers/${p0.id}`, { name: 'x', baseUrl: 'http://127.0.0.1:1/v1', modelId: 'm' });
  assert('F3 member 改模型被拒（403）', memberPut.status === 403);
  const upd = await admin.put(`/api/providers/${p0.id}`, { name: '模拟2', baseUrl: p0.baseUrl, modelId: 'mock-2' });
  assert('F3 编辑供应商生效（换 modelId）', upd.status === 200 && upd.body.provider.modelId === 'mock-2' && upd.body.provider.name === '模拟2');
  const p2 = await admin.post<{ provider: { id: string } }>('/api/providers', {
    name: '备用', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1',
  });
  assert('F3 新建备用供应商', p2.status === 200);
  // 删除激活项 → activeId 顺延到剩余第一个（对话链 resolveActiveProvider 不断供）
  const delActive = await admin.del(`/api/providers/${p0.id}`);
  assert('F3 删除激活供应商', delActive.status === 200);
  const provs1 = await admin.get<{ providers: Array<{ name: string; active: boolean }> }>('/api/providers');
  assert(
    'F3 删除后激活项顺延',
    provs1.body.providers.length === 1 && provs1.body.providers[0]!.active === true,
    JSON.stringify(provs1.body.providers),
  );
  const delAgain = await admin.del(`/api/providers/${p0.id}`);
  assert('F3 删除不存在的供应商报 404', delAgain.status === 404);

  // F2 临时任务：目录在临时区 + 零记忆注入 + 可删除
  // 先在普通任务里产生一条记忆（把注入判别物准备好）
  await admin.post<{ task: { id: string } }>('/api/tasks', { name: '记忆准备' });
  const memTaskList = await admin.get<{ tasks: Array<{ id: string }> }>('/api/tasks');
  const memTaskId = memTaskList.body.tasks[0]!.id;
  await fetch(`http://127.0.0.1:${portA}/api/tasks/${memTaskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ content: '请记住:用户在测试 W6。' }),
    signal: AbortSignal.timeout(20_000),
  });

  const tempTask = await admin.post<{ task: { id: string; directory: string; temp: boolean } }>('/api/tasks', {
    name: '临时分析',
    temp: true,
  });
  assert('F2 临时任务目录在 _temp 区', tempTask.body.task.directory.includes('_temp'), tempTask.body.task.directory);
  assert('F2 临时任务 temp 标记', tempTask.body.task.temp === true);

  // 临时任务对话：mock 校验请求体不含记忆注入段
  const sse = await fetch(`http://127.0.0.1:${portA}/api/tasks/${tempTask.body.task.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ content: '随便分析一下' }),
    signal: AbortSignal.timeout(20_000),
  });
  const sseText = await (await sse.text()).slice(0, 0) || '';
  void sseText;
  // SSE 已被消费判定：重新以文本读取（上面 text() 已消费——改为在之前读取）
  // 简化断言：临时任务删除
  const delTemp = await admin.del(`/api/tasks/${tempTask.body.task.id}`);
  assert('F2 临时任务可删除', delTemp.status === 200);
  const tasksAfterDel = await admin.get<{ tasks: Array<{ id: string }> }>(`/api/tasks`);
  assert('F2 删除后不在列表', !tasksAfterDel.body.tasks.some((t) => t.id === tempTask.body.task.id));

  // M1-10/B03：删除进回收站（工作目录与应用数据目录移入 trash，含 manifest）
  const trashList = await admin.get<{ items: Array<{ name: string; originalPath?: string }> }>('/api/trash');
  const trashNames = trashList.body.items.map((it) => it.name);
  assert('B03 回收站含临时任务工作目录', trashNames.some((n) => n.startsWith(`temp-${tempTask.body.task.id}`)), JSON.stringify(trashNames));
  assert('B03 回收站含任务应用数据目录', trashNames.some((n) => n.startsWith(`taskdata-${tempTask.body.task.id}`)));
  assert('B03 回收站条目记录原路径', trashList.body.items.every((it) => typeof it.originalPath === 'string' && it.originalPath.length > 0));

  // M1-10/I03：审计查看/导出权限面
  const auditDenied = await member.get<{ error?: string }>('/api/audit');
  assert('I03 member 看审计被拒（403）', auditDenied.status === 403);
  const auditView = await admin.get<{ rows: Array<{ event?: string }> }>('/api/audit');
  assert('I03 审计可查看（含用户创建事件）', auditView.status === 200 && auditView.body.rows.some((r) => r.event === 'user_created'));
  const auditExportResp = await fetch(`http://127.0.0.1:${portA}/api/audit/export`, {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const auditExportText = await auditExportResp.text();
  assert(
    'I03 审计导出为 JSONL（每行可解析）',
    auditExportResp.status === 200 && auditExportText.split('\n').every((l) => l.trim() === '' || l.startsWith('{')),
    `${auditExportText.length} 字符`,
  );

  // F3 Skill 启停
  const skills0 = await admin.get<{ skills: Array<{ name: string; disabled: boolean }> }>('/api/skills');
  assert('F3 技能列表含内置 docx-report', skills0.body.skills.some((s) => s.name === 'docx-report' && !s.disabled));
  await admin.post('/api/skills/toggle', { name: 'docx-report', disabled: true });
  const skills1 = await admin.get<{ skills: Array<{ name: string; disabled: boolean }> }>('/api/skills');
  const docx1 = skills1.body.skills.find((s) => s.name === 'docx-report');
  assert('F3 停用生效（disabled=true）', docx1?.disabled === true);
  await admin.post('/api/skills/toggle', { name: 'docx-report', disabled: false });

  // F3 /admin 页面可达
  const adminPage = await fetch(`http://127.0.0.1:${portA}/admin`);
  const adminHtml = await adminPage.text();
  assert('F3 /admin 页面可达且为后台入口', adminPage.status === 200 && adminHtml.includes('管理后台'));

  childA.kill();
  await new Promise((r) => setTimeout(r, 500));

  // ===== Phase B：F2 零记忆注入（需在运行中的服务里断言 mock 行为）=====
  // 说明：零记忆注入已由 mock 在临时任务对话中判别（TEMP-ZERO-MEM 分支），
  // 此处补充直接断言：重新创建临时任务并发消息，检查 assistant 文本。
  const portB = '39952';
  const childB = spawnServer(portB);
  await waitHealth(portB);
  // 会话令牌已持久化（T2-01）：复用 Phase A 管理员令牌（home 共享，注册会 403）
  const adminB = api(portB, adminToken);
  const createResp = await adminB.post<{ task?: { id: string }; error?: string }>('/api/tasks', { name: '随便分析', temp: true });
  if (!createResp.body.task) {
    console.log('[debug] 创建临时任务失败:', createResp.status, JSON.stringify(createResp.body));
    throw new Error('创建临时任务失败');
  }
  const temp2 = createResp.body.task;
  const sse2 = await fetch(`http://127.0.0.1:${portB}/api/tasks/${temp2.id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ content: '随便分析一下' }),
    signal: AbortSignal.timeout(20_000),
  });
  const reader2 = (sse2.body as ReadableStream<Uint8Array>).getReader();
  const decoder2 = new TextDecoder();
  let buf2 = '';
  let text2 = '';
  for (;;) {
    const { done, value } = await reader2.read();
    if (done) break;
    buf2 += decoder2.decode(value, { stream: true });
    let i: number;
    while ((i = buf2.indexOf('\n\n')) >= 0) {
      const chunk = buf2.slice(0, i);
      buf2 = buf2.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (line) {
        const ev = JSON.parse(line.slice(5)) as Record<string, unknown>;
        if (ev['type'] === 'assistant_delta') text2 += String(ev['text']);
      }
    }
  }
  assert('F2 临时任务零记忆注入（mock 判别 TEMP-ZERO-MEM）', text2.includes('TEMP-ZERO-MEM'), text2.slice(0, 60));

  childB.kill();
  await new Promise((r) => setTimeout(r, 400));
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

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W6 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
