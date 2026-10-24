/**
 * R007 异步入口的文件模式回归：未配置 chat 存储时，chat-tasks 与 tasks.ts 行为一致。
 * chat 模式（真实 PG）由部署验收覆盖。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'wp-chat-tasks-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = join(home, 'workspace');
delete process.env['WORKPIVOT_CHAT_DATABASE_URL'];

const { appendMessage, loadChatMessages, loadTask, loadTasks, readTranscriptPage, removeTaskRecord, saveTask, saveTaskStatus } = await import('../packages/server/src/chat-tasks.js');

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  await run();
  checks += 1;
  console.log('✅', label);
}

try {
  let taskId = '';
  await check('文件模式新建任务：落 JSONL、可按 id 与列表读回', async () => {
    const task = await saveTask({ name: '周报', directory: join(home, 'workspace', 'weekly') });
    taskId = task.id;
    assert.ok(existsSync(join(home, 'data', 'tasks', task.id, 'task.json')), '应写 task.json');
    assert.equal((await loadTask(task.id))?.name, '周报');
    assert.equal((await loadTasks()).length, 1);
  });

  await check('追加消息与分页：seq 单调、尾部默认 100 条、before 可翻页', async () => {
    for (let index = 1; index <= 120; index += 1) await appendMessage(taskId, 'user_message', { content: `第 ${index} 条` });
    const tail = await readTranscriptPage(taskId);
    assert.equal(tail.length, 100);
    assert.equal(tail.at(-1)?.payload['content'], '第 120 条');
    const page = await readTranscriptPage(taskId, { before: tail[0]!.ordinal, limit: 50 });
    assert.equal(page.length, 20, '前面只剩 20 条');
    assert.equal(page.at(-1)?.payload['content'], '第 20 条');
  });

  await check('历史只取用户/助手两类消息，displayContent 优先', async () => {
    await appendMessage(taskId, 'assistant_message', { content: '模型原文', displayContent: '展示文本' });
    await appendMessage(taskId, 'tool_use', { toolName: 'read' });
    const history = await loadChatMessages(taskId);
    assert.equal(history.at(-1)?.role, 'assistant');
    assert.equal(history.at(-1)?.content, '展示文本');
    assert.equal(history.filter((m) => m.content.startsWith('第 ')).length, 120, '工具消息不进历史');
  });

  await check('状态更新写 meta 消息', async () => {
    await saveTaskStatus(taskId, 'running');
    const rows = await readTranscriptPage(taskId, { limit: 5 });
    assert.equal(rows.at(-1)?.kind, 'meta');
    assert.equal((rows.at(-1)?.payload as { event?: string }).event, 'status');
  });

  await check('删除临时任务：文件模式走临时任务删除，记录消失', async () => {
    const temporary = await saveTask({ name: '临时对话', directory: join(home, 'workspace', 'temp-1'), temp: true });
    const removed = await removeTaskRecord(temporary.id);
    assert.equal(removed, true);
    assert.equal(await loadTask(temporary.id), null);
  });
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log(`\nchat 异步入口（文件模式）：${checks} 项通过`);
