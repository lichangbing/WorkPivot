import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathWithin, requireWithin } from '@workpivot/shared/node';
import { randomUUID } from 'node:crypto';
import { moveToTrash } from './trash.js';
import type { Skill } from './skills.js';
import type { Task } from './tasks.js';
type Files = Array<[string, string]>;
const LIMIT = 16 * 1024 * 1024;
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function snapshotFiles(root: string, allowed: (path: string) => boolean): Files {
  const files: Files = []; let bytes = 0, entries = 0;
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      if (++entries > 4000) throw new Error('执行文件超过4000项');
      const name = relative ? `${relative}/${entry.name}` : entry.name, path = join(root, name);
      if (!allowed(path) || !pathWithin(path, root)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) { walk(name); continue; }
      if (!stat.isFile() || stat.nlink !== 1) continue;
      bytes += stat.size;
      if (bytes > LIMIT) throw new Error('执行文件超过16MiB');
      files.push([name, readFileSync(path).toString('base64')]);
    }
  };
  walk(''); return files;
}

/** The host service accepts bounded files/commands only, never Docker arguments or host paths. */
export function workerCommand(task: Task, allowed: (path: string, mode: 'read' | 'write') => boolean, signal: AbortSignal, skills: () => Skill[]): (command: string) => Promise<string> {
  return async (command) => {
    signal.throwIfAborted();
    const url = process.env['WORKPIVOT_WORKER_URL'], token = process.env['WORKPIVOT_WORKER_TOKEN'];
    if (!url || !token) throw new Error('技能执行服务尚未配置');
    const files = snapshotFiles(task.directory, (path) => allowed(path, 'read'));
    const originals = new Map(files.map(([name, data]) => [name, hash(Buffer.from(data, 'base64'))]));
    const resources: Files = [];
    for (const skill of skills()) for (const [name, data] of snapshotFiles(skill.dir, (path) => skill.source !== 'project' || allowed(path, 'read'))) resources.push([`${skill.name}/${name}`, data]);
    if ([...files, ...resources].reduce((size, [, data]) => size + Buffer.byteLength(data, 'base64'), 0) > LIMIT) throw new Error('任务及技能资源合计超过16MiB');
    const response = await fetch(`${url.replace(/\/$/, '')}/v1/run`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ command, files, skills: resources }), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(140000)]) });
    // Bound untrusted service output before JSON parsing.
    if (!response.body) throw new Error('技能执行服务未返回结果');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 24 * 1024 * 1024) throw new Error('执行结果超过大小限制'); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: string; files?: unknown; output?: string };
    if (!response.ok) throw new Error(result.error ?? '技能执行失败');
    if (!Array.isArray(result.files) || result.files.length > 4000) throw new Error('执行产物格式无效');
    const output = new Map<string, Buffer>(); const targets = new Set<string>(); let bytes = 0;
    for (const entry of result.files) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || /[\\:\0]/.test(entry[0]) || entry[0].split('/').some((part: string) => !part || part === '.' || part === '..') || output.has(entry[0])) throw new Error('执行产物路径无效');
      const target = requireWithin(entry[0], task.directory);
      if (targets.has(target)) throw new Error('执行产物存在重复目标'); targets.add(target);
      const data = Buffer.from(entry[1], 'base64'); if (data.toString('base64') !== entry[1]) throw new Error('执行产物编码无效'); bytes += data.length; if (bytes > LIMIT) throw new Error('执行产物超过16MiB');
      output.set(entry[0], data);
    }
    const changes: Array<{ path: string; data?: Buffer }> = [];
    for (const name of new Set([...originals.keys(), ...output.keys()])) {
      const data = output.get(name);
      if (data && hash(data) === originals.get(name)) continue;
      const path = requireWithin(name, task.directory);
      if (!allowed(path, 'write')) throw new Error('执行产物无权回写');
      if ((existsSync(path) ? hash(readFileSync(path)) : undefined) !== originals.get(name)) throw new Error('文件已被其他任务修改，拒绝覆盖');
      changes.push({ path, data });
    }
    for (const change of changes) {
      signal.throwIfAborted(); if (!allowed(change.path, 'write')) throw new Error('文件权限已撤销');
      if (change.data) { mkdirSync(dirname(change.path), { recursive: true }); const temp = `${change.path}.${randomUUID()}.tmp`; writeFileSync(temp, change.data); renameSync(temp, change.path); }
      else { const moved = moveToTrash(change.path, randomUUID()); if (!moved.ok) throw new Error(moved.error); }
    }
    return `exit=0\n${String(result.output ?? '').slice(0, 65536)}`;
  };
}
