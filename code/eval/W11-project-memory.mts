import { readFileSync } from 'node:fs';
import { join } from 'node:path';
interface Session {
  json: <T>(path: string, init?: RequestInit) => Promise<T>;
  raw: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>;
}
type Assert = (name: string, pass: boolean, detail?: string) => void;
export async function checkProjectMemory(admin: Session, alice: Session, bob: Session, assert: Assert): Promise<void> {
  const a = (await alice.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const b = (await bob.json<{ user: { id: string } }>('/api/auth/state')).user.id;
  const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
  const { project: p } = await admin.json<{ project: { id: string; directory: string } }>('/api/projects', { method: 'POST', body: JSON.stringify({ name: '项目记忆隔离测试' }) });
  const path = `/api/projects/${p.id}`;
  const listed = await alice.json<{ projects: Array<{ id: string }> }>('/api/projects');
  assert('RL1-08 新项目默认不向其他成员开放', !listed.projects.some((v) => v.id === p.id));
  assert('RL1-08 旧默认项目仍可见', listed.projects.some((v) => v.id === 'p-default'));
  assert('RL1-08 非成员记忆不可读', (await bob.raw(path + '/memory')).status === 404);
  assert('RL1-08 非成员不能创建项目任务', (await bob.raw('/api/tasks', { method: 'POST', body: JSON.stringify({ name: '越权', projectId: p.id }) })).status === 404);
  assert('RL1-08 成员不能分配负责人', (await alice.raw(path + '/access', put({ ownerUserId: a, memberUserIds: [b] }))).status === 403);
  assert('RL1-08 拒绝不存在的负责人', (await admin.raw(path + '/access', put({ ownerUserId: 'missing', memberUserIds: [] }))).status === 400);
  await admin.json(path + '/access', put({ ownerUserId: a, memberUserIds: [b] }));
  await alice.json(path + '/memory', put({ content: '项目预算 100 万' }));
  const view = await bob.json<{ content: string; canEdit: boolean }>(path + '/memory');
  assert('RL1-08 成员可读负责人写入的记忆', view.content === '项目预算 100 万' && !view.canEdit);
  assert('RL1-08 成员编辑被拒绝', (await bob.raw(path + '/memory', put({ content: '越权修改' }))).status === 403);
  assert('RL1-08 成员清空被拒绝', (await bob.raw(path + '/memory', { method: 'DELETE' })).status === 403);
  assert('RL1-08 内容长度校验', (await alice.raw(path + '/memory', put({ content: 'a'.repeat(20001) }))).status === 400);
  const { task } = await alice.json<{ task: { id: string } }>('/api/tasks', { method: 'POST', body: JSON.stringify({ name: '负责人任务', projectId: p.id }) });
  const taskView = await alice.json<{ project: string; canEditProject: boolean }>(`/api/memory?taskId=${task.id}`);
  assert('RL1-08 任务记忆使用所属项目', taskView.project === view.content && taskView.canEditProject);
  assert('RL1-08 无任务时不泄露项目记忆', (await alice.json<{ project: string }>('/api/memory')).project === '');
  assert('RL1-08 不存在的任务记忆返回404', (await alice.raw('/api/memory?taskId=missing')).status === 404);
  await admin.json(path + '/access', put({ ownerUserId: b, memberUserIds: [a] }));
  assert('RL1-08 负责人交接后原负责人只读', (await alice.raw(path + '/memory', put({ content: '旧负责人' }))).status === 403);
  await bob.json(path + '/memory', put({ content: '交接后内容' }));
  assert('RL1-08 编辑保留旧内容备份', readFileSync(join(p.directory, '.workpivot/memory/MEMORY.md.bak'), 'utf8') === view.content);
  await bob.json(path + '/memory', { method: 'DELETE' });
  assert('RL1-08 新负责人可清空且保留备份', (await bob.json<{ content: string }>(path + '/memory')).content === '' && readFileSync(join(p.directory, '.workpivot/memory/MEMORY.md.bak'), 'utf8') === '交接后内容');
  await admin.json(path + '/access', put({ ownerUserId: b, memberUserIds: [] }));
  assert('RL1-08 移出项目后原任务不可访问', (await alice.raw(`/api/tasks/${task.id}`)).status === 403);
  assert('RL1-08 移出项目后记忆不可访问', (await alice.raw(`/api/memory?taskId=${task.id}`)).status === 404);
  assert('RL1-08 成员不能改全局记忆开关', (await alice.raw('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled: false }) })).status === 403);
  assert('RL1-08 全局记忆开关拒绝非布尔值', (await admin.raw('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled: 'false' }) })).status === 400);
  await admin.json('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled: true }) });
}
