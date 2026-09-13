// Disposable manual UI fixture; no production accounts or volumes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'wp-delete-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', WORKPIVOT_HOME: join(root, 'home'), WORKPIVOT_WORKSPACE: join(root, 'workspace'), WORKPIVOT_INSECURE_SECRETS: '1', WORKPIVOT_EXECUTION_MODE: 'disabled', WORKPIVOT_HOST: '127.0.0.1' });
const { registerFirstAdmin } = await import('../packages/server/src/auth.js');
const { withAccount } = await import('../packages/server/src/tenants.js');
const { createProject } = await import('../packages/server/src/projects.js');
const { createTask, appendTranscript } = await import('../packages/server/src/tasks.js');
const { createApp } = await import('../packages/server/src/app.js');
const { user } = registerFirstAdmin('delete-test', 'temporary-delete-test');
withAccount(user, () => {
  const project = createProject('删除功能验收', undefined, user.id);
  for (const name of ['待删除任务', '保留任务']) {
    const task = createTask({ name, directory: project.directory, projectId: project.id, ownerUserId: user.id });
    appendTranscript(task.id, 'user_message', { content: '这是独立测试数据' });
  }
});
const server = createApp({ webDistDir: resolve('apps/web/dist') }).listen(39986, '127.0.0.1', () => console.log('UI fixture http://127.0.0.1:39986'));
const cleanup = () => { server.close(); rmSync(root, { recursive: true, force: true }); process.exit(); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup);
