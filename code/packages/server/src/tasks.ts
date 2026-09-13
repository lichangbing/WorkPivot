import { currentTenant } from '@workpivot/shared/node';
import { tenantId } from './tenants.js';
/**
 * 任务注册表与转写（F01 v0）：任务=对话+真实工作目录（B01）。
 * 转写行结构见数据目录规范 §4；parentUuid 链是否预埋在 T3-01 开工时决定。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendLine, ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { moveToTrash } from './trash.js';
import { canonicalPath, pathWithin } from '@workpivot/shared/node';

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'failed' | 'idle' | 'interrupted' | 'stopped';

export interface Task {
  lastStopReason?: string;
  tenantId?: string;
  id: string;
  name: string;
  directory: string;
  status: TaskStatus;
  createdAt: string;
  /** 所属项目（F1：项目-任务两级；临时任务为空） */
  projectId?: string;
  /** 临时任务（F2）：一次性分析，不注入长期记忆 */
  temp?: boolean;
  /** J02 批次4a：创建人（任务私有——成员仅见自己的，管理员见全部；旧任务无此字段=仅管理员可见） */
  ownerUserId?: string;
}

export function workspaceRoot(): string {
  return currentTenant()?.workspace ?? process.env['WORKPIVOT_WORKSPACE'] ?? join(homedir(), 'WorkPivot', 'workspace');
}

function tasksRoot(): string {
  return ensureWorkpivotDir('data', 'tasks');
}

function taskDir(taskId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error('任务标识无效');
  return join(tasksRoot(), taskId);
}

function taskFile(taskId: string): string {
  return join(taskDir(taskId), 'task.json');
}

function transcriptFile(taskId: string): string {
  return join(taskDir(taskId), 'transcript.jsonl');
}

export function slugify(name: string): string {
  const cleaned = name.trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '');
  return cleaned || 'task';
}

export interface CreateTaskInput {
  name: string;
  /** 工作目录（由路由解析：项目目录/临时目录/显式指定） */
  directory: string;
  projectId?: string | null;
  temp?: boolean;
  /** J02：创建人 id */
  ownerUserId?: string;
}

export function createTask(input: CreateTaskInput): Task {
  const id = `t-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const dir = input.directory && input.directory.trim() !== ''
    ? join(input.directory)
    : join(workspaceRoot(), `${slugify(input.name)}-${id.slice(-6)}`);
  mkdirSync(dir, { recursive: true });
  const task: Task = {
    id,
    name: input.name,
    directory: dir,
    status: 'idle',
    createdAt: new Date().toISOString(),
    projectId: input.projectId ?? undefined,
    temp: input.temp === true,
    ownerUserId: input.ownerUserId,
    tenantId: tenantId(),
  };
  writeAtomic(taskFile(id), JSON.stringify(task, null, 2));
  appendLine(join(ensureWorkpivotDir('data', 'sessions'), 'index.jsonl'), JSON.stringify({ ts: task.createdAt, kind: 'task_created', payload: { taskId: id, name: input.name, directory: dir } }));
  return task;
}

export function getTask(taskId: string): Task | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) return null;
  if (!existsSync(taskFile(taskId))) return null;
  const task = readJsonSafe<Task>(taskFile(taskId), {} as Task).value;
  if (currentTenant()?.userId && task.ownerUserId !== currentTenant()!.userId) return null;
  return task.tenantId && task.tenantId !== tenantId() ? null : task;
}

export function updateTaskStatus(taskId: string, status: TaskStatus, stopReason?: string): void {
  const task = getTask(taskId);
  if (!task) return;
  writeAtomic(taskFile(taskId), JSON.stringify({ ...task, status, lastStopReason: status === 'running' ? undefined : stopReason }, null, 2));
  if (existsSync(transcriptFile(taskId))) {
    appendTranscript(taskId, 'meta', { event: 'status', status });
  }
}

/** T3-02/F04：服务启动时扫描——上次进程中断遗留的 running → interrupted（断点续跑的前置）。 */
export function markRunningTasksInterrupted(): number {
  let count = 0;
  for (const task of listTasks()) {
    if (['running', 'queued', 'waiting'].includes(task.status)) {
      updateTaskStatus(task.id, 'interrupted');
      count += 1;
    }
  }
  return count;
}

/** F1：迁移/归属调整——设置任务所属项目。 */
export function setTaskProject(taskId: string, projectId: string | null): void {
  const task = getTask(taskId);
  if (!task) return;
  writeAtomic(taskFile(taskId), JSON.stringify({ ...task, projectId: projectId ?? undefined }, null, 2));
}

/** F2：删除临时任务（B03 回收站：工作目录与应用数据目录移入 trash，可恢复）。 */
export function deleteTempTask(taskId: string): { ok: boolean; error?: string } {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: '任务不存在' };
  if (!task.temp) return { ok: false, error: '仅临时任务可删除' };
  const tempRoot = join(workspaceRoot(), '_temp');
  if (existsSync(task.directory)) {
    try {
      const target = canonicalPath(task.directory);
      if (target !== canonicalPath(tempRoot) && pathWithin(target, tempRoot)) {
        const moved = moveToTrash(target, `temp-${taskId}`);
        if (!moved.ok) return { ok: false, error: moved.error };
      }
    } catch { return { ok: false, error: '临时任务目录无法安全解析' }; }
  }
  moveToTrash(taskDir(taskId), `taskdata-${taskId}`);
  return { ok: true };
}

/** T3-02/F04：服务启动时扫描——上次进程中断遗留的 running → interrupted（断点续跑的前置）。 */

export function listTasks(): Task[] {
  const root = tasksRoot();
  if (!existsSync(root)) return [];
  const tasks: Task[] = [];
  for (const entry of readdirSync(root)) {
    const task = getTask(entry);
    if (task && task.id) tasks.push(task);
  }
  return tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export type TranscriptKind = 'user_message' | 'assistant_message' | 'tool_use' | 'tool_result' | 'meta';

export interface TranscriptRow {
  ts: string;
  ordinal: number;
  kind: TranscriptKind;
  payload: Record<string, unknown>;
  /** M1 收尾（T3-01 预埋）：本行 uuid 与父行 uuid——线性链，fork/rewind 上线后变树 */
  uuid?: string;
  parentUuid?: string | null;
}

let ordinalCounter = 0;

/** 每任务转写链尾 uuid（append 用；进程重启后从文件尾恢复）。 */
const lastUuidByTask = new Map<string, string | null>();

export function appendTranscript(taskId: string, kind: TranscriptKind, payload: Record<string, unknown>): void {
  if (!lastUuidByTask.has(taskId)) {
    const rows = readTranscript(taskId);
    const tail = rows[rows.length - 1];
    lastUuidByTask.set(taskId, tail?.uuid ?? null);
  }
  const parentUuid = lastUuidByTask.get(taskId) ?? null;
  const uuid = randomUUID();
  ordinalCounter += 1;
  const row: TranscriptRow = { ts: new Date().toISOString(), ordinal: ordinalCounter, kind, payload, uuid, parentUuid };
  appendLine(transcriptFile(taskId), JSON.stringify(row));
  lastUuidByTask.set(taskId, uuid);
}

export function readTranscript(taskId: string): TranscriptRow[] {
  const path = transcriptFile(taskId);
  if (!existsSync(path)) return [];
  const rows: TranscriptRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as TranscriptRow);
    } catch {
      // 坏行跳过（F01 的 .bak/隔离完整版在 T3-01）
    }
  }
  return rows;
}

/** 给 UI 的历史（M0：仅用户/助手文本；工具事件折叠进过程区，T1-03 渲染时处理） */
export function readHistory(taskId: string, forModel = false): Array<{ role: 'user' | 'assistant'; content: string; attachments?: string[] }> {
  return readTranscript(taskId)
    .filter((r) => r.kind === 'user_message' || r.kind === 'assistant_message')
    .map((r) => ({ role: r.kind === 'user_message' ? 'user' : 'assistant', content: String((forModel ? r.payload['content'] : r.payload['displayContent'] ?? r.payload['content']) ?? ''), ...(Array.isArray(r.payload['attachments']) ? { attachments: r.payload['attachments'].filter((name): name is string => typeof name === 'string') } : {}) }));
}

/** 供 agent 循环的消息历史（M0：仅文本消息；工具消息不回放，压缩与完整回放见 T3） */
export function readChatMessages(taskId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return readHistory(taskId, true);
}
