/**
 * 任务注册表与转写（F01 v0）：任务=对话+真实工作目录（B01）。
 * 转写行结构见数据目录规范 §4；parentUuid 链是否预埋在 T3-01 开工时决定。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendLine, ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';

export type TaskStatus = 'running' | 'idle' | 'interrupted' | 'stopped';

export interface Task {
  id: string;
  name: string;
  directory: string;
  status: TaskStatus;
  createdAt: string;
}

export function workspaceRoot(): string {
  return process.env['WORKPIVOT_WORKSPACE'] ?? join(homedir(), 'WorkPivot', 'workspace');
}

function tasksRoot(): string {
  return ensureWorkpivotDir('data', 'tasks');
}

function taskDir(taskId: string): string {
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

export function createTask(name: string, directory?: string): Task {
  const id = `t-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const dir = directory && directory.trim() !== '' ? join(directory) : join(workspaceRoot(), `${slugify(name)}-${id.slice(-6)}`);
  mkdirSync(dir, { recursive: true });
  const task: Task = { id, name, directory: dir, status: 'idle', createdAt: new Date().toISOString() };
  writeAtomic(taskFile(id), JSON.stringify(task, null, 2));
  appendLine(join(ensureWorkpivotDir('data', 'sessions'), 'index.jsonl'), JSON.stringify({ ts: task.createdAt, kind: 'task_created', payload: { taskId: id, name, directory: dir } }));
  return task;
}

export function getTask(taskId: string): Task | null {
  if (!existsSync(taskFile(taskId))) return null;
  return readJsonSafe<Task>(taskFile(taskId), {} as Task).value;
}

export function updateTaskStatus(taskId: string, status: TaskStatus): void {
  const task = getTask(taskId);
  if (!task) return;
  writeAtomic(taskFile(taskId), JSON.stringify({ ...task, status }, null, 2));
  if (existsSync(transcriptFile(taskId))) {
    appendTranscript(taskId, 'meta', { event: 'status', status });
  }
}

/** T3-02/F04：服务启动时扫描——上次进程中断遗留的 running → interrupted（断点续跑的前置）。 */
export function markRunningTasksInterrupted(): number {
  let count = 0;
  for (const task of listTasks()) {
    if (task.status === 'running') {
      updateTaskStatus(task.id, 'interrupted');
      count += 1;
    }
  }
  return count;
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
}

let ordinalCounter = 0;

export function appendTranscript(taskId: string, kind: TranscriptKind, payload: Record<string, unknown>): void {
  ordinalCounter += 1;
  const row: TranscriptRow = { ts: new Date().toISOString(), ordinal: ordinalCounter, kind, payload };
  appendLine(transcriptFile(taskId), JSON.stringify(row));
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
export function readHistory(taskId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return readTranscript(taskId)
    .filter((r) => r.kind === 'user_message' || r.kind === 'assistant_message')
    .map((r) => ({ role: r.kind === 'user_message' ? 'user' : 'assistant', content: String(r.payload['content'] ?? '') }));
}

/** 供 agent 循环的消息历史（M0：仅文本消息；工具消息不回放，压缩与完整回放见 T3） */
export function readChatMessages(taskId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  return readHistory(taskId);
}
