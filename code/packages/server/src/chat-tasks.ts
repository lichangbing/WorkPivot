/**
 * R007：chat 存储的异步任务/消息入口。
 *
 * 与 `tasks.ts` 的同步实现并存：未配置 `WORKPIVOT_CHAT_DATABASE_URL` 时完全委托给同步版本，
 * 行为不变；配置后只写 PG，不再写 JSONL（避免同一份对话两个真值）。
 *
 * 调用方切换完成后（`app.ts` 等）即可移除同步版本。
 */
import { currentTenant } from '@workpivot/shared/node';
import { tenantId } from './tenants.js';
import { buildTask, getTask, listTasks, readHistory, readTranscript, appendTranscript, updateTaskStatus, deleteTempTask, persistTaskFile, type CreateTaskInput, type Task, type TaskStatus, type TranscriptKind, type TranscriptRow } from './tasks.js';
import {
  appendChatMessage,
  chatEnabled,
  createChatTask,
  deleteChatTask,
  getChatTask,
  listChatTasks,
  readChatMessages,
  readChatMessagesByKind,
  taskFromRow,
  transcriptRowFromMessage,
  updateChatTask,
} from './chat-store.js';

const VALID_ID = /^[a-zA-Z0-9_-]+$/;

export async function loadTask(taskId: string): Promise<Task | null> {
  if (!chatEnabled()) return getTask(taskId);
  if (!VALID_ID.test(taskId)) return null;
  const row = await getChatTask(taskId);
  if (!row) return null;
  if (currentTenant()?.userId && row.owner_user_id !== currentTenant()!.userId) return null;
  if (row.tenant_id && row.tenant_id !== tenantId()) return null;
  return taskFromRow(row) as Task;
}

export async function loadTasks(): Promise<Task[]> {
  if (!chatEnabled()) return listTasks();
  return (await listChatTasks()).map((row) => taskFromRow(row) as Task);
}

export async function saveTask(input: CreateTaskInput): Promise<Task> {
  const task = buildTask(input);
  if (!chatEnabled()) {
    persistTaskFile(task);
    return task;
  }
  await createChatTask({
    id: task.id,
    ownerUserId: task.ownerUserId ?? null,
    tenantId: task.tenantId ?? null,
    name: task.name,
    directory: task.directory,
    status: task.status,
    projectId: task.projectId ?? null,
    temp: task.temp === true,
    createdAt: new Date(task.createdAt),
  });
  return task;
}

export async function saveTaskStatus(taskId: string, status: TaskStatus, stopReason?: string): Promise<void> {
  if (!chatEnabled()) { updateTaskStatus(taskId, status, stopReason); return; }
  const changed = await updateChatTask(taskId, { status, stopReason: status === 'running' ? null : stopReason ?? null });
  if (!changed) return;
  await appendChatMessage({ taskId, kind: 'meta', payload: { event: 'status', status } });
}

export async function appendMessage(taskId: string, kind: TranscriptKind, payload: Record<string, unknown>): Promise<void> {
  if (!chatEnabled()) { appendTranscript(taskId, kind, payload); return; }
  const tail = await readChatMessages(taskId, { limit: 1 });
  await appendChatMessage({ taskId, kind, payload, parentId: tail.at(-1)?.id ?? null });
}

export async function readTranscriptPage(taskId: string, options: { before?: number; limit?: number } = {}): Promise<TranscriptRow[]> {
  if (!chatEnabled()) {
    const rows = readTranscript(taskId);
    const limit = options.limit ?? 100;
    if (options.before === undefined) return rows.slice(-limit);
    return rows.filter((row) => row.ordinal < options.before!).slice(-limit);
  }
  return (await readChatMessages(taskId, options)).map((row) => transcriptRowFromMessage(row) as TranscriptRow);
}

export async function loadChatMessages(taskId: string, forModel = false): Promise<Array<{ role: 'user' | 'assistant'; content: string; attachments?: string[] }>> {
  if (!chatEnabled()) return readHistory(taskId, forModel);
  const rows = await readChatMessagesByKind(taskId, ['user_message', 'assistant_message'], 200);
  return rows.map((row) => {
    const payload = row.payload as Record<string, unknown>;
    const content = String((forModel ? payload['content'] : payload['displayContent'] ?? payload['content']) ?? '');
    const attachments = Array.isArray(payload['attachments'])
      ? (payload['attachments'] as unknown[]).filter((name): name is string => typeof name === 'string')
      : undefined;
    return { role: row.kind === 'user_message' ? 'user' as const : 'assistant' as const, content, ...(attachments ? { attachments } : {}) };
  });
}

export async function removeTaskRecord(taskId: string): Promise<boolean> {
  if (!chatEnabled()) return deleteTempTask(taskId).ok;
  return deleteChatTask(taskId);
}
