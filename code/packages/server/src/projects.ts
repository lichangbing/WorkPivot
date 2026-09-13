import { tenantId } from './tenants.js';
/**
 * F1/M1 批次 2：项目-任务两级结构。
 * 项目（名称+工作目录）1:N 任务；任务共享项目工作目录（内容/临时文件/结果落项目目录）；
 * 任务级数据（转写/PROGRESS）仍在 data/tasks/<id>/（应用数据与工作产物分离不变）。
 * 存量任务（无 projectId）启动时自动迁移进「默认项目」。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { moveToTrash } from './trash.js';
import { listTasks, setTaskProject, workspaceRoot } from './tasks.js';
import { listUsers, type PublicUser } from './auth.js';
import { canonicalPath, currentTenant } from '@workpivot/shared/node';

export interface Project {
  tenantId?: string;
  tenantShared?: boolean;
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  /** 旧项目未指定时由管理员代管。 */
  ownerUserId?: string;
  /** 未指定表示旧版团队共享；新项目显式记录成员。 */
  memberUserIds?: string[];
}

export const DEFAULT_PROJECT_ID = 'p-default';

function projectsRoot(): string {
  return ensureWorkpivotDir('data', 'projects');
}

function projectFile(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('项目标识无效');
  return join(projectsRoot(), projectId, 'project.json');
}

export function getProject(projectId: string): Project | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) return null;
  const path = projectFile(projectId);
  if (!existsSync(path)) return null;
  const project = readJsonSafe<Project>(path, {} as Project).value;
  if (currentTenant()?.userId && project.ownerUserId !== currentTenant()!.userId) return null;
  return project.tenantId && project.tenantId !== tenantId() ? null : project;
}

export function listProjects(): Project[] {
  const root = projectsRoot();
  if (!existsSync(root)) return [];
  const projects: Project[] = [];
  for (const entry of readdirSync(root)) {
    const project = getProject(entry);
    if (project && project.id) projects.push(project);
  }
  return projects.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

/** 默认项目：目录=工作区根（存量任务的目录都是它的子目录，语义连续）。 */
export function ensureDefaultProject(): Project {
  const existing = getProject(DEFAULT_PROJECT_ID);
  if (existing) return existing;
  const project: Project = {
    id: DEFAULT_PROJECT_ID,
    tenantId: tenantId(),
    memberUserIds: [],
    tenantShared: false,
    ownerUserId: currentTenant()?.userId,
    name: '默认项目',
    directory: workspaceRoot(),
    createdAt: new Date().toISOString(),
  };
  writeAtomic(projectFile(DEFAULT_PROJECT_ID), JSON.stringify(project, null, 2));
  return project;
}

export function createProject(name: string, directory?: string, ownerUserId?: string): Project {
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const project: Project = {
    id,
    tenantId: tenantId(),
    name: name.trim(),
    directory: canonicalPath(
      directory && directory.trim() !== ''
        ? join(directory)
        : join(workspaceRoot(), `${name.trim().replace(/[\\/:*?"<>|\s]+/g, '-')}-${id.slice(-6)}`)),
    createdAt: new Date().toISOString(),
    ownerUserId,
    memberUserIds: ownerUserId ? [ownerUserId] : undefined,
  };
  writeAtomic(projectFile(id), JSON.stringify(project, null, 2));
  return project;
}

export function projectVisibleTo(user: PublicUser | undefined, project: Project): boolean {
  return Boolean(user && (user.tenantId ?? 'default') === (project.tenantId ?? 'default') && (project.ownerUserId === user.id));
}

export function projectMemoryEditableBy(user: PublicUser | undefined, project: Project): boolean {
  return Boolean(user && (user.tenantId ?? 'default') === (project.tenantId ?? 'default') && (project.ownerUserId === user.id));
}

/** 管理员分配，保存前验证所有用户；负责人始终为项目成员。 */
export function updateProjectAccess(projectId: string, ownerUserId: string, memberUserIds: string[]): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  const known = new Set(listUsers().map((u) => u.id));
  if (!known.has(ownerUserId) || memberUserIds.some((id) => !known.has(id))) throw new Error('负责人或成员账户不存在');
  const updated = { ...project, tenantShared: false, ownerUserId, memberUserIds: [...new Set([ownerUserId, ...memberUserIds])] };
  writeAtomic(projectFile(projectId), JSON.stringify(updated, null, 2));
  return updated;
}

export function renameProject(projectId: string, name: string): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  const updated = { ...project, name: name.trim() };
  writeAtomic(projectFile(projectId), JSON.stringify(updated, null, 2));
  return updated;
}

/** 仅摘除项目（不删工作目录文件）；项目下仍有任务时拒绝。B03：项目元数据目录移入回收站。 */
export function deleteProject(projectId: string): { ok: boolean; error?: string } {
  if (projectId === DEFAULT_PROJECT_ID) return { ok: false, error: '默认项目不可删除' };
  const hasTasks = listTasks().some((t) => t.projectId === projectId);
  if (hasTasks) return { ok: false, error: '项目下仍有任务，请先删除或转移任务' };
  const dir = join(projectsRoot(), projectId);
  if (existsSync(dir)) moveToTrash(dir, `project-${projectId}`);
  return { ok: true };
}

/** 启动迁移：确保默认项目存在，并把无 projectId 的存量任务迁移进去。返回迁移数。 */
export function migrateTasksToDefaultProject(): number {
  ensureDefaultProject();
  let count = 0;
  for (const task of listTasks()) {
    if (!task.projectId && !task.temp) {
      setTaskProject(task.id, DEFAULT_PROJECT_ID);
      count += 1;
    }
  }
  return count;
}
