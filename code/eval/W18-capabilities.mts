import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executionMode } from '../packages/server/src/execution-policy.js';

const root = mkdtempSync(join(tmpdir(), 'wp18-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'disabled';
delete process.env['WORKPIVOT_SECRET_KEY'];
delete process.env['WORKPIVOT_ADMIN_INIT_TOKEN'];
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
assert('能力默认关闭命令执行', executionMode({}) === 'disabled');
assert('能力未知配置不能开启执行', executionMode({ WORKPIVOT_EXECUTION_MODE: 'typo' }) === 'disabled');
assert('能力生产禁止本机执行降级', executionMode({ NODE_ENV: 'production', WORKPIVOT_EXECUTION_MODE: 'trusted-local' }) === 'disabled');
assert('能力开发允许显式本机执行', executionMode({ NODE_ENV: 'test', WORKPIVOT_EXECUTION_MODE: 'trusted-local' }) === 'trusted-local');
assert('能力隔离执行须显式开启', executionMode({ NODE_ENV: 'production', WORKPIVOT_EXECUTION_MODE: 'docker' }) === 'docker');
let turns = 0, noCommands = true, hasFiles = true, hasSkillLoader = true, honestPrompt = false;
const mock = createServer((req, res) => {
  let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => {
    if (req.method === 'GET') { res.end('{"data":[]}'); return; }
    const body = JSON.parse(raw);
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
    noCommands &&= !names.includes('bash');
    hasFiles &&= ['read', 'write', 'ls'].every((name) => names.includes(name));
    hasSkillLoader &&= names.includes('load_skill');
    honestPrompt ||= body.messages[0].content.includes('后台未启用脚本和命令执行');
    turns++;
    const call = turns === 1 ? { name: 'bash', arguments: JSON.stringify({ command: 'echo unsafe > executed.txt' }) }
      : { name: 'write', arguments: JSON.stringify({ path: 'result.txt', content: 'file-tools-still-work' }) };
    const delta = turns <= 2 ? { tool_calls: [{ index: 0, id: `c${turns}`, function: call }] } : { content: '文件处理完成。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise<void>((resolve) => mock.listen(40041, '127.0.0.1', resolve));
const { startServer } = await import('../packages/server/src/index.js');
const server = await startServer({ port: 40042 });
let token = '';
const api = async (path: string, body?: unknown) => {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
  return response;
};
try {
  token = (await (await api('/api/auth/register', { username: 'admin', password: 'capability-fixture' })).json()).token;
  await api('/api/providers', { name: 'fixture', baseUrl: 'http://127.0.0.1:40041/v1', modelId: 'fixture' });
  const { task } = await (await api('/api/tasks', { name: 'capability-fixture' })).json();
  const stream = await (await api(`/api/tasks/${task.id}/messages`, { content: '测试文件处理' })).text();
  assert('能力服务层不向模型提供命令工具', noCommands);
  assert('能力服务层保留文件工具', hasFiles);
  assert('能力服务层提供Skill加载工具', hasSkillLoader);
  assert('能力提示明确说明脚本限制', honestPrompt);
  assert('能力模型伪造命令调用不会执行', !existsSync(join(task.directory, 'executed.txt')));
  assert('能力禁用命令后仍可写入文件', readFileSync(join(task.directory, 'result.txt'), 'utf8') === 'file-tools-still-work');
  assert('能力任务正常结束', stream.includes('"type":"done"'));
  const detail = await (await api(`/api/tasks/${task.id}`)).json();
  assert('能力任务历史保存', detail.history.some((item: { role: string }) => item.role === 'assistant'));
} finally {
  await server.close(); await new Promise<void>((resolve) => mock.close(() => resolve())); rmSync(root, { recursive: true, force: true });
}
console.log(`W18 capabilities: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
