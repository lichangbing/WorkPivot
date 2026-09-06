/**
 * M1 批次 1：记忆系统（E01 双层记忆 + E02 项目记忆）。
 *
 * 双层（E01，按账号隔离）：
 *  - 手写区：MEMORY.md——用户直接编辑，全部注入 system；晋升写入须确认（确认卡复用授权卡通道）
 *  - 条目区：entries.jsonl——agent 经 remember 工具静默写入；forget 删除；超量丢最旧
 * 项目记忆（E02）：任务目录 .workpivot/memory/MEMORY.md——随目录走，同目录任务共享。
 * 一键关闭（E01）：settings.memoryEnabled=false → 全部不注入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';

export interface MemoryEntry {
  id: string;
  content: string;
  createdAt: string;
}

const ENTRY_CAP = 200;
const MEMORY_MD_MAX_CHARS = 20_000;
const INJECT_ENTRY_LIMIT = 50;

function memoryRoot(userId: string): string {
  return ensureWorkpivotDir('data', 'memory', userId);
}

function handbookPath(userId: string): string {
  return join(memoryRoot(userId), 'MEMORY.md');
}

function entriesPath(userId: string): string {
  return join(memoryRoot(userId), 'entries.jsonl');
}

function settingsPath(): string {
  return join(ensureWorkpivotDir('config'), 'settings.json');
}

// ---- 手写区（用户直接编辑；晋升须经确认）----

export function readHandbook(userId: string): string {
  const path = handbookPath(userId);
  if (!existsSync(path)) return '';
  try {
    const text = readFileSync(path, 'utf8');
    return text.length > MEMORY_MD_MAX_CHARS ? text.slice(0, MEMORY_MD_MAX_CHARS) : text;
  } catch {
    return '';
  }
}

export function writeHandbook(userId: string, content: string): void {
  ensureWorkpivotDir('data', 'memory', userId);
  writeFileSync(handbookPath(userId), content, 'utf8');
}

// ---- 条目区（agent 静默写入）----

function loadEntries(userId: string): MemoryEntry[] {
  const path = entriesPath(userId);
  if (!existsSync(path)) return [];
  const rows: MemoryEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      rows.push(JSON.parse(line) as MemoryEntry);
    } catch {
      /* 坏行跳过 */
    }
  }
  return rows;
}

function saveEntries(userId: string, rows: MemoryEntry[]): void {
  ensureWorkpivotDir('data', 'memory', userId);
  writeFileSync(entriesPath(userId), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
}

/** 静默写入条目区；超 ENTRY_CAP 条丢最旧。返回条目 id。 */
export function addEntry(userId: string, content: string): string {
  const rows = loadEntries(userId);
  // 幂等去重：完全相同的内容不重复记录
  const existing = rows.find((r) => r.content === content.trim());
  if (existing) return existing.id;
  const entry: MemoryEntry = {
    id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    content: content.trim(),
    createdAt: new Date().toISOString(),
  };
  rows.push(entry);
  while (rows.length > ENTRY_CAP) rows.shift();
  saveEntries(userId, rows);
  return entry.id;
}

/** 删除匹配内容的条目（子串匹配，大小写不敏感）。返回删除数。 */
export function removeEntries(userId: string, query: string): number {
  const rows = loadEntries(userId);
  const lower = query.toLowerCase();
  const kept = rows.filter((r) => !r.content.toLowerCase().includes(lower));
  const removed = rows.length - kept.length;
  if (removed > 0) saveEntries(userId, kept);
  return removed;
}

/** M1-11：按 id 删除单条条目（设置页记忆面板用）。 */
export function removeEntryById(userId: string, id: string): boolean {
  const rows = loadEntries(userId);
  const kept = rows.filter((r) => r.id !== id);
  if (kept.length === rows.length) return false;
  saveEntries(userId, kept);
  return true;
}

export function listEntries(userId: string): MemoryEntry[] {
  return loadEntries(userId);
}

// ---- 一键关闭（E01）----

export function memoryEnabled(): boolean {
  const settings = readJsonSafe<{ memoryEnabled?: boolean }>(settingsPath(), {}).value;
  return settings.memoryEnabled !== false; // 默认开启
}

export function setMemoryEnabled(enabled: boolean): void {
  const settings = readJsonSafe<{ version?: number; permissionTier?: string; memoryEnabled?: boolean }>(settingsPath(), { version: 1 }).value;
  writeAtomic(settingsPath(), JSON.stringify({ ...settings, version: 1, memoryEnabled: enabled }, null, 2));
}

// ---- 项目记忆（E02，随任务目录走）----

export function projectMemoryPath(taskDir: string): string {
  return join(taskDir, '.workpivot', 'memory', 'MEMORY.md');
}

export function readProjectMemory(taskDir: string): string {
  const path = projectMemoryPath(taskDir);
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').slice(0, MEMORY_MD_MAX_CHARS);
  } catch {
    return '';
  }
}

export function writeProjectMemory(taskDir: string, content: string): void {
  mkdirSync(dirname2(projectMemoryPath(taskDir)), { recursive: true });
  writeFileSync(projectMemoryPath(taskDir), content, 'utf8');
}

function dirname2(p: string): string {
  const idx = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return idx > 0 ? p.slice(0, idx) : p;
}

// ---- 注入渲染（拼进 system prompt）----

export function renderMemoryInjection(userId: string, taskDir: string): string {
  if (!memoryEnabled()) return '';
  const parts: string[] = [];
  const handbook = readHandbook(userId);
  if (handbook.trim() !== '') {
    parts.push(`# 长期记忆（用户手写区）\n${handbook}`);
  }
  const entries = loadEntries(userId);
  if (entries.length > 0) {
    const recent = entries.slice(-INJECT_ENTRY_LIMIT).map((e) => `- ${e.content}`);
    parts.push(`# 已记住的条目（用户曾让你记住的信息）\n${recent.join('\n')}`);
  }
  const project = readProjectMemory(taskDir);
  if (project.trim() !== '') {
    parts.push(`# 项目记忆（本项目长期信息）\n${project}`);
  }
  if (parts.length === 0) return '';
  return '\n# 记忆\n以下是关于用户的长期记忆,可在相关时自然使用,不要逐条复述。\n' + parts.join('\n\n');
}

/** 供 /api/memory 查看的完整视图。 */
export function memoryView(userId: string, taskDir: string): {
  handbook: string;
  entries: MemoryEntry[];
  project: string;
  enabled: boolean;
} {
  return {
    handbook: readHandbook(userId),
    entries: listEntries(userId),
    project: readProjectMemory(taskDir),
    enabled: memoryEnabled(),
  };
}

/** 项目记忆目录初始化（首次进入任务时写入带说明的空 MEMORY.md）。 */
export function initProjectMemory(taskDir: string): void {
  const dir = join(taskDir, '.workpivot', 'memory');
  const path = join(dir, 'MEMORY.md');
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, '# 项目记忆\n<!-- 长期有效的项目信息;由确认流写入,也可手工编辑 -->\n', 'utf8');
  }
}

