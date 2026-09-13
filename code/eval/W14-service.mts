import { createServer } from 'node:http';
export async function checkService(assert: (name: string, pass: boolean) => void): Promise<void> {
  process.env['WORKPIVOT_MAX_PARALLEL'] = '2';
  const { startServer } = await import('../packages/server/src/index.js');
  const { login } = await import('../packages/server/src/auth.js');
  const { getTask } = await import('../packages/server/src/tasks.js');
  let mode = 'hang';
  const mock = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (req.method === 'GET') { res.end('{"data":[]}'); return; }
      if (mode === 'error') { res.writeHead(400); res.end('mock-invalid-request'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'started' } }] })}\n\n`);
      if (mode === 'done') res.end('data: [DONE]\n\n');
      if (mode === 'disconnect') setTimeout(() => res.destroy(), 20);
    });
  });
  await new Promise<void>((resolve) => mock.listen(40031, '127.0.0.1', resolve));
  const server = await startServer({ port: 40032 });
  const token = login('admin', 'stability-password').token;
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const api = (path: string, body?: unknown, signal?: AbortSignal): Promise<Response> => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10000) });
  try {
    await api('/api/providers', { name: 'stability-mock', baseUrl: 'http://127.0.0.1:40031/v1', modelId: 'mock' });
    const tasks: string[] = [];
    for (let i = 0; i < 3; i++) tasks.push((await (await api('/api/tasks', { name: `concurrent-${i}` })).json()).task.id);
    const path = (i: number) => `/api/tasks/${tasks[i]}/messages`;
    const first = await api(path(0), { content: 'hang' }); const text1 = first.text();
    const second = await api(path(1), { content: 'hang' }); const text2 = second.text();
    assert('RL4 两个任务可并发流式执行', first.ok && second.ok);
    assert('RL4 同一任务重复执行被拒', (await api(path(0), { content: 'duplicate' })).status === 409);
    assert('RL4 超并发请求被限流', (await api(path(2), { content: 'over-limit' })).status === 429);
    await api(`/api/tasks/${tasks[0]}/stop`, {}); await text1;
    assert('RL4 停止模型挂起任务释放执行槽', getTask(tasks[0]!)?.status === 'interrupted');
    mode = 'done';
    assert('RL4 停止后第三个任务可立即执行', (await (await api(path(2), { content: 'finish' })).text()).includes('"type":"done"'));
    await api(`/api/tasks/${tasks[1]}/stop`, {}); await text2;
    mode = 'error';
    assert('RL4 模型 HTTP 错误反馈并结束流', (await (await api(path(0), { content: 'bad-request' })).text()).includes('"type":"error"'));
    mode = 'disconnect';
    assert('RL4 模型断流反馈并结束任务', (await (await api(path(0), { content: 'broken-stream' })).text()).includes('"type":"error"'));
    mode = 'done';
    assert('RL4 模型故障后同一任务可重新运行', (await (await api(path(0), { content: 'retry' })).text()).includes('"type":"done"'));
    mode = 'hang'; const controller = new AbortController();
    const disconnected = await api(path(0), { content: 'client-disconnect' }, controller.signal);
    const body = disconnected.text().catch(() => 'aborted'); controller.abort(); await body;
    const deadline = Date.now() + 2000;
    while (getTask(tasks[0]!)?.status === 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert('RL4 客户端断开后任务停止', getTask(tasks[0]!)?.status === 'interrupted');
    const final = await api(path(1), { content: 'shutdown' }); const ended = final.text();
    await server.close(); await ended;
    assert('RL4 服务关闭会停止挂起任务并释放连接', getTask(tasks[1]!)?.status === 'interrupted');
  } finally { await server.close(); mock.closeAllConnections(); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}
