import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { artifactBytes, maximumArtifactBytes, safeArtifactName } from '../apps/mobile/src/artifact-data.js';

let passed = 0;
async function check(name: string, test: () => unknown | Promise<unknown>) { await test(); console.log('PASS', name); passed++; }
const data = new TextEncoder().encode('合成产物\nfixture,42');
const artifact = { id: 'test', name: '报告.csv', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
const signal = new AbortController().signal;
await check('完整文件校验后返回原始字节', async () => assert.deepEqual(await artifactBytes(new Response(data), artifact, signal), data));
await check('截断内容拒绝保存', () => assert.rejects(artifactBytes(new Response(data.subarray(1)), artifact, signal), /不完整/));
await check('相同长度内容篡改拒绝保存', () => assert.rejects(artifactBytes(new Response(new Uint8Array(data.length)), artifact, signal), /校验失败/));
await check('超出声明大小提前取消流', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(data.length + 1)); }, cancel() { cancelled = true; } });
  await assert.rejects(artifactBytes(new Response(stream), artifact, signal), /大小/); assert(cancelled);
});
await check('过大文件拒绝读取', () => assert.rejects(artifactBytes(new Response(data), { ...artifact, size: maximumArtifactBytes + 1 }, signal), /10MB/));
await check('缺少校验信息不保存', () => assert.rejects(artifactBytes(new Response(data), { ...artifact, sha256: '' }, signal), /校验信息/));
await check('退出期间取消正在等待的下载', async () => {
  const c = new AbortController();
  const pending = artifactBytes(new Response(new ReadableStream()), artifact, c.signal);
  c.abort(); await assert.rejects(pending, { name: 'AbortError' });
});
await check('安全名称保留中文和类型', () => assert.equal(safeArtifactName('季度报告.xlsx'), '季度报告.xlsx'));
await check('长中文文件名保留扩展名且不超字节限制', () => { const name = safeArtifactName('研究报告'.repeat(80) + '.xlsx'); assert(name.endsWith('.xlsx')); assert(new TextEncoder().encode(name).length <= 220); });
await check('路径分隔和控制字符不进入保存路径', () => assert(!/[\\/\u0000-\u001f]/.test(safeArtifactName('../财务\\报告\n.xlsx'))));
await check('保留设备名和空文件名可保存', () => { assert.equal(safeArtifactName('CON.pdf'), '_CON.pdf'); assert.equal(safeArtifactName('..'), '产物'); });
console.log(`Mobile artifacts: ${passed}/${passed}`);
