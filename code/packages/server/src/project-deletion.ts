import { rmSync } from 'node:fs';
import { canonicalPath, pathWithin, requireWithin } from '@workpivot/shared/node';
import { DEFAULT_PROJECT_ID, getProject, listProjects } from './projects.js';
import { listTasks, workspaceRoot } from './tasks.js';
import { deleteTaskData } from './task-deletion.js';
import { ensureWorkpivotDir } from './store.js';

/** 完整删除项目要求目录为账号工作区内的独占目录。 */
export async function deleteProjectData(id: string): Promise<string[]> {
  const project = getProject(id);
  if (!project) throw Error('项目不存在');
  if (id === DEFAULT_PROJECT_ID) throw Error('默认项目为系统项目，请删除其中的任务');
  const tasks = listTasks();
  const owned = tasks.filter(task => task.projectId === id);
  const root = canonicalPath(workspaceRoot());
  const directories = [...new Set([project.directory, ...owned.map(task => task.directory)].map(path => canonicalPath(path)))];
  const overlaps = (a: string, b: string): boolean => pathWithin(a, b) || pathWithin(b, a);
  for (const directory of directories) {
    if (directory === root || !pathWithin(directory, root)) throw Error('项目使用账号根目录或外部目录，无法安全清除，请先调整目录');
    if (listProjects().some(other => other.id !== id && other.id !== DEFAULT_PROJECT_ID && overlaps(directory, other.directory)) ||
      tasks.some(other => other.projectId !== id && overlaps(directory, other.directory))) {
      throw Error('项目目录与其他项目或任务共用，请先调整目录后再删除');
    }
  }
  for (const task of owned) await deleteTaskData(task.id, true);
  for (const task of owned) await deleteTaskData(task.id);
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  rmSync(requireWithin(id, ensureWorkpivotDir('data', 'projects')), { recursive: true, force: true });
  return owned.map(task => task.id);
}
