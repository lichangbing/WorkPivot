import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerCommand, snapshotFiles } from '../packages/server/src/worker-command.js';
import { executionMode } from '../packages/server/src/execution-policy.js';
import type { Task } from '../packages/server/src/tasks.js';
const root = mkdtempSync(join(tmpdir(), 'wp22-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
const directory = join(root, 'task'); mkdirSync(directory);
const task: Task = { id: 'test', name: 'test', directory, status: 'idle', createdAt: '' };
const skillDir = join(root, 'skill'); mkdirSync(skillDir); writeFileSync(join(skillDir, 'run.cjs'), 'TEST_SCRIPT');
const token = 'synthetic-worker-test-token-00000000';
process.env['WORKPIVOT_WORKER_URL'] = 'http://127.0.0.1:40061'; process.env['WORKPIVOT_WORKER_TOKEN'] = token;
let mode = 'ok', permitted = true, sentSkill = false, noPrivate = false, authenticated = false;
const server = createServer((req, res) => {
  let text = ''; req.on('data', (chunk) => { text += chunk; }); req.on('end', () => {
    const body = JSON.parse(text); authenticated = req.headers.authorization === `Bearer ${token}`;
    sentSkill = body.skills.some(([path]: [string]) => path === 'test/run.cjs');
    noPrivate = body.files.every(([path]: [string]) => path !== 'private.txt');
    if (mode === 'hang') return;
    if (mode === 'conflict') writeFileSync(join(directory, 'input.txt'), 'external-update');
    if (mode === 'revoke') permitted = false;
    res.setHeader('content-type', 'application/json');
    if (mode === 'failure') { res.statusCode = 400; res.end('{"error":"failed"}'); return; }
    const files = mode === 'traversal' ? [['../escape', 'eA==']] : mode === 'duplicate' ? [['a', ''], ['a', '']] : mode === 'encoding' ? [['a', '%%%']] : [['input.txt', Buffer.from('changed').toString('base64')], ['out.bin', 'AAH/']];
    res.end(JSON.stringify({ files, output: 'ok' }));
  });
});
await new Promise<void>((resolve) => server.listen(40061, '127.0.0.1', resolve));
const results: boolean[] = [];
const assert = (name: string, pass: boolean): void => { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); };
const reset = () => { permitted = true; writeFileSync(join(directory, 'input.txt'), 'original'); writeFileSync(join(directory, 'private.txt'), 'PRIVATE'); };
const run = (signal = new AbortController().signal) => workerCommand(task, (path) => permitted && path !== join(directory, 'private.txt'), signal, () => [{ name: 'test', description: '', content: '', source: 'global', dir: skillDir }])('node /skills/test/run.cjs');
const reject = async () => { try { await run(); return false; } catch { return true; } };
try {
  assert('Worker配置不完整时关闭执行', executionMode({ WORKPIVOT_EXECUTION_MODE: 'worker' }) === 'disabled');
  assert('Worker配置完整时启用', executionMode({ WORKPIVOT_EXECUTION_MODE: 'worker', WORKPIVOT_WORKER_URL: 'http://worker', WORKPIVOT_WORKER_TOKEN: token }) === 'worker');
  reset(); await run();
  assert('Worker请求认证且只发送授权文件', authenticated && noPrivate);
  assert('Worker发送已加载Skill资源', sentSkill);
  assert('Worker成功回写文件和二进制产物', readFileSync(join(directory, 'input.txt'), 'utf8') === 'changed' && readFileSync(join(directory, 'out.bin')).equals(Buffer.from([0, 1, 255])));
  assert('Worker未读取文件不会被删除', readFileSync(join(directory, 'private.txt'), 'utf8') === 'PRIVATE');
  reset(); mode = 'failure'; assert('Worker失败不修改任务文件', await reject() && readFileSync(join(directory, 'input.txt'), 'utf8') === 'original');
  mode = 'conflict'; assert('Worker文件冲突拒绝覆盖', await reject() && readFileSync(join(directory, 'input.txt'), 'utf8') === 'external-update');
  reset(); mode = 'revoke'; assert('Worker撤销写权限拒绝回写', await reject() && readFileSync(join(directory, 'input.txt'), 'utf8') === 'original');
  for (const value of ['traversal', 'duplicate', 'encoding']) { reset(); mode = value; assert(`Worker拒绝非法返回 ${value}`, await reject() && !existsSync(join(root, 'escape'))); }
  reset(); mode = 'hang'; const abort = new AbortController(); const pending = run(abort.signal).then(() => false, () => true); setTimeout(() => abort.abort(), 30); assert('Worker等待执行时可停止', await pending);
  assert('Worker副本读取遵守文件策略', snapshotFiles(directory, (path) => path.endsWith('input.txt')).length === 1);
} finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
console.log(`W22 worker client: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
