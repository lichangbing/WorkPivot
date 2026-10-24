/**
 * C 方案（worker 直接挂载任务目录）的离线检查：
 * 子路径换算、worker 侧校验、以及 workerCommand 发出的请求体形态。
 * 不启动 Docker；真实挂载与容器内读写需在 WSL/Linux 上验证。
 */
import assert from 'node:assert/strict';
import { workspaceSubpath } from '../packages/server/src/workspace-mount.js';
import { validateMount } from '../scripts/skill-worker.mjs';

let checks = 0;
async function check(label: string, run: () => void | Promise<void>): Promise<void> {
  try { await run(); checks += 1; console.log('ok', label); }
  catch (error) { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; }
}

await check('任务目录换算成卷内子路径', () => {
  assert.equal(workspaceSubpath('/data/workspace/.accounts/u1/p-1', '/data/workspace'), '.accounts/u1/p-1');
  assert.equal(workspaceSubpath('/data/workspace/_temp/t-1', '/data/workspace'), '_temp/t-1');
});

await check('工作区根与界外目录不允许挂载', () => {
  assert.equal(workspaceSubpath('/data/workspace', '/data/workspace'), null);
  assert.equal(workspaceSubpath('/data/workpivot/data', '/data/workspace'), null);
  assert.equal(workspaceSubpath('/data/workspace/../workpivot', '/data/workspace'), null);
});

await check('超长子路径被拒绝', () => {
  const deep = Array.from({ length: 60 }, (_, index) => `segment-${index}`).join('/');
  assert.equal(workspaceSubpath(`/data/workspace/${deep}`, '/data/workspace'), null);
});

await check('worker 只接受相对子路径', () => {
  assert.equal(validateMount({ subpath: '.accounts/u1/p-1' }), '.accounts/u1/p-1');
  assert.throws(() => validateMount({ subpath: '/etc' }), /挂载子路径无效/);
  assert.throws(() => validateMount({ subpath: 'a/../b' }), /挂载子路径无效/);
  assert.throws(() => validateMount({ subpath: 'a/./b' }), /挂载子路径无效/);
  assert.throws(() => validateMount({ subpath: 'a\\b' }), /挂载子路径无效/);
  assert.throws(() => validateMount({ subpath: '' }), /挂载子路径无效/);
});

await check('worker 拒绝额外字段与空参数', () => {
  assert.throws(() => validateMount({ subpath: 'a', volume: 'x' }), /挂载参数无效/);
  assert.throws(() => validateMount(null), /挂载参数无效/);
  assert.throws(() => validateMount({}), /挂载子路径无效/);
});

// workerCommand 的请求体：配置了工作区卷时只发 mount，不发文件快照。
await check('配置工作区卷时请求体改为挂载模式', async () => {
  process.env['WORKPIVOT_WORKER_URL'] = 'http://worker.test';
  process.env['WORKPIVOT_WORKER_TOKEN'] = 'test-token';
  process.env['WORKPIVOT_WORKSPACE'] = '/data/workspace';
  process.env['WORKPIVOT_WORKSPACE_VOLUME'] = 'workpivot-workspace';
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init.body)));
    const payload = Buffer.from(JSON.stringify({ files: [], output: 'ok' }));
    return {
      ok: true,
      status: 200,
      body: { getReader: () => { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: payload }), cancel: async () => undefined, releaseLock: () => undefined }; } },
    };
  }) as never;
  try {
    const { workerCommand } = await import('../packages/server/src/worker-command.js');
    const run = workerCommand({ id: 't', directory: '/data/workspace/.accounts/u1/p-1' } as never, () => true, new AbortController().signal, () => []);
    const output = await run('python3 main.py');
    assert.equal(output, 'exit=0\nok');
    assert.deepEqual(bodies[0]?.mount, { subpath: '.accounts/u1/p-1' });
    assert.equal(bodies[0]?.files, undefined, '挂载模式不应发送文件快照');
  } finally {
    globalThis.fetch = original;
    delete process.env['WORKPIVOT_WORKSPACE_VOLUME'];
  }
});

console.log(`run_code mount checks passed: ${checks}`);
