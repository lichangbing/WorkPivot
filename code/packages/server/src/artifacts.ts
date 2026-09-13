import { randomUUID, createHash } from 'node:crypto';
import { requireWithin } from '@workpivot/shared/node';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from './tasks.js';
import { taskFilePolicy } from './file-policy.js';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';

type Files = Record<string, { size: number; modified: number }>;
export interface ArtifactVersion { id: string; createdAt: number; size: number; hash: string; status: 'ready' | 'failed' }
interface Index { baseline: Files; produced: string[]; versions?: Record<string, ArtifactVersion[]>; outcome?: string }
const snapshotRoot = (task: Task): string => ensureWorkpivotDir('data', 'tasks', task.id, 'artifact-versions');
const indexPath = (task: Task): string => join(ensureWorkpivotDir('data', 'tasks', task.id), 'artifacts.json');
function scan(task: Task): Files {
  const files: Files = Object.create(null) as Files;
  const allowed = taskFilePolicy(task, task.ownerUserId!);
  let entries = 0;
  const visit = (relative: string, depth: number): void => {
    const path = join(task.directory, relative);
    if (depth > 12 || entries++ > 5000 || !allowed(path, 'read') || !existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) { files[relative.replaceAll('\\', '/')] = { size: stat.size, modified: stat.mtimeMs }; return; }
    if (stat.isDirectory()) for (const name of readdirSync(path)) {
      if (name.startsWith('.') || name === 'attachments' || name === 'node_modules') continue;
      visit(join(relative, name), depth + 1);
    }
  };
  visit('', 0);
  return files;
}
export function beginArtifacts(task: Task): void {
  const old = readJsonSafe<Index>(indexPath(task), { baseline: {}, produced: [] }).value;
  writeAtomic(indexPath(task), JSON.stringify({ ...old, baseline: scan(task), outcome: undefined }));
}
export function listArtifacts(task: Task, finalize = false): Array<{ name: string; size: number; updatedAt: number; state: 'generating' | 'ready' | 'failed'; versions: ArtifactVersion[] }> {
  const files = scan(task);
  const path = indexPath(task);
  const old = readJsonSafe<Index>(path, { baseline: {}, produced: [] }).value;
  const produced = new Set(old.produced);
  if ((['running', 'waiting'].includes(task.status) || finalize) && existsSync(path)) {
    for (const [name, file] of Object.entries(files)) if (!old.baseline[name] || old.baseline[name]!.size !== file.size || old.baseline[name]!.modified !== file.modified) produced.add(name);
    if (produced.size !== old.produced.length) writeAtomic(path, JSON.stringify({ ...old, produced: [...produced] }));
  }
  return [...produced].filter((name) => files[name]).map((name) => ({ name, size: files[name]!.size, updatedAt: files[name]!.modified, state: (['running', 'waiting'].includes(task.status) && !finalize ? 'generating' : old.outcome && old.outcome !== 'completed' ? 'failed' : 'ready') as 'generating' | 'ready' | 'failed', versions: Object.hasOwn(old.versions ?? {}, name) ? old.versions![name]! : [] })).sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Save immutable revisions at the end of each run, deduplicated by content hash. */
export function finishArtifacts(task: Task, outcome: string): void {
  const files = listArtifacts(task, true);
  const old = readJsonSafe<Index>(indexPath(task), { baseline: {}, produced: [] }).value;
  const versions = Object.assign(Object.create(null), old.versions ?? {}) as Record<string, ArtifactVersion[]>;
  for (const file of files) {
    if (file.size > 50 * 1024 * 1024) continue;
    const source = requireWithin(file.name, task.directory);
    if (!taskFilePolicy(task, task.ownerUserId!)(source, 'read')) continue;
    const bytes = readFileSync(source);
    if (bytes.length > 50 * 1024 * 1024) continue;
    const hash = createHash('sha256').update(bytes).digest('hex');
    const rows = versions[file.name] ?? [];
    if (rows.at(-1)?.hash === hash && rows.at(-1)?.status === (outcome === 'completed' ? 'ready' : 'failed')) continue;
    const version: ArtifactVersion = { id: randomUUID(), createdAt: Date.now(), size: bytes.length, hash, status: outcome === 'completed' ? 'ready' : 'failed' };
    // Atomic byte-preserving snapshots; metadata is committed only after the file exists.
    writeFileSync(join(snapshotRoot(task), version.id), bytes, { flag: 'wx', mode: 0o600 });
    versions[file.name] = [...rows, version];
  }
  writeAtomic(indexPath(task), JSON.stringify({ ...old, versions, outcome }));
}
export function artifactVersionPath(task: Task, name: string, version: string): string | null {
  if (!/^[a-f0-9-]{36}$/.test(version)) return null;
  const old = readJsonSafe<Index>(indexPath(task), { baseline: {}, produced: [] }).value;
  if (!Object.hasOwn(old.versions ?? {}, name) || !old.versions![name]?.some((v) => v.id === version)) return null;
  const path = requireWithin(version, snapshotRoot(task));
  return existsSync(path) ? path : null;
}
