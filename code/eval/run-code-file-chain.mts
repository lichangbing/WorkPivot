/**
 * 文件链路 run_code 的离线检查：脚本落盘、命令拼装、参数与权限边界、目录串行。
 * 不启动容器、不依赖数据库；真实 worker 回写与 local 模式链路由 WSL/Linux 环境验证。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runCodeTool } from '../packages/server/src/code-tools.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  try { await run(); checks += 1; console.log('ok', label); }
  catch (error) { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; }
}

const dir = await mkdtemp(join(tmpdir(), 'wp-run-code-'));
const context = (extra: Record<string, unknown> = {}) => ({ taskDir: dir, ...extra }) as never;
const okExecute = async (command: string) => { captured.last = command; return 'exit=0\nhello'; };
const captured: { last?: string } = {};

try {
  await check('python 脚本写入工作目录且命令指向该脚本', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    const result = await tool.run({ language: 'python', code: 'print("hi")' }, context());
    assert.match(result, /hello/);
    assert.match(result, /脚本：\.workpivot\/run-code\/[^/]+\/main\.py/);
    const relativePath = /^python3 (\S+)$/.exec(captured.last ?? '')?.[1];
    assert.ok(relativePath, '命令应使用 python3 执行脚本');
    assert.equal(await readFile(join(dir, ...relativePath.split('/')), 'utf8'), 'print("hi")');
  });

  await check('node 入口使用 main.cjs 与 node 解释器', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    await tool.run({ language: 'node', code: 'console.log(1)' }, context());
    assert.match(captured.last ?? '', /^node \.workpivot\/run-code\/[^/]+\/main\.cjs$/);
  });

  await check('sh 在 Linux 容器里使用 /bin/sh', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    await tool.run({ language: 'sh', code: 'echo ok' }, context());
    assert.match(captured.last ?? '', /^\/bin\/sh \.workpivot\/run-code\/[^/]+\/run\.sh$/);
  });

  await check('Windows 本机模式拒绝 sh', async () => {
    const tool = runCodeTool({ container: false, platform: 'win32', execute: okExecute });
    const result = await tool.run({ language: 'sh', code: 'echo ok' }, context());
    assert.match(result, /不支持 sh/);
  });

  await check('未知语言与空代码被拒绝，且不写脚本', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    const before = existsSync(join(dir, '.workpivot'));
    assert.match(await tool.run({ language: 'ruby', code: 'puts 1' }, context()), /language 只能是/);
    assert.match(await tool.run({ language: 'python', code: '   ' }, context()), /code 必填/);
    assert.equal(existsSync(join(dir, '.workpivot')), before);
  });

  await check('文件权限拒绝时不落盘', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    const result = await tool.run({ language: 'python', code: 'print(1)' }, context({ filePolicy: () => false }));
    assert.match(result, /无权在工作目录写入脚本/);
  });

  await check('审批摘要只描述语言与行数', async () => {
    const tool = runCodeTool({ container: true, execute: okExecute });
    const request = tool.access!({ language: 'python', code: 'a\nb\nc' }, {} as never);
    assert.equal(request.kind, 'bash');
    assert.deepEqual(request.paths, []);
    assert.match(String(request.command), /python 代码 3 行/);
  });

  await check('同一工作目录的并发执行串行化', async () => {
    const active = { now: 0, max: 0 };
    const tool = runCodeTool({ container: true, execute: async () => {
      active.now += 1; active.max = Math.max(active.max, active.now);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active.now -= 1;
      return 'exit=0\nok';
    } });
    await Promise.all([
      tool.run({ language: 'python', code: 'a' }, context()),
      tool.run({ language: 'python', code: 'b' }, context()),
    ]);
    assert.equal(active.max, 1, '同一目录不应并行执行');
  });
  console.log(`run_code file-chain checks passed: ${checks}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
