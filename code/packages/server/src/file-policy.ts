import { tenantPathAllowed, baseHome } from './tenants.js';
import { canonicalPath, pathWithin, workpivotHome } from '@workpivot/shared/node';
import { listUsers } from './auth.js';
import { listProjects, projectMemoryEditableBy, projectVisibleTo } from './projects.js';
import { listTasks, type Task } from './tasks.js';
import { join } from 'node:path';

/** 即使管理员代执行，也以任务所有者的权限为准；每次访问重新读取角色。 */
export function taskFilePolicy(task: Pick<Task, 'id' | 'directory' | 'projectId' | 'ownerUserId'>, fallbackUserId: string): (path: string, mode: 'read' | 'write') => boolean {
  return (path, mode) => {
    try {
      const actual = canonicalPath(path, task.directory);
      if (!tenantPathAllowed(actual) || pathWithin(actual, baseHome()) || pathWithin(actual, workpivotHome())) return false;
      const user = listUsers().find((u) => u.id === (task.ownerUserId ?? fallbackUserId));
      if (!user) return false;
      const projects = listProjects();
      const current = projects.find((p) => p.id === task.projectId);
      if (task.projectId && (!current || !projectVisibleTo(user, current))) return false;
      for (const project of projects) {
        if (!projectVisibleTo(user, project) && pathWithin(actual, project.directory)) return false;
        if (mode === 'write' && pathWithin(actual, join(project.directory, '.workpivot', 'memory')) && !projectMemoryEditableBy(user, project)) return false;
      }
      if (user.role !== 'admin') {
        for (const other of listTasks()) if (other.temp && other.id !== task.id && pathWithin(actual, other.directory)) return false;
      }
      return true;
    } catch { return false; }
  };
}
