import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { currentTenant, pathWithin } from '@workpivot/shared/node';
import { listTenants, withTenant, withAccount, baseHome } from './tenants.js';
import { listUsers } from './auth.js';
import { writeAtomic } from './store.js';
import { ensureDefaultProject, type Project } from './projects.js';
import type { Task } from './tasks.js';
import type { Schedule } from './schedules.js';

function records<T>(root: string, name: string): T[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink())
    .map((e) => join(root, e.name, name)).filter(existsSync).map((p) => JSON.parse(readFileSync(p, 'utf8')) as T);
}
function copy(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target, { recursive: true, force: false, errorOnExist: false,
    filter: (path) => !lstatSync(path).isSymbolicLink() });
}

/** Copy only explicit ownership. Legacy shared/unknown data stays archived, never broadcast. */
export function migrateAccountData(): void {
  for (const tenant of listTenants()) withTenant(tenant.id, () => {
    const legacy = currentTenant()!;
    const projects = records<Project>(join(legacy.home, 'data/projects'), 'project.json');
    const tasks = records<Task>(join(legacy.home, 'data/tasks'), 'task.json');
    const schedulePath = join(legacy.home, 'data/schedules/schedules.json');
    const schedules = existsSync(schedulePath) ? (JSON.parse(readFileSync(schedulePath, 'utf8')) as { schedules: Schedule[] }).schedules : [];
    for (const user of listUsers()) withAccount(user, () => {
      const scope = currentTenant()!;
      const marker = join(scope.home, 'account-migration.json');
      if (existsSync(marker)) return;
      const foreign = [...projects.filter((p) => p.id !== 'p-default'), ...tasks].filter((r) => r.ownerUserId !== user.id);
      let archivedDirectories = 0;
      const copyWorkspace = (source: string, target: string): void => {
        mkdirSync(target, { recursive: true });
        // Root-wide/shared directories are ambiguous. Preserve the originals for offline recovery.
        if (!pathWithin(source, legacy.workspace) || pathWithin(legacy.workspace, source) || pathWithin(source, baseHome()) ||
          pathWithin(source, join(legacy.workspace, '.accounts')) || pathWithin(source, join(legacy.workspace, '.tenants')) ||
          foreign.some((r) => pathWithin(source, r.directory) || pathWithin(r.directory, source))) { archivedDirectories++; return; }
        copy(source, target);
      };
      const ownedProjects = new Map<string, Project>();
      for (const project of projects.filter((p) => p.ownerUserId === user.id && p.id !== 'p-default')) {
        if (!/^[a-zA-Z0-9_-]+$/.test(project.id)) throw new Error('旧项目标识无效');
        const directory = join(scope.workspace, 'projects', project.id);
        copyWorkspace(project.directory, directory);
        const updated = { ...project, directory, tenantShared: false, memberUserIds: [user.id] };
        writeAtomic(join(scope.home, 'data/projects', project.id, 'project.json'), JSON.stringify(updated, null, 2));
        ownedProjects.set(project.id, updated);
      }
      ensureDefaultProject();
      for (const task of tasks.filter((t) => t.ownerUserId === user.id)) {
        if (!/^[a-zA-Z0-9_-]+$/.test(task.id)) throw new Error('旧任务标识无效');
        const project = task.projectId ? ownedProjects.get(task.projectId) : undefined;
        const originalProject = projects.find((p) => p.id === project?.id);
        const directory = project && originalProject && pathWithin(task.directory, originalProject.directory)
          ? join(project.directory, relative(originalProject.directory, task.directory)) : join(scope.workspace, 'tasks', task.id);
        copyWorkspace(task.directory, directory);
        copy(join(legacy.home, 'data/tasks', task.id), join(scope.home, 'data/tasks', task.id));
        writeAtomic(join(scope.home, 'data/tasks', task.id, 'task.json'), JSON.stringify({ ...task, directory,
          projectId: task.temp ? undefined : project?.id ?? 'p-default' }, null, 2));
      }
      copy(join(legacy.home, 'data/memory', user.id), join(scope.home, 'data/memory', user.id));
      writeAtomic(join(scope.home, 'data/schedules/schedules.json'), JSON.stringify({ version: 1, schedules: schedules.filter((s) => s.ownerUserId === user.id) }, null, 2));
      writeAtomic(marker, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), archivedDirectories }));
    });
  });
}
