import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'wp13-'));
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'trusted-local';
process.env['WORKPIVOT_HOME'] = join(root, 'home');
process.env['WORKPIVOT_WORKSPACE'] = join(root, 'workspace');
process.env['WORKPIVOT_SESSION_TTL_HOURS'] = '24';
const { startServer } = await import('../packages/server/src/index.js');
const { readJsonSafe, writeAtomicWithBackup } = await import('../packages/server/src/store.js');
const { needsSetup } = await import('../packages/server/src/auth.js');
const { createAesBox, initializeSecretBox } = await import('../packages/server/src/secret.js');
const { migrateProviderSecrets } = await import('../packages/server/src/providers.js');
const server = await startServer({ port: 40022 });
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
async function rejected(action: () => unknown): Promise<boolean> { try { await action(); return false; } catch { return true; } }
interface FixtureResponse { token: string; user: { id: string }; authenticated: boolean; needsSetup: boolean }
async function api(path: string, token = '', body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; data: FixtureResponse }> {
  const res = await fetch(`http://127.0.0.1:${server.port}` + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}
try {
  const fallback = { users: [] as string[] };
  readJsonSafe(join(root, 'never-created.json'), fallback).value.users.push('not-persistent');
  assert('RL3-03 缺失文件返回独立默认值', fallback.users.length === 0);
  const path = join(root, 'fixture.json');
  writeAtomicWithBackup(path, '{"value":1}'); writeAtomicWithBackup(path, '{"value":2}');
  assert('RL3-03 正常读取来源为 primary', readJsonSafe(path, {}).source === 'primary');
  writeFileSync(path, '{broken');
  assert('RL3-03 主文件损坏后使用有效备份', readJsonSafe<{ value: number }>(path, { value: 0 }).value.value === 1);
  assert('RL3-03 恢复内容写回主文件且损坏原件保留', JSON.parse(readFileSync(path, 'utf8')).value === 1 && existsSync(path + '.corrupt'));
  writeFileSync(path, '{broken'); writeFileSync(path + '.bak', '{also broken');
  assert('RL3-03 双损坏明确报错', await rejected(() => readJsonSafe(path, {})));
  assert('RL3-03 再次读取仍报错不归零', await rejected(() => readJsonSafe(path, {})));
  process.env['WORKPIVOT_HOST'] = '0.0.0.0';
  delete process.env['WORKPIVOT_ADMIN_INIT_TOKEN'];
  const adminResponse = await api('/api/auth/register', '', { username: 'admin', password: 'session-test-123' });
  assert('RL3-02 首个注册账户免初始化凭据成为管理员', adminResponse.status === 200 && adminResponse.data.user.role === 'admin');
  const secondResponse = await api('/api/auth/register', '', { username: 'second', password: 'session-test-123' });
  assert('RL3-02 后续自助注册为普通成员', secondResponse.status === 200 && secondResponse.data.user.role === 'member');
  const admin = adminResponse.data;
  process.env['WORKPIVOT_HOST'] = '127.0.0.1';
  const memberId = (await api('/api/users', admin.token, { username: 'member', password: 'session-test-123', role: 'member' })).data.user.id;
  const signin = async (password = 'session-test-123') => (await api('/api/auth/login', '', { username: 'member', password })).data.token;
  const a = await signin(); const b = await signin();
  await api('/api/auth/logout', a, {});
  assert('RL3-01 退出后旧令牌失效', (await api('/api/tasks', a)).status === 401);
  assert('RL3-01 退出仅撤销当前会话', (await api('/api/tasks', b)).status === 200);
  assert('RL3-01 成员不能撤销其他账户', (await api(`/api/users/${admin.user.id}/sessions`, b, undefined, 'DELETE')).status === 403);
  const changed = await api('/api/auth/password', b, { currentPassword: 'session-test-123', newPassword: 'session-new-123' });
  assert('RL3-01 修改密码成功', changed.status === 200);
  assert('RL3-01 改密使当前及其他旧令牌失效', (await api('/api/tasks', b)).status === 401 && (await api('/api/tasks', a)).status === 401);
  const c = await signin('session-new-123');
  assert('RL3-01 新密码可登录', (await api('/api/tasks', c)).status === 200);
  await api(`/api/users/${memberId}/sessions`, admin.token, undefined, 'DELETE');
  assert('RL3-01 管理员可撤销指定用户会话', (await api('/api/tasks', c)).status === 401);
  assert('RL3-01 撤销成员不影响管理员', (await api('/api/tasks', admin.token)).status === 200);
  const d = await signin('session-new-123');
  const sessionsPath = join(root, 'home/data/sessions.json');
  const sessions = JSON.parse(readFileSync(sessionsPath, 'utf8')) as { version: number; tokens: Array<{ token: string; expiresAt?: string; createdAt: string }> };
  const entry = sessions.tokens.find((v) => v.token === d)!;
  assert('RL3-01 默认会话有效期24小时', Date.parse(entry.expiresAt!) - Date.parse(entry.createdAt) === 86400000);
  entry.expiresAt = new Date(Date.now() - 1000).toISOString();
  sessions.tokens.push({ token: 'legacy-no-expiry', createdAt: new Date().toISOString() });
  writeFileSync(sessionsPath, JSON.stringify(sessions));
  assert('RL3-01 到期令牌被拒绝', (await api('/api/tasks', d)).status === 401);
  assert('RL3-01 旧版无期限会话需要重新登录', (await api('/api/tasks', 'legacy-no-expiry')).status === 401);
  assert('RL3-01 过期会话已从存储清理', !readFileSync(sessionsPath, 'utf8').includes(d));
  let throttled = false;
  for (let i = 0; i < 11; i++) { if ((await api('/api/auth/login', '', { username: 'rate-fixture', password: 'wrong' })).status === 429) throttled = true; }
  assert('RL3-02 重复登录尝试被限速', throttled);
  assert('RL3-02 限速不锁定其他账户', (await api('/api/auth/login', '', { username: 'admin', password: 'session-test-123' })).status === 200);
  const key = 'ab'.repeat(32);
  const aes = createAesBox(key);
  const encrypted = aes.encrypt('fixture-api-secret');
  assert('RL3-04 AES密文可正确解密', aes.decrypt(encrypted) === 'fixture-api-secret');
  assert('RL3-04 同内容每次密文不同', aes.encrypt('fixture-api-secret').data !== encrypted.data);
  const bytes = Buffer.from(encrypted.data, 'base64'); bytes[12] = bytes[12]! ^ 1;
  assert('RL3-04 密文篡改被拒绝', await rejected(() => aes.decrypt({ ...encrypted, data: bytes.toString('base64') })));
  assert('RL3-04 错误主密钥无法解密', await rejected(() => createAesBox('cd'.repeat(32)).decrypt(encrypted)));
  delete process.env['WORKPIVOT_SECRET_KEY']; delete process.env['WORKPIVOT_INSECURE_SECRETS'];
  assert('RL3-04 缺主密钥拒绝启动', await rejected(() => startServer({ port: 40023 })));
  process.env['WORKPIVOT_SECRET_KEY'] = key; initializeSecretBox();
  const providerPath = join(root, 'home/config/providers.json');
  const legacy = JSON.stringify({ version: 1, providers: [{ id: 'legacy', apiKey: { enc: 'b64', data: Buffer.from('fixture-api-secret').toString('base64') } }] });
  writeFileSync(providerPath, legacy); writeFileSync(providerPath + '.bak', legacy);
  migrateProviderSecrets();
  assert('RL3-04 主文件和备份均迁移为加密密文', [providerPath, providerPath + '.bak'].every((p) => {
    const text = readFileSync(p, 'utf8');
    return text.includes('aes-256-gcm') && !text.includes(Buffer.from('fixture-api-secret').toString('base64')) && aes.decrypt(JSON.parse(text).providers[0].apiKey) === 'fixture-api-secret';
  }));
  const usersPath = join(root, 'home/data/users.json');
  const goodUsers = readFileSync(usersPath, 'utf8');
  writeFileSync(usersPath + '.bak', goodUsers); writeFileSync(usersPath, 'broken');
  assert('RL3-03 账户主文件损坏恢复后不重开注册', !needsSetup());
  writeFileSync(usersPath, '{"version":1,"users":[]}'); writeFileSync(usersPath + '.bak', 'broken');
  assert('RL3-03 空账户文件不能重新初始化', await rejected(() => needsSetup()));
  assert('RL3-03 状态接口明确报告数据故障', (await api('/api/auth/state')).status === 503);
  assert('RL3-03 损坏时无法抢注管理员', (await api('/api/auth/register', '', { username: 'attacker', password: 'session-test-123' })).status !== 200);
  assert('RL3-03 账户损坏拒绝服务启动', await rejected(() => startServer({ port: 40023 })));
} catch (err) { console.error(err); assert('执行无未捕获异常', false); }
finally { await server.close(); rmSync(root, { recursive: true, force: true }); }
console.log(`\n===== W13 冒烟：${results.filter(Boolean).length}/${results.length} 通过 =====`);
process.exit(results.every(Boolean) ? 0 : 1);
