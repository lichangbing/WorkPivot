/**
 * R007 元数据内存视图：chat 模式下 tasks.ts 的同步 API 从视图读，PG 仍是真值。
 * 纯逻辑测试，不连库；用临时 WORKPIVOT_HOME 隔离真实数据。
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'wp-task-cache-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = join(home, 'workspace');
delete process.env['WORKPIVOT_CHAT_DATABASE_URL'];

const { clearTaskCache, setTaskCache, taskCacheReady, uncacheTask } = await import('../packages/server/src/task-cache.js');
const { getTask, listTasks } = await import('../packages/server/src/tasks.js');

let checks = 0;
function check(label: string, run: () => void): void {
  run();
  checks += 1;
  console.log('✅', label);
}

try {
  clearTaskCache();
  assert.equal(taskCacheReady(), false);

  check('未预载时回落 JSONL（临时目录为空）', () => {
    assert.equal(getTask('missing'), null);
    assert.deepEqual(listTasks(), []);
  });

  check('预载后 getTask/listTasks 从视图读，按创建时间倒序', () => {
    setTaskCache([
      { id: 't-1', name: '旧任务', directory: '/tmp/a', status: 'idle', createdAt: '2026-10-01T00:00:00.000Z', temp: false },
      { id: 't-2', name: '新任务', directory: '/tmp/b', status: 'running', createdAt: '2026-10-24T00:00:00.000Z', temp: true },
    ]);
    assert.equal(taskCacheReady(), true);
    assert.equal(getTask('t-1')?.name, '旧任务');
    assert.equal(getTask('t-2')?.status, 'running');
    assert.deepEqual(listTasks().map((task) => task.id), ['t-2', 't-1']);
  });

  check('非法 id 直接返回 null，不查视图', () => {
    assert.equal(getTask('../etc/passwd'), null);
  });

  check('移除后不可见，清空视图后回落文件', () => {
    uncacheTask('t-1');
    assert.equal(getTask('t-1'), null);
    assert.equal(taskCacheReady(), true);
    clearTaskCache();
    assert.equal(taskCacheReady(), false);
    assert.equal(getTask('t-2'), null);
  });
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log(`\n任务元数据视图：${checks} 项通过`);
