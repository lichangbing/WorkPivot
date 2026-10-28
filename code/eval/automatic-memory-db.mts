import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AccountRepository } from '../packages/server/src/database/accounts.js';
import { installSchema, pool } from '../packages/server/src/database/connection.js';
import { DatabaseMemoryTools } from '../packages/server/src/database/memory-tools.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';

const url = process.env['WORKPIVOT_TEST_PG_URL'];
if (!url || process.env['WORKPIVOT_TEST_PG_DISPOSABLE'] !== '1') throw Error('Requires an explicitly disposable PostgreSQL instance');
const password = randomBytes(24).toString('hex');
const admin = pool(url);
await admin.query(`CREATE ROLE automatic_memory_app LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE automatic_memory_auth LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  CREATE ROLE workpivot_auth NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
const appUrl = new URL(url); appUrl.username = 'automatic_memory_app'; appUrl.password = password;
const authUrl = new URL(url); authUrl.username = 'automatic_memory_auth'; authUrl.password = password;
const business = pool(appUrl.toString(), { max: 2 }), identity = pool(authUrl.toString(), { max: 2 });
try {
  await installSchema(admin, 'automatic_memory_app', 'automatic_memory_auth');
  const owner = await new AccountRepository(identity).registerFirst('automatic-memory', password);
  const workspace = new WorkspaceRepository(business);
  const project = await workspace.createProject(owner.user.id, '记忆召回项目');
  const task = await workspace.createTask(owner.user.id, '记忆召回任务', project.id);
  const otherProject = await workspace.createProject(owner.user.id, '无关项目');
  const otherTask = await workspace.createTask(owner.user.id, '无关任务', otherProject.id);
  const personal = await workspace.createMemory(owner.user.id, '个人偏好：报告固定使用中文。', 'user', project.id);
  const projectMemory = await workspace.createMemory(owner.user.id, '项目口径：库存周转天数每周更新。', 'project', project.id);
  const taskMemory = await workspace.createMemory(owner.user.id, '本任务要求：最终标题使用北辰观察。', 'task', task.id);
  const foreignProject = await workspace.createMemory(owner.user.id, '无关项目口径：禁止读取。', 'project', otherProject.id);
  const foreignTask = await workspace.createMemory(owner.user.id, '无关任务：禁止读取。', 'task', otherTask.id);
  const tools = new DatabaseMemoryTools(business, 'load', ['user', 'project', 'task']);
  const recalled = await tools.automaticContext(owner.user.id, task.id, '这个项目的库存周转天数怎么更新？报告使用中文吗？');
  assert([personal.id, projectMemory.id].every(id => recalled.some(memory => memory.id === id)));
  assert(!recalled.some(memory => [foreignProject.id, foreignTask.id].includes(memory.id)), 'cross-project memory leaked');
  const taskOnly = await new DatabaseMemoryTools(business, 'load', ['task']).automaticContext(owner.user.id, task.id, '库存周转');
  assert(taskOnly.length === 1 && taskOnly[0]!.id === taskMemory.id, 'automatic recall ignored selected scope');
  assert.equal((await new DatabaseMemoryTools(business, 'load', []).automaticContext(owner.user.id, task.id, '库存周转')).length, 0, 'empty scope loaded memory');
  console.log('Automatic memory DB: 5/5 passed');
} finally {
  await Promise.all([business.end(), identity.end(), admin.end()]);
}
