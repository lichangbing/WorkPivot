// 在隔离后端测试容器中连接宿主执行器运行，详见 W23-host.mjs。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'wp23-'));
process.env['WORKPIVOT_HOME'] = join(root, 'home'); process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_EXECUTION_MODE'] = 'worker'; process.env['WORKPIVOT_INSECURE_SECRETS'] = '1'; delete process.env['WORKPIVOT_SECRET_KEY']; delete process.env['WORKPIVOT_ADMIN_INIT_TOKEN'];
const skillDir = join(root, 'home/skills/script-test'); mkdirSync(skillDir, { recursive: true });
writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: script-test\ndescription: 测试脚本执行\n---\n运行 /skills/script-test/run.py，生成result.bin。');
writeFileSync(join(skillDir, 'run.py'), "from pathlib import Path\nPath('result.bin').write_bytes(Path('/skills/script-test/template.bin').read_bytes())\nprint('SKILL_SCRIPT_OK')\n");
writeFileSync(join(skillDir, 'template.bin'), Buffer.from([0, 4, 8, 255]));
let turn = 0;
const mock = createServer((req, res) => { req.resume(); req.on('end', () => {
  if (req.method === 'GET') { res.end('{"data":[]}'); return; }
  const calls = [{ name: 'load_skill', arguments: JSON.stringify({ name: 'script-test' }) }, { name: 'bash', arguments: JSON.stringify({ command: 'python3 /skills/script-test/run.py' }) }];
  const call = calls[turn++]; const delta = call ? { tool_calls: [{ index: 0, id: `call-${turn}`, function: call }] } : { content: '脚本执行成功。' };
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
}); });
await new Promise<void>((resolve) => mock.listen(40071, '127.0.0.1', resolve));
const { startServer } = await import('../packages/server/src/index.js');
const { setTier } = await import('../packages/server/src/permissions.js');
const backend = await startServer({ port: 40072 }); let token = '';
const api = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${backend.port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(45000) });
const results: boolean[] = [];
const assert = (name: string, pass: boolean) => { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); };
try {
  token = (await (await api('/api/auth/register', { username: 'admin', password: 'synthetic-skill-test' })).json()).token;
  setTier('auto'); // 只修改合成账号，不修改已部署用户的设置。
  await api('/api/providers', { name: 'test', baseUrl: 'http://127.0.0.1:40071/v1', modelId: 'test' });
  const { task } = await (await api('/api/tasks', { name: 'Skill执行验收' })).json();
  const stream = await (await api(`/api/tasks/${task.id}/messages`, { content: '执行测试技能' })).text();
  assert('Skill服务链实际调用加载工具', stream.includes('"toolName":"load_skill"'));
  assert('Skill服务链脚本由隔离执行返回', stream.includes('SKILL_SCRIPT_OK'));
  assert('Skill服务链二进制模板成功回写', readFileSync(join(task.directory, 'result.bin')).equals(Buffer.from([0, 4, 8, 255])));
  assert('Skill服务链任务正常完成', stream.includes('"stopReason":"completed"'));
  assert('Skill服务链结果可列出下载', (await (await api(`/api/tasks/${task.id}/files`)).json()).files.includes('result.bin'));
} finally { await backend.close(); await new Promise<void>((resolve) => mock.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
console.log(`W23 skill service: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
