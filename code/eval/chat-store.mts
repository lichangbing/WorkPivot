/**
 * R007 chat schema 映射与开关验收（纯逻辑，不连库）。
 * 真实建表与读写由 `pnpm chat:install` + 部署验收覆盖。
 */
import assert from 'node:assert/strict';
import {
  chatDatabaseUrl,
  chatEnabled,
  chatPool,
  taskFromRow,
  transcriptRowFromMessage,
  type ChatMessageRow,
  type ChatTaskRow,
} from '../packages/server/src/chat-store.js';

let checks = 0;
function check(label: string, run: () => void): void {
  run();
  checks += 1;
  console.log('✅', label);
}

check('未配置时关闭整层，不创建连接池', () => {
  const previous = process.env['WORKPIVOT_CHAT_DATABASE_URL'];
  delete process.env['WORKPIVOT_CHAT_DATABASE_URL'];
  assert.equal(chatEnabled(), false);
  assert.equal(chatDatabaseUrl(), undefined);
  assert.throws(() => chatPool(), /未配置 WORKPIVOT_CHAT_DATABASE_URL/);
  process.env['WORKPIVOT_CHAT_DATABASE_URL'] = '   ';
  assert.equal(chatEnabled(), false, '空白串视为未配置');
  if (previous === undefined) delete process.env['WORKPIVOT_CHAT_DATABASE_URL'];
  else process.env['WORKPIVOT_CHAT_DATABASE_URL'] = previous;
});

check('任务行映射：可空字段不输出，时间转 ISO', () => {
  const row: ChatTaskRow = {
    id: 'task-1', owner_user_id: 'user-1', tenant_id: null, name: '周报', directory: '/data/tasks/task-1',
    status: 'idle', stop_reason: null, project_id: null, temp: false, last_seq: '12',
    created_at: new Date('2026-10-24T03:00:00Z'), updated_at: new Date('2026-10-24T03:00:00Z'),
  };
  const task = taskFromRow(row);
  assert.equal(task.id, 'task-1');
  assert.equal(task.directory, '/data/tasks/task-1');
  assert.equal(task.createdAt, '2026-10-24T03:00:00.000Z');
  assert.equal(task.ownerUserId, 'user-1');
  assert.ok(!('stopReason' in task));
  assert.ok(!('projectId' in task));
  assert.ok(!('tenantId' in task));
});

check('消息行映射：seq → ordinal，uuid/parentUuid 保留链关系', () => {
  const row: ChatMessageRow = {
    id: '6f1c2d3e-0000-4000-8000-000000000001', task_id: 'task-1', seq: '7', kind: 'tool_result',
    payload: { ok: true }, parent_id: '6f1c2d3e-0000-4000-8000-000000000000',
    created_at: new Date('2026-10-24T03:00:01Z'),
  };
  const transcript = transcriptRowFromMessage(row);
  assert.equal(transcript.ordinal, 7);
  assert.equal(transcript.kind, 'tool_result');
  assert.equal(transcript.ts, '2026-10-24T03:00:01.000Z');
  assert.equal(transcript.uuid, row.id);
  assert.equal(transcript.parentUuid, row.parent_id);
  assert.deepEqual(transcript.payload, { ok: true });
});

console.log(`\nchat store 映射：${checks} 项通过`);
