/**
 * W11 端到端评测：RL1-02 个人档位与 RL1-05 授权请求绑定（模拟 LLM 零成本）。
 * 覆盖：个人档位自选生效（readonly 拒写/无授权卡）、未自选回落全局默认档、
 *       全局默认档仅 admin 可改（member 403）、两层合并（个人档位不受全局改动影响）、
 *       清除自选回落、非法档位值 400、A/B 用户互不影响。
 *       授权回填跨用户/跨任务拒绝、决策枚举与 scope 校验、重放拒绝、管理员代管及审计。
 * 运行：pnpm eval:w11
 */
import { createServer as createHttpServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'w11-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'w11-ws-'));
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'trusted-local';
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');
const { checkPermissionLifecycle } = await import('./W11-permission-lifecycle.mts');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟供应商：界内写入脚本 ----
const MOCK_PORT = 40001;
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
      res.writeHead(200, { 'content-type': 'application/event-stream' });
      const send = (payload: unknown): void => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const toolCall = (name: string, args: string): void => {
        send({ choices: [{ delta: { role: 'assistant' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: args } }] } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (body.includes('"role":"tool"')) {
        send({ choices: [{ delta: { content: '本轮处理完成。' } }] });
        res.write('data: [DONE]\n\n');
        res.end();
      } else if (body.includes('写入报告')) {
        toolCall('write', '{"path": "out.md", "content": "# 输出"}');
      } else if (body.includes('测试高危审批')) {
        // 只测试拒绝路径，绝不批准或执行此命令。
        toolCall('bash', JSON.stringify({ command: 'git reset --hard' }));
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
const server = await startServer({ port: 40002 });
const base = `http://127.0.0.1:${server.port}`;

async function registerOrLogin(username: string, password: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.ok) return ((await r.json()) as { token: string }).token;
  const l = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return ((await l.json()) as { token: string }).token;
}

interface Session {
  token: string;
  json: <T>(path: string, init?: RequestInit) => Promise<T>;
  raw: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
}

function sessionFor(token: string): Session {
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const raw = async (path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> => {
    const r = await fetch(base + path, { headers: auth, ...init });
    return { status: r.status, body: await r.json() };
  };
  return {
    token,
    raw,
    json: async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const { status, body } = await raw(path, init);
      if (status >= 400) throw new Error(`${path} → HTTP ${status}: ${JSON.stringify(body)}`);
      return body as T;
    },
  };
}

interface RunResult {
  events: Array<Record<string, unknown>>;
  text: string;
}

async function runTurn(
  s: Session, taskId: string, content: string,
  onPermission?: (event: Record<string, unknown>) => Promise<void>,
): Promise<RunResult> {
  const events: Array<Record<string, unknown>> = [];
  const response = await fetch(`${base}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(30_000),
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
        try {
          await onPermission?.(event);
        } finally {
          // 未被测试消费的请求兜底拒绝；已消费请求返回 404。
          await s.raw(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id: event['id'], decision: 'deny' }) });
        }
      }
    }
  }
  return { events, text };
}

function eventsOf(run: RunResult, type: string): Array<Record<string, unknown>> {
  return run.events.filter((e) => e['type'] === type);
}

try {
  const admin = sessionFor(await registerOrLogin('admin', 'w11-admin-123'));
  await admin.json('/api/providers', {
    method: 'POST',
    body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
  });
  for (const [name, password] of [['alice', 'w11-alice-123'], ['bob', 'w11-bob-123'], ['carol', 'w11-carol-123']] as const) {
    await admin.json('/api/users', { method: 'POST', body: JSON.stringify({ username: name, password, role: 'member' }) });
  }
  const alice = sessionFor(await registerOrLogin('alice', 'w11-alice-123'));
  const bob = sessionFor(await registerOrLogin('bob', 'w11-bob-123'));
  const carol = sessionFor(await registerOrLogin('carol', 'w11-carol-123'));

  // 1. 个人档位：alice 自选 readonly；bob 未自选 = 全局默认 workdir
  const aSet = await alice.json<{ tier: string; defaultTier: string }>('/api/me/tier', {
    method: 'PUT',
    body: JSON.stringify({ tier: 'readonly' }),
  });
  assert('RL1-02 alice 自选 readonly 生效', aSet.tier === 'readonly' && aSet.defaultTier === 'workdir', JSON.stringify(aSet));
  const bView = await bob.json<{ tier: string; defaultTier: string }>('/api/me/tier');
  assert('RL1-02 bob 未自选=回落全局默认 workdir', bView.tier === 'workdir' && bView.defaultTier === 'workdir');
  // bob 显式自选 workdir（与全局默认同值）——验证两层合并中个人层的存在感
  await bob.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });

  // 2. alice 的任务：界内写入被 readonly 直接拒绝（无授权卡）
  const taskA = await alice.json<{ task: { id: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: 'alice-任务', temp: true }) });
  const runA = await runTurn(alice, taskA.task.id, '请写入报告');
  const denyA = eventsOf(runA, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('RL1-02 alice readonly 拒绝界内写入', denyA?.ok === false && (denyA.message ?? '').includes('权限不足'), denyA?.message);
  assert('RL1-02 readonly 直接策略拒绝（无授权卡）', eventsOf(runA, 'permission_request').length === 0);

  // 3. bob 的任务：workdir 界内写入放行——A/B 档位互不影响
  const taskB = await bob.json<{ task: { id: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: 'bob-任务', temp: true }) });
  const runB = await runTurn(bob, taskB.task.id, '请写入报告');
  const okB = eventsOf(runB, 'tool_result')[0] as { ok?: boolean; message?: string } | undefined;
  assert('RL1-02 bob workdir 界内写入放行（不受 alice 影响）', okB?.ok === true, okB?.message);

  // 4. admin 改全局默认档为 readonly——只影响未自选者
  const gSet = await admin.raw('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier: 'readonly' }) });
  assert('RL1-02 admin 改全局默认档放行', gSet.status === 200);
  const bAfter = await bob.json<{ tier: string }>('/api/me/tier');
  assert('RL1-02 bob 个人档位不被全局改动覆盖', bAfter.tier === 'workdir');
  const cView = await carol.json<{ tier: string; defaultTier: string }>('/api/me/tier');
  assert('RL1-02 carol 未自选=回落新全局默认 readonly', cView.tier === 'readonly' && cView.defaultTier === 'readonly');
  const taskC = await carol.json<{ task: { id: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: 'carol-任务', temp: true }) });
  const runC = await runTurn(carol, taskC.task.id, '请写入报告');
  const denyC = eventsOf(runC, 'tool_result')[0] as { ok?: boolean } | undefined;
  assert('RL1-02 carol 按全局默认 readonly 拒写', denyC?.ok === false);
  const runB2 = await runTurn(bob, taskB.task.id, '请写入报告');
  const okB2 = eventsOf(runB2, 'tool_result')[0] as { ok?: boolean } | undefined;
  assert('RL1-02 全局收紧后 bob 个人 workdir 仍放行', okB2?.ok === true);

  // 5. 清除自选 → 回落全局默认；非法值 400；member 改全局 403
  const aClear = await alice.json<{ tier: string }>('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: null }) });
  assert('RL1-02 alice 清除自选后回落全局默认 readonly', aClear.tier === 'readonly');
  const bad = await alice.raw('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'god' }) });
  assert('RL1-02 非法档位值被拒（400）', bad.status === 400, `got ${bad.status}`);
  const memberGlobal = await bob.raw('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier: 'auto' }) });
  assert('RL1-02 member 改全局默认档被拒（403）', memberGlobal.status === 403, `got ${memberGlobal.status}`);

  // 6. 还原全局默认；alice 回落为 workdir
  await admin.json('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });
  const aFinal = await alice.json<{ tier: string }>('/api/me/tier');
  assert('RL1-02 全局还原后 alice 回落 workdir', aFinal.tier === 'workdir');

  // RL1-05：真实 SSE 授权卡回填，覆盖身份、任务、决策和重放。
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'ask' }) });
  const newTask = async (name: string): Promise<{ id: string; directory: string }> =>
    (await alice.json<{ task: { id: string; directory: string } }>('/api/tasks', {
      method: 'POST', body: JSON.stringify({ name, temp: true }),
    })).task;
  const approvalTask = await newTask('授权归属');
  const anotherTask = await newTask('同用户另一任务');
  const decide = (s: Session, taskId: string, id: unknown, decision: unknown) =>
    s.raw(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id, decision }) });
  let approvalId = '';
  const approved = await runTurn(alice, approvalTask.id, '请写入报告', async (event) => {
    approvalId = String(event['id']);
    assert('RL1-05 请求使用 UUID v4', /^pr-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(approvalId));
    assert('RL1-05 他人任务回填 403', (await decide(bob, approvalTask.id, approvalId, 'allow')).status === 403);
    assert('RL1-05 借自己的任务回填他人请求 403', (await decide(bob, taskB.task.id, approvalId, 'allow')).status === 403);
    assert('RL1-05 同用户跨任务回填 403', (await decide(alice, anotherTask.id, approvalId, 'allow')).status === 403);
    assert('RL1-05 管理员也不能跨任务回填 403', (await decide(admin, anotherTask.id, approvalId, 'allow')).status === 403);
    assert('RL1-05 不存在的任务 404', (await decide(alice, 'missing-task', approvalId, 'allow')).status === 404);
    assert('RL1-05 不存在的请求 404', (await decide(alice, approvalTask.id, 'missing-request', 'allow')).status === 404);
    for (const invalid of ['god', 'once', '', null, true, {}, ['allow']]) {
      assert(`RL1-05 非法决策 ${JSON.stringify(invalid)} 返回 400`, (await decide(alice, approvalTask.id, approvalId, invalid)).status === 400);
    }
    assert('RL1-05 非字符串请求 ID 返回 400', (await decide(alice, approvalTask.id, {}, 'allow')).status === 400);
    assert('RL1-05 一次性卡不能升级 session', (await decide(alice, approvalTask.id, approvalId, 'session')).status === 400);
    assert('RL1-05 一次性卡不能升级 forever', (await decide(alice, approvalTask.id, approvalId, 'forever')).status === 400);
    assert('RL1-05 非法回填后文件仍未写入', !existsSync(join(approvalTask.directory, 'out.md')));
    assert('RL1-05 请求保留且所有者可正常批准', (await decide(alice, approvalTask.id, approvalId, 'allow')).status === 200);
    assert('RL1-05 已消费请求不能重放', (await decide(alice, approvalTask.id, approvalId, 'allow')).status === 404);
  });
  assert('RL1-05 授权后真实执行并结束', eventsOf(approved, 'tool_result')[0]?.['ok'] === true && existsSync(join(approvalTask.directory, 'out.md')) && eventsOf(approved, 'done').length === 1);

  const delegatedTask = await newTask('管理员代管');
  const delegated = await runTurn(admin, delegatedTask.id, '请写入报告', async (event) => {
    assert('RL1-05 管理员代跑仍按所有者 ask 产生授权卡', event['scope'] === 'once');
    assert('RL1-05 管理员可批准正确任务的授权', (await decide(admin, delegatedTask.id, event['id'], 'allow')).status === 200);
  });
  assert('RL1-05 管理员代管实际执行成功', eventsOf(delegated, 'tool_result')[0]?.['ok'] === true);

  const dangerTask = await newTask('高危授权范围');
  const dangerous = await runTurn(alice, dangerTask.id, '测试高危审批', async (event) => {
    assert('RL1-05 高危卡仅限 once', event['scope'] === 'once');
    assert('RL1-05 高危卡拒绝 session', (await decide(alice, dangerTask.id, event['id'], 'session')).status === 400);
    assert('RL1-05 高危卡拒绝 forever', (await decide(alice, dangerTask.id, event['id'], 'forever')).status === 400);
    assert('RL1-05 高危卡仍可拒绝', (await decide(alice, dangerTask.id, event['id'], 'deny')).status === 200);
  });
  assert('RL1-05 高危命令未执行', eventsOf(dangerous, 'tool_result')[0]?.['ok'] === false);
  assert('RL1-05 伪造永久授权没有写入白名单', !existsSync(join(home, 'config', 'permissions.json')));

  // RL1-07：真实 HTTP stop，授权等待应结束、旧请求失效、任务可重用。
  const stoppedTask = await newTask('等待授权时停止');
  let stoppedId = '';
  const stopped = await runTurn(alice, stoppedTask.id, '请写入报告', async (event) => {
    stoppedId = String(event['id']);
    assert('RL1-07 等待授权时 stop 成功', (await alice.raw(`/api/tasks/${stoppedTask.id}/stop`, { method: 'POST' })).status === 200);
  });
  assert('RL1-07 stop 后任务以 aborted 结束', eventsOf(stopped, 'done')[0]?.['stopReason'] === 'aborted');
  assert('RL1-07 stop 后没有写入文件', !existsSync(join(stoppedTask.directory, 'out.md')));
  assert('RL1-07 stop 后旧授权 404', (await decide(alice, stoppedTask.id, stoppedId, 'allow')).status === 404);
  const resumed = await runTurn(alice, stoppedTask.id, '请写入报告', async (event) => {
    await decide(alice, stoppedTask.id, event['id'], 'allow');
  });
  assert('RL1-07 停止后任务可再次执行', eventsOf(resumed, 'done')[0]?.['stopReason'] === 'completed' && existsSync(join(stoppedTask.directory, 'out.md')));

  const disconnectTask = await newTask('等待授权时断线');
  const disconnected = new AbortController();
  const response = await fetch(`${base}/api/tasks/${disconnectTask.id}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ content: '请写入报告' }), signal: disconnected.signal,
  });
  const stream = response.body!.getReader();
  let received = '';
  const disconnectTimer = setTimeout(() => disconnected.abort(), 5000);
  try {
    while (!received.includes('permission_request')) {
      const chunk = await stream.read();
      if (chunk.done) throw new Error('未收到授权卡');
      received += new TextDecoder().decode(chunk.value);
    }
  } finally { clearTimeout(disconnectTimer); disconnected.abort(); await stream.cancel().catch(() => undefined); }
  let status = 'running';
  const until = Date.now() + 5000;
  while (status === 'running' && Date.now() < until) {
    status = (await alice.json<{ task: { status: string } }>(`/api/tasks/${disconnectTask.id}`)).task.status;
    if (status === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert('RL1-07 客户端断线后任务释放', status === 'interrupted');
  assert('RL1-07 断线后文件未写入', !existsSync(join(disconnectTask.directory, 'out.md')));
  const reconnect = await runTurn(alice, disconnectTask.id, '请写入报告');
  assert('RL1-07 断线后可重新对话', eventsOf(reconnect, 'done').length === 1);

  await checkPermissionLifecycle(home, workspace, alice, bob, admin, assert);
  const { checkProjectMemory } = await import('./W11-project-memory.mts');
  await checkProjectMemory(admin, alice, bob, assert);
  const { checkPermissionMatrix } = await import('./W11-permission-matrix.mts');
  await checkPermissionMatrix((await alice.json<{ user: { id: string } }>('/api/auth/state')).user.id, workspace, assert);
  const aid = (await alice.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const bid = (await bob.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const { project: changingProject } = await admin.json<{ project: { id: string } }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: '运行中成员变更' }) });
  await admin.json(`/api/projects/${changingProject.id}/access`, { method: 'PUT', body: JSON.stringify({ ownerUserId: aid, memberUserIds: [] }) });
  const { task: changingTask } = await alice.json<{ task: { id: string; directory: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: '等待时移出', projectId: changingProject.id }) });
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'ask' }) });
  const changingRun = await runTurn(alice, changingTask.id, '写入报告', async () => {
    await admin.json(`/api/projects/${changingProject.id}/access`, { method: 'PUT', body: JSON.stringify({ ownerUserId: bid, memberUserIds: [] }) });
  });
  assert('RL1-08 成员变更中止正在等待的任务', eventsOf(changingRun, 'done').some((e) => e['stopReason'] === 'aborted'));
  assert('RL1-08 移出成员后旧执行未写文件', !existsSync(join(changingTask.directory, 'out.md')));

  // 7. 审计：档位变更留操作者（I03 本地 JSONL 审计=竞品差异点）
  const auditText = readdirSync(join(home, 'audit'))
    .map((f) => readFileSync(join(home, 'audit', f), 'utf8'))
    .join('');
  assert('RL1-02 审计含个人档位变更事件', auditText.includes('"event":"user_tier_changed"') || auditText.includes('"event":"my_tier_changed"'));
  assert('RL1-02 审计含全局默认档变更（admin 操作）', auditText.includes('"event":"tier_changed"') && auditText.includes('"user":"admin"'));
  const approvalAudit = auditText.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row['event'] === 'permission_decision' && row['detail'] === approvalId);
  assert('RL1-05 非法回填不伪造成功审批审计', approvalAudit.length === 1 && approvalAudit[0]?.['user'] === 'alice' && approvalAudit[0]?.['decision'] === 'allow');
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W11 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
