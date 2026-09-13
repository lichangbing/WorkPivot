import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'wp40-'));
Object.assign(process.env, { NODE_ENV: 'test', WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_HOST: '127.0.0.1', WORKPIVOT_INSECURE_SECRETS: '1', WORKPIVOT_EXECUTION_MODE: 'disabled' });
const auth = await import('../packages/server/src/auth.js');
const { withAccount } = await import('../packages/server/src/tenants.js');
const tasks = await import('../packages/server/src/tasks.js');
const projects = await import('../packages/server/src/projects.js');
const { ensureWorkpivotDir } = await import('../packages/server/src/store.js');
const { createApp } = await import('../packages/server/src/app.js');
const admin = auth.registerFirstAdmin('admin', 'admin-password');
const member = auth.createUser('member', 'member-password', 'member');
const token = auth.loginAccount('member', 'member-password').token;
const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
const base = `http://127.0.0.1:${address.port}/api`;
const request = (id: string, bearer = token) => fetch(base + `/projects/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${bearer}` } });
let count = 0;
function check(value: unknown, label: string): void { assert.ok(value, label); count++; console.log('PASS ' + label); }
try {
  const fixture = withAccount(member, () => {
    projects.ensureDefaultProject();
    const project = projects.createProject('delete project', undefined, member.id);
    const entries = ['first', 'second'].map(name => tasks.createTask({ name, directory: project.directory, projectId: project.id, ownerUserId: member.id }));
    const taskDirs = entries.map(task => ensureWorkpivotDir('data', 'tasks', task.id));
    for (const task of entries) tasks.appendTranscript(task.id, 'user_message', { content: 'private conversation' });
    mkdirSync(join(project.directory, '.workpivot', 'memory'), { recursive: true });
    writeFileSync(join(project.directory, '.workpivot', 'memory', 'MEMORY.md'), 'project memory');
    writeFileSync(join(project.directory, 'draft.txt'), 'unregistered process file');
    const keep = projects.createProject('keep project', undefined, member.id);
    const keptTask = tasks.createTask({ name: 'keep', directory: keep.directory, projectId: keep.id, ownerUserId: member.id });
    return { project, entries, taskDirs, keep, keptTask, metadata: ensureWorkpivotDir('data', 'projects', project.id) };
  });
  const { project, entries, taskDirs, keep, keptTask, metadata } = fixture;
  check((await fetch(base + `/projects/${project.id}`, { method: 'DELETE' })).status === 401, 'guest denied');
  check((await request(project.id, admin.token)).status === 404, 'admin cannot delete another user project');
  withAccount(member, () => tasks.updateTaskStatus(entries[1]!.id, 'running'));
  check((await request(project.id)).status === 409, 'running child blocks whole deletion');
  check(taskDirs.every(path => existsSync(path)), 'no child deleted before busy validation');
  withAccount(member, () => tasks.updateTaskStatus(entries[1]!.id, 'idle'));
  const response = await request(project.id);
  check(response.ok, 'project with tasks deleted');
  const body = await response.json() as { taskIds: string[] };
  check(body.taskIds.length === 2, 'deleted task ids returned for client cleanup');
  check(!existsSync(metadata) && taskDirs.every(path => !existsSync(path)), 'project and task metadata physically removed');
  check(!existsSync(project.directory), 'workspace and project memory physically removed');
  check((await request(project.id)).status === 404, 'repeat delete safe');
  check(withAccount(member, () => Boolean(projects.getProject(keep.id) && tasks.getTask(keptTask.id))), 'unrelated project preserved');
  check((await request(projects.DEFAULT_PROJECT_ID)).status === 409, 'account root default project protected');
  const shared = withAccount(member, () => projects.createProject('shared', keep.directory, member.id));
  check((await request(shared.id)).status === 409 && existsSync(keep.directory), 'shared directory rejected');
  const empty = withAccount(member, () => projects.createProject('empty', undefined, member.id));
  check((await request(empty.id)).ok, 'never opened empty project deleted');
  if (process.platform !== 'win32') {
    const linked = withAccount(member, () => {
      const p = projects.createProject('linked', undefined, member.id);
      mkdirSync(p.directory, { recursive: true });
      symlinkSync(keep.directory, join(p.directory, 'shared-link'));
      return p;
    });
    check((await request(linked.id)).ok && existsSync(keep.directory), 'nested symlink removed without following target');
  }
  const outside = withAccount(member, () => projects.createProject('outside', root, member.id));
  check((await request(outside.id)).status === 409 && existsSync(root), 'outside workspace rejected');
  console.log(`W40 ${count}/${count} passed`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
