import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'wp12-'));
const workspace = join(root, 'workspace');
const outside = join(root, 'outside');
const inside = join(workspace, 'inside');
for (const dir of [workspace, outside, inside]) mkdirSync(dir, { recursive: true });
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'trusted-local';
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = workspace;
delete process.env['WORKPIVOT_ALLOW_EXTERNAL_DIRECTORIES'];
const { canonicalPath, pathWithin, requireWithin } = await import('../packages/shared/src/path-guard.js');
const { readTool, writeTool, grepTool, bashTool } = await import('../packages/core/src/tools.js');
const { evaluateAccess, resolvePendingRequest } = await import('../packages/server/src/permissions.js');
const { grantPath, pathIsGranted } = await import('../packages/server/src/permission-grants.js');
const { startServer } = await import('../packages/server/src/index.js');
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
async function rejected(action: () => unknown): Promise<boolean> { try { await action(); return false; } catch { return true; } }
writeFileSync(join(inside, 'safe.txt'), 'SAFE-CONTENT');
writeFileSync(join(outside, 'secret.txt'), 'BOUNDARY-SECRET');
const link = join(inside, 'link');
const server = await startServer({ port: 40012 });
const base = `http://127.0.0.1:${server.port}`;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += String(chunk); });
  req.on('end', () => {
    if (req.method === 'GET') { res.end('{"data":[]}'); return; }
    res.setHeader('content-type', 'text/event-stream');
    const text = body.includes('BOUNDARY-SECRET') ? 'LEAKED' : body.includes('SAFE-CONTENT') ? 'SAFE-READ' : 'NO-LEAK';
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
  });
});
await new Promise<void>((resolve) => mock.listen(40011, '127.0.0.1', resolve));
interface FixtureResponse { token: string; user: { id: string }; project: { id: string }; task: { id: string } }
async function api(path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; data: FixtureResponse }> {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
try {
  assert('RL2-03 正常子路径允许', pathWithin(join(inside, 'safe.txt'), inside));
  assert('RL2-03 相似前缀目录拒绝', !pathWithin(inside + '-other/file', inside));
  assert('RL2-03 点点穿越拒绝', await rejected(() => requireWithin('../../outside/secret.txt', inside)));
  assert('RL2-03 不存在的新文件可解析', pathWithin(canonicalPath('new/sub/file.txt', inside), inside));
  assert('RL2-03 NUL 路径拒绝', await rejected(() => canonicalPath('bad\0file', inside)));
  if (process.platform === 'win32') {
    assert('RL2-03 Windows 大小写一致', canonicalPath(inside.toUpperCase()) === canonicalPath(inside));
    assert('RL2-03 Windows 分隔符一致', canonicalPath(inside.replaceAll('\\', '/')) === canonicalPath(inside));
    assert('RL2-03 NTFS 数据流拒绝', await rejected(() => canonicalPath('safe.txt:stream', inside)));
    assert('RL2-03 盘符相对路径拒绝', await rejected(() => canonicalPath('C:relative', inside)));
  }
  symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert('RL2-03 链接逃逸拒绝', !pathWithin(join(link, 'secret.txt'), inside));
  assert('RL2-03 链接下新文件不能逃逸', await rejected(() => writeTool.run({ path: 'link/new/deep.txt', content: 'bad' }, { taskDir: inside })));
  assert('RL2-03 read 工具拒绝链接逃逸', await rejected(() => readTool.run({ path: 'link/secret.txt' }, { taskDir: inside })));
  assert('RL2-03 grep 不遍历链接目录', !(await grepTool.run({ pattern: 'BOUNDARY' }, { taskDir: inside })).includes('BOUNDARY-SECRET'));
  const admin = (await api('/api/auth/register', '', { username: 'admin', password: 'boundary-test-123' })).data;
  await api('/api/users', admin.token, { username: 'member', password: 'boundary-test-123', role: 'member' });
  const member = (await api('/api/auth/login', '', { username: 'member', password: 'boundary-test-123' })).data;
  const owner = { userId: member.user.id, taskId: 'boundary-grant' };
  let asked = false;
  const decision = await evaluateAccess({ ...owner, taskDir: inside, kind: 'read', tool: 'read', paths: [{ path: 'link/secret.txt', mode: 'read' }] }, (r) => { asked = true; resolvePendingRequest(r.id, 'deny', { ...owner, role: 'member' }); });
  assert('RL2-03 权限引擎识别链接界外并询问', asked && !decision.allowed);
  grantPath(owner, link, 'read', 'session');
  const another = join(root, 'another'); mkdirSync(another);
  // Only unlink the verified fixture junction itself; never recursively delete through a link.
  unlinkSync(link); symlinkSync(another, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert('RL2-03 替换链接不能继承旧授权', !pathIsGranted(owner, link, 'read'));
  unlinkSync(link); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert('RL2-02 成员界外任务目录被拒', (await api('/api/tasks', member.token, { name: 'bad', directory: outside })).status === 400);
  assert('RL2-02 成员不能指定临时任务目录', (await api('/api/tasks', member.token, { name: 'bad', temp: true, directory: inside })).status === 400);
  assert('RL2-02 管理员默认不能指定界外项目', (await api('/api/projects', admin.token, { name: 'bad', directory: outside })).status === 400);
  assert('RL2-02 项目链接越界被拒', (await api('/api/projects', admin.token, { name: 'bad', directory: link })).status === 400);
  assert('RL2-02 非字符串目录被拒', (await api('/api/tasks', member.token, { name: 'bad', directory: {} })).status === 400);
  const project = (await api('/api/projects', admin.token, { name: '项目', directory: inside })).data.project;
  assert('RL2-02 成员不能借目录访问别人的项目', (await api('/api/tasks', member.token, { name: 'bad', directory: inside })).status === 400);
  await api(`/api/projects/${project.id}/access`, admin.token, { ownerUserId: member.user.id, memberUserIds: [] }, 'PUT');
  const taskResult = await api('/api/tasks', member.token, { name: '正常任务', projectId: project.id });
  assert('RL2-02 项目成员正常建任务', taskResult.status === 200);
  const task = taskResult.data.task;
  await api('/api/providers', admin.token, { name: 'mock', baseUrl: 'http://127.0.0.1:40011/v1', modelId: 'mock' });
  const turn = async (content: string): Promise<string> => (await fetch(`${base}/api/tasks/${task.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${member.token}` }, body: JSON.stringify({ content }), signal: AbortSignal.timeout(10000) })).text();
  assert('RL2-03 正常文件引用仍送入模型', (await turn('@safe.txt')).includes('SAFE-READ'));
  const leaked = await turn('@link/secret.txt @../../outside/secret.txt');
  assert('RL2-03 链接及点点文件引用不泄露给模型', !leaked.includes('LEAKED'));
  const transcript = (await api(`/api/tasks/${task.id}/transcript`, member.token)).data;
  assert('RL2-03 转写不落盘越界文件内容', !JSON.stringify(transcript).includes('BOUNDARY-SECRET'));
  symlinkSync(outside, join(inside, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir');
  const upload = await fetch(`${base}/api/tasks/${task.id}/attachments?name=upload.txt`, { method: 'POST', headers: { authorization: `Bearer ${member.token}`, 'content-type': 'application/octet-stream' }, body: 'bad' });
  assert('RL2-03 附件目录链接逃逸被拒', upload.status === 400 && !existsSync(join(outside, 'upload.txt')));
  process.env['WORKPIVOT_TEST_SECRET'] = 'do-not-inherit';
  process.env['NODE_OPTIONS'] = '--trace-warnings';
  writeFileSync(join(inside, 'env.cjs'), 'console.log(JSON.stringify({secret:process.env.WORKPIVOT_TEST_SECRET,options:process.env.NODE_OPTIONS,path:!!process.env.PATH,nodePath:process.env.NODE_PATH}))');
  const envResult = await bashTool.run({ command: 'node env.cjs' }, { taskDir: inside, extraEnv: { NODE_PATH: 'bundled-libraries', OTHER_SECRET: 'blocked' } });
  assert('RL2-04 命令环境不继承应用密钥或 NODE_OPTIONS', envResult.includes('exit=0') && !envResult.includes('do-not-inherit') && !envResult.includes('trace-warnings'));
  assert('RL2-04 命令保留 PATH 与显式文档库路径', envResult.includes('"path":true') && envResult.includes('bundled-libraries'));
  await writeTool.run({ path: 'new/sub/output.txt', content: 'ok' }, { taskDir: inside });
  assert('RL2-03 普通嵌套写入仍正常', readFileSync(join(inside, 'new/sub/output.txt'), 'utf8') === 'ok');
} catch (err) { console.error(err); assert('执行无未捕获异常', false); }
finally {
  await server.close(); await new Promise<void>((resolve) => mock.close(() => resolve()));
  for (const fixtureLink of [link, join(inside, 'attachments')]) { try { unlinkSync(fixtureLink); } catch { /* May not have been created. */ } }
  // root is the sole mkdtemp fixture created above, all junctions removed first.
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n===== W12 冒烟：${results.filter(Boolean).length}/${results.length} 通过 =====`);
process.exit(results.every(Boolean) ? 0 : 1);
