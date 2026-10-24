/**
 * 优化第三批（O-09、O-11、O-12、O-13、O-18、O-19）验收。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyClaimedFiles } from '../packages/server/src/chat-gate.js';
import { createSearchTool, resetSearchCache } from '../packages/server/src/web/search.js';
import { withDirectoryLock } from '../packages/server/src/directory-lock.js';
import { normalizeTier } from '../packages/server/src/permissions.js';
import { guardDeletions } from '../packages/server/src/deletion-guard.js';
import { runAgentLoop } from '../packages/core/src/loop.js';
import type { ModelClient, StreamEvent, Tool } from '../packages/core/src/index.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

const root = await mkdtemp(join(tmpdir(), 'wp-opt3-'));
try {
  await check('O-09 声称产出但未登记交付时提示，登记后放行', async () => {
    await mkdir(join(root, 'gate'), { recursive: true });
    await writeFile(join(root, 'gate', '报告 v1.0 2026-10-24.docx'), 'x');
    const text = '已生成报告 v1.0 2026-10-24.docx';
    const undelivered = verifyClaimedFiles(text, join(root, 'gate'), { delivered: new Set() });
    assert.deepEqual(undelivered.missing, []);
    assert.deepEqual(undelivered.undelivered, ['报告 v1.0 2026-10-24.docx']);
    const delivered = verifyClaimedFiles(text, join(root, 'gate'), { delivered: new Set(['报告 v1.0 2026-10-24.docx']) });
    assert.deepEqual(delivered.undelivered, []);
  });

  await check('O-09 缺失文件仍报 missing，扩展名白名单包含图片', async () => {
    const result = verifyClaimedFiles('已生成 chart.png', root);
    assert.deepEqual(result.missing, ['chart.png']);
  });

  await check('O-11 相同查询 5 分钟内复用缓存，只请求一次服务', async () => {
    resetSearchCache();
    let calls = 0;
    const tool = createSearchTool({ provider: 'searxng', url: 'https://search.example' }, (async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ title: 'A', url: 'https://a.example/x', content: '摘要' }] }) };
    }) as never);
    const first = await tool.run({ query: '季度报告模板' }, { taskDir: root });
    const second = await tool.run({ query: '季度报告模板' }, { taskDir: root });
    assert.equal(calls, 1, '第二次应命中缓存');
    assert.equal(first, second);
    resetSearchCache();
    await tool.run({ query: '季度报告模板' }, { taskDir: root });
    assert.equal(calls, 2, '清空缓存后应重新请求');
  });

  await check('O-12 跨进程文件锁：另一个进程持锁时本进程等待', async () => {
    const dir = join(root, 'lockdir');
    await mkdir(dir, { recursive: true });
    const script = `
      import { withDirectoryLock } from './packages/server/src/directory-lock.ts';
      await withDirectoryLock(${JSON.stringify(dir)}, async () => {
        console.log('locked');
        await new Promise(r => setTimeout(r, 600));
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      let seen = '';
      const timer = setTimeout(() => reject(new Error('子进程未取得锁')), 15000);
      child.stdout.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes('locked')) { clearTimeout(timer); resolve(); }
      });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    const started = Date.now();
    await withDirectoryLock(dir, async () => undefined);
    const waited = Date.now() - started;
    await exited;
    assert.ok(waited >= 400, `应等待子进程释放锁（实际 ${waited}ms）`);
  });

  await check('O-18 旧档位归一化为确认/自动两档', async () => {
    assert.equal(normalizeTier('auto'), 'auto');
    assert.equal(normalizeTier('workdir'), 'auto');
    assert.equal(normalizeTier('ask'), 'ask');
    assert.equal(normalizeTier('readonly'), 'ask');
    assert.equal(normalizeTier(undefined), 'ask');
  });

  await check('O-19 删除文件后给出清单与可恢复副本', async () => {
    const dir = join(root, 'guard');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'keep.txt'), 'keep');
    await writeFile(join(dir, 'sub', 'gone.txt'), 'gone');
    const output = await guardDeletions(dir, async () => {
      await rm(join(dir, 'sub', 'gone.txt'));
      return 'done';
    });
    assert.match(output, /删除提示/);
    assert.match(output, /sub\/gone\.txt/);
    assert.match(output, /副本：\.workpivot\/trash\//);
  });

  await check('O-19 没有删除时不产生噪音', async () => {
    const dir = join(root, 'guard2');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a');
    const output = await guardDeletions(dir, async () => 'ok');
    assert.equal(output, 'ok');
  });

  await check('O-13 同轮多个只读工具并行、写入工具串行', async () => {
    const runBatch = async (tools: Tool[], calls: Array<{ name: string }>) => {
      let active = 0;
      let peak = 0;
      const wrapped: Tool[] = tools.map((tool) => ({
        ...tool,
        async run() {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 60));
          active -= 1;
          return `${tool.name}-ok`;
        },
      } as Tool));
      let sent = false;
      const client = {
        providerId: 'test', model: 'test',
        async *streamChat(): AsyncGenerator<StreamEvent> {
          if (!sent) {
            sent = true;
            yield { type: 'tool_calls', tool_calls: calls.map((call, index) => ({ id: `c${index}`, type: 'function' as const, function: { name: call.name, arguments: '{}' } })) };
            return;
          }
          yield { type: 'delta', text: '完成' };
        },
      } as unknown as ModelClient;
      await runAgentLoop({ client, tools: wrapped, system: 'sys', taskDir: root, messages: [{ role: 'user', content: '跑' }], maxSteps: 3 });
      return peak;
    };
    const readTool = (name: string): Tool => ({ name, kind: 'read', description: '', parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } });
    const writeTool = (name: string): Tool => ({ name, kind: 'write', description: '', parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } });
    assert.equal(await runBatch([readTool('a'), readTool('b')], [{ name: 'a' }, { name: 'b' }]), 2, '只读工具应并行');
    assert.equal(await runBatch([writeTool('a'), writeTool('b')], [{ name: 'a' }, { name: 'b' }]), 1, '写入工具必须串行');
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n优化第三批：${checks} 项通过`);
