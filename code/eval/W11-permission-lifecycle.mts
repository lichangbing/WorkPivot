/** W11 的授权作用域/等待生命周期回归；只用调用者提供的临时 home/workspace。 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAccess, resolvePendingRequest, type EvaluateInput, type Decision } from '../packages/server/src/permissions.js';
import { clearSessionGrants, listPathGrants } from '../packages/server/src/permission-grants.js';

interface Session {
  json: <T>(path: string, init?: RequestInit) => Promise<T>;
  raw: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
}
type Assert = (name: string, pass: boolean, detail?: string) => void;

export async function checkPermissionLifecycle(home: string, workspace: string, alice: Session, bob: Session, admin: Session, assert: Assert): Promise<void> {
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });
  await bob.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });
  const a = (await alice.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const b = (await bob.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const outside = join(workspace, 'outside-grants');
  mkdirSync(outside, { recursive: true });
  const input: EvaluateInput = { userId: a, taskId: 'grants-a', taskDir: join(workspace, 'inside'), tool: 'read', kind: 'read', paths: [{ path: outside, mode: 'read' }] };
  const check = async (request: EvaluateInput, decision: Decision = 'deny') => {
    let asked = 0;
    const result = await evaluateAccess(request, (event) => {
      asked++;
      const status = resolvePendingRequest(event.id, decision, { ...request, role: 'member' });
      if (status !== 'resolved') throw new Error(`测试回填失败 ${status}`);
    });
    return { ...result, asked };
  };
  writeFileSync(join(home, 'config', 'permissions.json'), JSON.stringify({ version: 1, allowDirs: [outside] }));
  assert('RL1-06 旧全局白名单不自动继承', (await check(input)).asked === 1);
  assert('RL1-06 once 当次放行', (await check(input, 'allow')).allowed);
  assert('RL1-06 once 下一次仍询问', (await check(input)).asked === 1);
  assert('RL1-06 session 当次放行', (await check(input, 'session')).allowed);
  assert('RL1-06 同用户同任务 session 复用', (await check(input)).asked === 0);
  assert('RL1-06 授权目录的子路径可读', (await check({ ...input, paths: [{ path: join(outside, 'child.txt'), mode: 'read' }] })).asked === 0);
  assert('RL1-06 相似前缀目录不放行', (await check({ ...input, paths: [{ path: outside + '-other', mode: 'read' }] })).asked === 1);
  assert('RL1-06 其他用户不继承 session', (await check({ ...input, userId: b })).asked === 1);
  assert('RL1-06 其他任务不继承 session', (await check({ ...input, taskId: 'grants-a2' })).asked === 1);
  const write: EvaluateInput = { ...input, tool: 'write', kind: 'write', paths: [{ path: outside, mode: 'write' }] };
  assert('RL1-06 读取授权不能升级写入', (await check(write)).asked === 1);
  clearSessionGrants(input.taskId);
  assert('RL1-06 清理会话后重新询问', (await check(input)).asked === 1);
  assert('RL1-06 forever 当次放行', (await check(input, 'forever')).allowed);
  clearSessionGrants(input.taskId);
  assert('RL1-06 forever 不依赖内存会话', (await check(input)).asked === 0 && listPathGrants().length === 1);
  assert('RL1-06 forever 不跨用户', (await check({ ...input, userId: b })).asked === 1);
  assert('RL1-06 forever 不跨任务', (await check({ ...input, taskId: 'grants-a2' })).asked === 1);
  assert('RL1-06 forever 读授权不含写入', (await check(write)).asked === 1);
  assert('RL1-06 写入永久授权可保存', (await check(write, 'forever')).allowed);
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'readonly' }) });
  assert('RL1-06 readonly 不被已有写白名单提权', !(await check(write)).allowed);
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'ask' }) });
  assert('RL1-06 ask 写入始终重新确认', (await check(write)).asked === 1);
  await alice.json('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier: 'workdir' }) });
  assert('RL1-06 member 不能查看全员白名单', (await alice.raw('/api/permissions/allowdirs')).status === 403);
  const listed = await admin.json<{ grants: Array<{ id: string }> }>('/api/permissions/allowdirs');
  assert('RL1-06 admin 可查看永久授权', listed.grants.length === 2);
  const grantId = listed.grants[0]!.id;
  assert('RL1-06 member 不能撤销全员授权', (await bob.raw(`/api/permissions/allowdirs/${grantId}`, { method: 'DELETE' })).status === 403);
  assert('RL1-06 admin 可撤销永久授权', (await admin.raw(`/api/permissions/allowdirs/${grantId}`, { method: 'DELETE' })).status === 200);
  assert('RL1-06 撤销立即影响后续读取', (await check(input)).asked === 1);
  assert('RL1-06 已删除授权重复撤销 404', (await admin.raw(`/api/permissions/allowdirs/${grantId}`, { method: 'DELETE' })).status === 404);

  const bad = { ...listPathGrants()[0]!, path: '*' };
  writeFileSync(join(home, 'config', 'permissions.json'), JSON.stringify({ version: 2, grants: [bad, { ...bad, path: null }, { path: outside }, null] }));
  assert('RL1-06 非法或通配授权不会退化为放行', (await check(input)).asked === 1 && listPathGrants().length === 0);

  const controller = new AbortController();
  let requestId = '';
  const waiting = evaluateAccess({ ...input, signal: controller.signal }, (event) => { requestId = event.id; });
  controller.abort();
  assert('RL1-07 中止唤醒授权等待并拒绝', !(await waiting).allowed);
  assert('RL1-07 中止后 pending 已清理', resolvePendingRequest(requestId, 'allow', { ...input, role: 'member' }) === 'not-found');
  let preAbortedAsked = false;
  assert('RL1-07 已中止信号不创建请求', !(await evaluateAccess({ ...input, signal: controller.signal }, () => { preAbortedAsked = true; })).allowed && !preAbortedAsked);
  let reason = '';
  const timed = await evaluateAccess({ ...input, timeoutMs: 20, onSettled: (_id, _decision, why) => { reason = why; } }, (event) => { requestId = event.id; });
  assert('RL1-07 超时自动拒绝且回报原因', !timed.allowed && reason === 'timeout');
  assert('RL1-07 超时请求无法迟到批准', resolvePendingRequest(requestId, 'allow', { ...input, role: 'member' }) === 'not-found');
  const race = new AbortController();
  const raceResult = await evaluateAccess({ ...input, signal: race.signal }, (event) => {
    resolvePendingRequest(event.id, 'allow', { ...input, role: 'member' });
    race.abort();
  });
  assert('RL1-07 批准后同时停止不会继续执行', !raceResult.allowed);
  assert('RL1-07 授权卡发送失败不会悬挂', !(await evaluateAccess(input, () => { throw new Error('断流'); })).allowed);
}
