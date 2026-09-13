import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'wp39-'));
Object.assign(process.env, { NODE_ENV: 'test', WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_HOST: '127.0.0.1', WORKPIVOT_INSECURE_SECRETS: '1', WORKPIVOT_EXECUTION_MODE: 'disabled' });
const auth = await import('../packages/server/src/auth.js');
const { withAccount } = await import('../packages/server/src/tenants.js');
const tasks = await import('../packages/server/src/tasks.js');
const { ensureWorkpivotDir } = await import('../packages/server/src/store.js');
const { createApp } = await import('../packages/server/src/app.js');
const admin = auth.registerFirstAdmin('admin', 'admin-password');
const member = auth.createUser('member', 'member-password', 'member');
const token = auth.loginAccount('member', 'member-password').token;
const server = createApp().listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing port');
const base = `http://127.0.0.1:${address.port}/api`;
const request = (path: string, bearer: string | undefined = token, method = 'GET') => fetch(base + path, { method, headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
let count = 0;
function check(value: unknown, label: string): void { assert.ok(value, label); count++; console.log('PASS ' + label); }
try {
  const fixture = withAccount(member, () => {
    const directory = join(tasks.workspaceRoot(), 'shared');
    const task = tasks.createTask({ name: 'delete me', directory, ownerUserId: member.id });
    const peer = tasks.createTask({ name: 'keep me', directory, ownerUserId: member.id });
    const metadata = ensureWorkpivotDir('data', 'tasks', task.id);
    writeFileSync(join(metadata, 'memory.json'), JSON.stringify({ content: 'private task memory' }));
    mkdirSync(join(metadata, 'artifact-versions')); writeFileSync(join(metadata, 'artifact-versions', 'snapshot'), 'old result');
    mkdirSync(join(directory, 'attachments'));
    for (const name of ['owned.txt', 'shared.txt', 'original.txt']) writeFileSync(join(directory, name), name);
    writeFileSync(join(directory, 'attachments', 'old.txt'), 'old attachment');
    writeFileSync(join(directory, 'attachments', 'shared.txt'), 'shared attachment');
    writeFileSync(join(metadata, 'artifacts.json'), JSON.stringify({ produced: ['owned.txt', 'shared.txt', 'original.txt'], baseline: { 'original.txt': {} } }));
    tasks.appendTranscript(task.id, 'user_message', { content: 'test', attachments: ['old.txt', 'shared.txt'] });
    tasks.appendTranscript(peer.id, 'user_message', { content: 'use shared.txt', attachments: ['shared.txt'] });
    return { task, peer, metadata, directory };
  });
  const { task, peer, metadata, directory } = fixture;
  check((await fetch(base + `/tasks/${task.id}`, { method: 'DELETE' })).status === 401, 'unauthenticated deletion denied');
  check((await request(`/tasks/${task.id}`, admin.token, 'DELETE')).status === 404, 'administrator cannot delete another account task');
  check(existsSync(metadata), 'unauthorized request preserves data');
  withAccount(member, () => tasks.updateTaskStatus(task.id, 'running'));
  check((await request(`/tasks/${task.id}`, token, 'DELETE')).status === 409, 'running task protected');
  withAccount(member, () => { tasks.updateTaskStatus(task.id, 'idle'); tasks.updateTaskStatus(peer.id, 'waiting'); });
  check((await request(`/tasks/${task.id}`, token, 'DELETE')).status === 409, 'busy shared workspace protected');
  withAccount(member, () => tasks.updateTaskStatus(peer.id, 'idle'));
  const upload = await fetch(base + `/tasks/${task.id}/attachments?name=unsent.txt`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: 'unsent file' });
  check(upload.ok, 'unsent upload tracked');
  check((await request(`/tasks/${task.id}`, token, 'DELETE')).ok, 'ordinary task deleted');
  check(!existsSync(metadata), 'transcript memory and all artifact snapshots physically removed');
  check(!existsSync(join(directory, 'attachments', 'unsent.txt')), 'unsent upload removed');
  check(!existsSync(join(directory, 'attachments', 'old.txt')), 'legacy sent attachment removed');
  check(!existsSync(join(directory, 'owned.txt')), 'exclusive generated file removed');
  check(existsSync(join(directory, 'shared.txt')) && existsSync(join(directory, 'attachments', 'shared.txt')), 'other task references retained');
  check(existsSync(join(directory, 'original.txt')), 'preexisting project input retained');
  check((await request(`/tasks/${task.id}`)).status === 404, 'deleted task inaccessible');
  check((await request(`/tasks/${peer.id}`)).ok, 'peer task remains accessible');
  check((await request(`/tasks/${task.id}`, token, 'DELETE')).status === 404, 'repeat delete does not touch unrelated files');
  const temp = withAccount(member, () => tasks.createTask({ name: 'temporary', directory: join(tasks.workspaceRoot(), '_temp', 'test'), temp: true, ownerUserId: member.id }));
  writeFileSync(join(temp.directory, 'scratch.txt'), 'temporary process file');
  check((await request(`/tasks/${temp.id}`, token, 'DELETE')).ok, 'temporary task deleted');
  check(!existsSync(temp.directory), 'exclusive temporary workspace removed');
  if (process.platform !== 'win32') {
    const unsafe = withAccount(member, () => {
      const entry = tasks.createTask({ name: 'unsafe', directory: join(tasks.workspaceRoot(), 'unsafe'), ownerUserId: member.id });
      writeFileSync(join(root, 'outside.txt'), 'protected');
      symlinkSync(join(root, 'outside.txt'), join(entry.directory, 'link.txt'));
      writeFileSync(join(ensureWorkpivotDir('data', 'tasks', entry.id), 'artifacts.json'), JSON.stringify({ produced: ['link.txt'], baseline: {} }));
      return entry;
    });
    check((await request(`/tasks/${unsafe.id}`, token, 'DELETE')).status === 409, 'symlink escape deletion rejected');
    check(existsSync(join(root, 'outside.txt')), 'outside file preserved');
  }
  console.log(`W39 ${count}/${count} passed`);
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  rmSync(root, { recursive: true, force: true });
}
