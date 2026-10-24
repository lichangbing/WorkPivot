/**
 * 优化清单第一批（O-01～O-04、O-08）验收：授权文案、目录锁、read 分页、输出头尾保留、原子写。
 * 不依赖真实模型与数据库。
 */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool, executeShell, readTool, writeTool } from '../packages/core/src/tools.js';
import { withDirectoryLock } from '../packages/server/src/directory-lock.js';
import { externalActionLabel } from '../packages/server/src/permissions.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

const root = await mkdtemp(join(tmpdir(), 'wp-opt-'));
try {
  await check('O-01 外部动作文案按工具生成，未知工具回落为外部工具调用', async () => {
    assert.equal(externalActionLabel('web_search'), '联网搜索');
    assert.equal(externalActionLabel('web_fetch'), '读取网页');
    assert.equal(externalActionLabel('browser_visit'), '浏览网页');
    assert.equal(externalActionLabel('mcp__demo__tools'), '外部工具调用');
  });

  await check('O-03 read 支持 offset/limit 并返回行号与续读提示', async () => {
    const file = join(root, 'big.txt');
    await writeFile(file, Array.from({ length: 100 }, (_, i) => `line-${i + 1}`).join('\n'), 'utf8');
    const text = await readTool.run({ path: 'big.txt', offset: 10, limit: 5 }, { taskDir: root });
    assert.match(text, /^10\tline-10/, '应从第 10 行开始并带行号');
    assert.match(text, /14\tline-14/);
    assert.ok(!text.includes('line-15'), '不能超出 limit');
    assert.match(text, /还有 86 行，用 offset=15 继续/);
  });

  await check('O-03 越界 offset 报错、limit 越界拒绝、小文件保持原文', async () => {
    await assert.rejects(() => readTool.run({ path: 'big.txt', offset: 0 }, { taskDir: root }), /offset/);
    await assert.rejects(() => readTool.run({ path: 'big.txt', limit: 100000 }, { taskDir: root }), /limit/);
    const outOfRange = await readTool.run({ path: 'big.txt', offset: 1000 }, { taskDir: root });
    assert.match(outOfRange, /超出范围/);
    await writeFile(join(root, 'small.txt'), 'hello\nworld', 'utf8');
    assert.equal(await readTool.run({ path: 'small.txt' }, { taskDir: root }), 'hello\nworld');
  });

  await check('O-04 命令输出超长时头尾都保留并标注省略', async () => {
    await writeFile(join(root, 'emit.cjs'), "process.stdout.write('HEAD-MARK\\n' + 'x'.repeat(200000) + '\\nTAIL-MARK');", 'utf8');
    const output = await executeShell('node emit.cjs', { taskDir: root });
    assert.match(output, /HEAD-MARK/, '必须保留开头');
    assert.match(output, /TAIL-MARK/, '必须保留结尾（错误栈常在末尾）');
    assert.match(output, /中间省略/);
  });

  await check('O-08 write 原子落盘，不残留临时文件', async () => {
    const result = await writeTool.run({ path: 'atomic.txt', content: 'a'.repeat(50000) }, { taskDir: root });
    assert.match(result, /已写入/);
    const files = await readdir(root);
    assert.ok(!files.some((name) => name.endsWith('.tmp')), '不能留下 .tmp 文件');
  });

  await check('O-08 edit 同样原子写并保持内容正确', async () => {
    await writeFile(join(root, 'edit.txt'), 'old-value', 'utf8');
    await editTool.run({ path: 'edit.txt', old_string: 'old-value', new_string: 'new-value' }, { taskDir: root });
    assert.equal(await readTool.run({ path: 'edit.txt' }, { taskDir: root }), 'new-value');
    const files = await readdir(root);
    assert.ok(!files.some((name) => name.startsWith('edit.txt.')), '不能留下中间文件');
  });

  await check('O-02 同一目录的执行串行化，峰值并发为 1', async () => {
    let active = 0;
    let peak = 0;
    const job = () => withDirectoryLock(root, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
    });
    await Promise.all([job(), job(), job()]);
    assert.equal(peak, 1, '同目录不能并行执行');
  });

  await check('O-02 跨目录不互相阻塞', async () => {
    const order: string[] = [];
    const other = await mkdtemp(join(tmpdir(), 'wp-opt-other-'));
    try {
      await Promise.all([
        withDirectoryLock(root, async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 40)); order.push('a-end'); }),
        withDirectoryLock(other, async () => { order.push('b-start'); await new Promise((r) => setTimeout(r, 10)); order.push('b-end'); }),
      ]);
      assert.deepEqual(order.slice(0, 2), ['a-start', 'b-start'], '不同目录应能并行开始');
    } finally { await rm(other, { recursive: true, force: true }); }
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n优化第一批：${checks} 项通过`);
