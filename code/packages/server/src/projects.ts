/**
 * F1/M1 批次 2：项目-任务两级结构。
 * 项目（名称+工作目录）1:N 任务；任务共享项目工作目录（内容/临时文件/结果落项目目录）；
 * 任务级数据（转写/PROGRESS）仍在 data/tasks/<id>/（应用数据与工作产物分离不变）。
 * 存量任务（无 projectId）启动时自动迁移进「默认项目」。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { listTasks, setTaskProject, workspaceRoot } from './tasks.js';

export interface Project {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
}

export const DEFAULT_PROJECT_ID = 'p-default';

function projectsRoot(): string {
  return ensureWorkpivotDir('data', 'projects');
}

function projectFile(projectId: string): string {
  return join(projectsRoot(), projectId, 'project.json');
}

export function getProject(projectId: string): Project | null {
  const path = projectFile(projectId);
  if (!existsSync(path)) return null;
  return readJsonSafe<Project>(path, {} as Project).value;
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
    name: '默认项目',
    directory: workspaceRoot(),
    createdAt: new Date().toISOString(),
  };
  writeAtomic(projectFile(DEFAULT_PROJECT_ID), JSON.stringify(project, null, 2));
  return project;
}

export function createProject(name: string, directory?: string): Project {
  const id = `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const project: Project = {
    id,
    name: name.trim(),
    directory:
      directory && directory.trim() !== ''
        ? join(directory)
        : join(workspaceRoot(), `${name.trim().replace(/[\\/:*?"<>|\s]+/g, '-')}-${id.slice(-6)}`),
    createdAt: new Date().toISOString(),
  };
  writeAtomic(projectFile(id), JSON.stringify(project, null, 2));
  return project;
}

export function renameProject(projectId: string, name: string): Project | null {
  const project = getProject(projectId);
  if (!project) return null;
  const updated = { ...project, name: name.trim() };
  writeAtomic(projectFile(projectId), JSON.stringify(updated, null, 2));
  return updated;
}

/** 仅摘除项目（不删工作目录文件）；项目下仍有任务时拒绝。 */
export function deleteProject(projectId: string): { ok: boolean; error?: string } {
  if (projectId === DEFAULT_PROJECT_ID) return { ok: false, error: '默认项目不可删除' };
  const hasTasks = listTasks().some((t) => t.projectId === projectId);
  if (hasTasks) return { ok: false, error: '项目下仍有任务，请先删除或转移任务' };
  const dir = join(projectsRoot(), projectId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
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
