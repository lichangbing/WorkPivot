import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalPath, pathWithin, requireWithin } from '@workpivot/shared/node';
import { getTask, listTasks, readTranscript, workspaceRoot, type Task } from './tasks.js';
import { ensureWorkpivotDir, writeAtomic } from './store.js';
import { clearSessionGrants, listPathGrants, revokePathGrant } from './permission-grants.js';
import { deleteSchedule, listSchedules } from './schedules.js';

type FileIndex = { produced?: string[]; baseline?: Record<string, unknown> };
function dataDir(task: Task): string { return requireWithin(task.id, ensureWorkpivotDir('data', 'tasks')); }
function index(task: Task): FileIndex {
  const path = join(dataDir(task), 'artifacts.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as FileIndex : {};
}
function attachments(task: Task): string[] {
  const path = join(dataDir(task), 'uploads.json');
  const uploads: string[] = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : [];
  return [...uploads, ...readTranscript(task.id).flatMap(row => Array.isArray(row.payload['attachments'])
    ? row.payload['attachments'].filter((name): name is string => typeof name === 'string') : [])].map(name => `attachments/${name}`);
}
export function recordTaskUpload(task: Task, name: string): void {
  const path = join(dataDir(task), 'uploads.json');
  const names = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : [];
  writeAtomic(path, JSON.stringify([...new Set([...names, name])]));
}

/** Delete only task-owned data. Shared project materials and promoted memories remain project/user-owned. */
export function deleteTaskData(taskId: string, validateOnly = false): void {
  const task = getTask(taskId);
  if (!task) throw Error('任务不存在');
  const peers = listTasks().filter(other => other.id !== taskId && (
    pathWithin(canonicalPath(other.directory), canonicalPath(task.directory)) || pathWithin(canonicalPath(task.directory), canonicalPath(other.directory))));
  if ([task, ...peers].some(other => ['running', 'waiting', 'queued'].includes(other.status))) {
    throw Error('请先停止该任务及同目录中正在执行的任务，再删除');
  }
  const ownIndex = index(task);
  const protectedNames = new Set<string>();
  for (const peer of peers) {
    const other = index(peer);
    for (const name of [...attachments(peer), ...(other.produced ?? []), ...Object.keys(other.baseline ?? {})]) protectedNames.add(name);
  }
  const peerText = peers.map(peer => JSON.stringify(readTranscript(peer.id))).join('\n');
  const candidates = [...new Set([...attachments(task), ...(ownIndex.produced ?? []).filter(name => !Object.hasOwn(ownIndex.baseline ?? {}, name))])];
  // Resolve and validate every target before making any filesystem changes; never recursively remove a shared directory.
  const files = candidates.filter(name => !protectedNames.has(name) && !peerText.includes(name)).map(name => requireWithin(name, task.directory))
    .filter(path => !peers.some(peer => canonicalPath(peer.directory) !== canonicalPath(task.directory) && pathWithin(canonicalPath(path), canonicalPath(peer.directory))));
  if (!pathWithin(canonicalPath(task.directory), canonicalPath(workspaceRoot()))) throw Error('任务目录不属于当前账号工作区');
  const temporaryRoot = canonicalPath(join(workspaceRoot(), '_temp'));
  const removeTemporaryDirectory = task.temp && peers.length === 0 && canonicalPath(task.directory) !== temporaryRoot && pathWithin(canonicalPath(task.directory), temporaryRoot);
  for (const path of files) if (existsSync(path) && !lstatSync(path).isFile()) throw Error('待清理文件类型异常，请检查工作目录');
  if (validateOnly) return;
  for (const path of files) rmSync(path, { force: true });
  if (removeTemporaryDirectory) rmSync(canonicalPath(task.directory), { recursive: true, force: true });
  for (const schedule of listSchedules()) if (schedule.taskId === taskId) deleteSchedule(schedule.id);
  for (const grant of listPathGrants()) if (grant.taskId === taskId) revokePathGrant(grant.id);
  clearSessionGrants(taskId);
  const sessionIndex = join(ensureWorkpivotDir('data', 'sessions'), 'index.jsonl');
  if (existsSync(sessionIndex)) writeAtomic(sessionIndex, readFileSync(sessionIndex, 'utf8').split('\n').filter(line => {
    if (!line.trim()) return false;
    const row = JSON.parse(line) as { payload?: { taskId?: string } };
    return row.payload?.taskId !== taskId;
  }).join('\n') + '\n');
  // Metadata, transcript, task memory, plans, pending requests and immutable artifact revisions live here.
  rmSync(dataDir(task), { recursive: true, force: true });
}
