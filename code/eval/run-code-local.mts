/**
 * run_code 的离线检查：参数契约、worker 客户端、对话事件可见性。
 * 不需要 PostgreSQL 或 Docker；真实沙箱链路（容器、无网络、产物发布事务）由
 * scripts/test-database-worker.mjs 在 WSL/Linux 上验证。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { parseSandboxInputs, parseSandboxOutputs } from '../packages/server/src/database/sandbox-args.js';
import { runSandbox } from '../packages/server/src/database/sandbox.js';
import { publicToolEvent } from '../packages/server/src/database/tool-events.js';
import { DatabaseCodeExecution } from '../packages/server/src/database/code-execution.js';
import { registerDatabaseTools } from '../packages/server/src/database/tool-policy.js';
import { toolValidator } from '../packages/server/src/database/tool-schema.js';

let checks = 0;
function check(label: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(() => { checks += 1; console.log('ok', label); }, (error) => { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; });
}
const id = () => randomUUID();
const rejects = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, pattern);
const throws = (fn: () => unknown, pattern: RegExp) => assert.throws(fn, pattern);

async function main(): Promise<void> {
  // 产物契约：只允许文件名、必须声明 revision 配对、清单不可重复。
  await check('产物声明接受单个文件名', () => { assert.deepEqual(parseSandboxOutputs([{ name: 'report.docx' }]), [{ name: 'report.docx', documentId: undefined, revision: undefined }]); });
  await check('产物名称不得包含目录', () => { throws(() => parseSandboxOutputs([{ name: '/workspace/report.docx' }]), /只填写文件名/); });
  await check('产物清单不可重复', () => { throws(() => parseSandboxOutputs([{ name: 'a.docx' }, { name: 'a.docx' }]), /产物清单重复/); });
  await check('产物数量上限为10', () => { throws(() => parseSandboxOutputs(Array.from({ length: 11 }, (_, index) => ({ name: `f${index}.docx` }))), /需要1至10个产物/); });
  await check('空产物清单被拒绝', () => { throws(() => parseSandboxOutputs([]), /需要1至10个产物/); });
  await check('更新成果需要修订号', () => { throws(() => parseSandboxOutputs([{ name: 'a.docx', documentId: id() }]), /需要产物修订号/); });
  await check('修订号不能脱离成果标识', () => { throws(() => parseSandboxOutputs([{ name: 'a.docx', revision: 2 }]), /缺少产物标识/); });
  await check('输入必须是文件版本ID', () => { throws(() => parseSandboxInputs(['not-a-uuid']), /标识无效/); });
  await check('输入数量上限为10', () => { throws(() => parseSandboxInputs(Array.from({ length: 11 }, id)), /输入文件列表无效/); });
  await check('输入允许为空', () => { assert.deepEqual(parseSandboxInputs([]), []); });

  // worker 客户端：只信任结构完整的响应，错误与超限必须带明确状态。
  const state = { mode: 'ok' as 'ok' | 'busy' | 'error' | 'malformed' | 'oversize' };
  const server = createServer((req, res) => {
    if (state.mode === 'busy') { res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'busy' })); return; }
    if (state.mode === 'error') { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'worksheet missing' })); return; }
    if (state.mode === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ files: 'nope', output: 'x' })); return; }
    if (state.mode === 'oversize') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pad: 'a'.repeat(25 * 1024 * 1024), files: [], output: '' })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ files: [['report.docx', Buffer.from([0x50, 0x4b]).toString('base64')]], output: 'done' }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('测试服务未取得端口');
  const config = { url: `http://127.0.0.1:${address.port}`, token: 'test' };
  try {
    await check('成功响应按原样返回文件与输出', async () => {
      const result = await runSandbox(config, { command: 'python3 main.py', files: [], skills: [] });
      assert.equal(result.output, 'done');
      assert.deepEqual(result.files, [['report.docx', Buffer.from([0x50, 0x4b]).toString('base64')]]);
    });
    await check('繁忙时给出可重试提示', async () => { state.mode = 'busy'; await rejects(runSandbox(config, { command: 'x', files: [], skills: [] }), /繁忙/); });
    await check('执行失败透出服务端原因', async () => { state.mode = 'error'; await rejects(runSandbox(config, { command: 'x', files: [], skills: [] }), /worksheet missing/); });
    await check('结构不完整的响应被拒绝', async () => { state.mode = 'malformed'; await rejects(runSandbox(config, { command: 'x', files: [], skills: [] }), /执行输出格式无效/); });
    await check('超过响应上限时中止读取', async () => { state.mode = 'oversize'; await rejects(runSandbox(config, { command: 'x', files: [], skills: [] }), /执行输出过大/); });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 静默执行没有授权卡，代码必须留在对话事件里；其他工具仍只保留元数据。
  await check('run_code 的调用事件保留有上限的代码', () => {
    const event = publicToolEvent({ type: 'tool_use', toolName: 'run_code', callId: 'c1', args: { language: 'python', code: 'x'.repeat(9000), inputs: [], outputs: [] } });
    const args = event.args as Record<string, unknown>;
    assert.equal(args['language'], 'python');
    assert.equal(String(args['code']).length, 8000);
    assert.equal(args['codeTruncated'], true);
  });
  await check('其他工具的调用事件不留参数', () => {
    const event = publicToolEvent({ type: 'tool_use', toolName: 'execute_skill', callId: 'c2', args: { command: 'secret' } });
    assert.equal(event.args, undefined);
  });

  // 工具契约：名称、效果类别、参数定义与静默放行声明必须一致，避免运行时才被注册表拒绝。
  const tool = new DatabaseCodeExecution({} as never, {} as never, { url: 'http://127.0.0.1:1', token: 'test' }).tool('actor', 'task');
  await check('工具声明为执行类写操作', () => {
    assert.equal(tool.name, 'run_code');
    assert.equal(tool.kind, 'write');
    assert.equal(tool.displayName, '运行代码');
    const [registered] = registerDatabaseTools([tool], new Set());
    assert.deepEqual(registered?.effects, ['execution', 'write']);
    assert.equal(registered?.resultSource, 'execution');
  });
  await check('参数定义接受最小调用并拒绝未知语言', () => {
    const validate = toolValidator(tool.parameters);
    validate({ language: 'python', code: 'print(1)' });
    throws(() => validate({ language: 'ruby', code: 'puts 1' }), /不符合定义/);
    throws(() => validate({ language: 'python' }), /不符合定义/);
    throws(() => validate({ language: 'python', code: 'x', extra: 1 }), /不符合定义/);
  });
  await check('授权请求声明静默执行且不带宿主路径', () => {
    const request = tool.access!({ language: 'node', code: 'console.log(1)', inputs: [], outputs: [{ name: 'a.txt' }] }, {} as never);
    assert.equal(request.auto, true);
    assert.equal(request.external, true);
    assert.deepEqual(request.paths, []);
    assert.match(String(request.command), /node 代码 1 行；输入 0 个；产物 1 个/);
  });
  console.log(`run_code local checks passed: ${checks}`);
}

await main().then(() => { process.exitCode = 0; }, (error) => { console.error(error); process.exitCode = 1; });
