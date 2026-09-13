import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

export interface DeliveryFile { taskId: string; name: string; version: string; hash: string; size: number }
export interface Manifest { accountId: string; files: DeliveryFile[] }
interface Entry { version: string; hash: string; baseHash?: string; path: string; conflict: boolean }
interface SyncConfig { directory: string; enabled: boolean; entries: Record<string, Entry> }
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const idOK = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
function safePath(root: string, name: string): string {
  const target = resolve(root, name), rel = relative(resolve(root), target);
  if (rel.startsWith('..') || rel.includes(':')) throw Error('同步路径越界');
  let cursor = parse(target).root;
  for (const part of target.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw Error('同步目录包含链接，请选择普通文件夹');
  }
  return target;
}
export async function fetchManifest(origin: string, token: string): Promise<Manifest> {
  const r = await fetch(origin + '/api/deliverables', { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Error('无法获取成果清单，请检查登录和服务连接');
  const m = await r.json() as Manifest;
  if (!idOK(m.accountId) || !Array.isArray(m.files) || m.files.length > 10000) throw Error('成果清单格式无效');
  return m;
}
export class ArtifactSync {
  constructor(private configDir: string) {}
  private key(origin: string, account: string) { return digest(origin + '\0' + account).slice(0, 24); }
  private read(origin: string, account: string): SyncConfig {
    const path = join(this.configDir, this.key(origin, account) + '.json');
    if (!existsSync(path)) return { directory: '', enabled: false, entries: {} };
    return JSON.parse(readFileSync(path, 'utf8')) as SyncConfig;
  }
  private save(origin: string, account: string, c: SyncConfig) {
    mkdirSync(this.configDir, { recursive: true });
    const path = join(this.configDir, this.key(origin, account) + '.json');
    writeFileSync(path + '.tmp', JSON.stringify(c)); renameSync(path + '.tmp', path);
  }
  status(origin: string, account: string) { const c = this.read(origin, account); return { directory: c.directory, enabled: c.enabled }; }
  configure(origin: string, account: string, directory: string, enabled: boolean) {
    if (!idOK(account)) throw Error('账号无效');
    if (directory) safePath(directory, '');
    const old = this.read(origin, account);
    this.save(origin, account, { directory, enabled, entries: old.directory === directory ? old.entries : {} });
    return this.status(origin, account);
  }
  async sync(origin: string, token: string, m: Manifest, stillValid: () => boolean = () => true) {
    const c = this.read(origin, m.accountId);
    const status = { directory: c.directory, enabled: c.enabled, synced: 0, conflicts: 0, errors: [] as string[] };
    if (!c.enabled || !c.directory) return status;
    const scope = safePath(c.directory, 'WorkPivot-' + this.key(origin, m.accountId));
    for (const f of m.files) {
      if (!stillValid()) throw Error('登录或服务器连接已切换');
      try {
        if (!idOK(f.taskId) || typeof f.name !== 'string' || f.name.length > 600 || !/^[a-f0-9-]{36}$/.test(f.version) || !/^[a-f0-9]{64}$/.test(f.hash) || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 50 * 1024 * 1024 || f.name.split('/').some(p => !p || p === '.' || p === '..' || /[\\<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw Error('文件名或文件大小不支持同步');
        const key = f.taskId + '/' + f.name, dest = safePath(scope, key), old = c.entries[key];
        if (old?.version === f.version && existsSync(safePath(scope, old.path))) { if (old.conflict) status.conflicts++; continue; }
        const r = await fetch(origin + `/api/tasks/${encodeURIComponent(f.taskId)}/artifact?name=${encodeURIComponent(f.name)}&version=${encodeURIComponent(f.version)}`, { headers: { authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(30000) });
        if (!r.ok || !r.body) throw Error('下载失败');
        const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        for (;;) { const v = await reader.read(); if (v.done) break; size += v.value.length; if (size > f.size) { await reader.cancel(); throw Error('文件大小校验失败'); } chunks.push(v.value); }
        const bytes = Buffer.concat(chunks);
        if (bytes.length !== f.size || digest(bytes) !== f.hash) throw Error('文件完整性校验失败');
        if (!stillValid()) throw Error('登录或服务器连接已切换');
        safePath(scope, key);
        const localHash = existsSync(dest) ? digest(readFileSync(dest)) : undefined;
        const conflict = Boolean(localHash && localHash !== old?.baseHash && localHash !== f.hash);
        let output = dest;
        if (conflict) {
          const ext = parse(dest).ext; const stem = dest.slice(0, dest.length - ext.length);
          output = `${stem} (服务器-${f.hash.slice(0, 8)})${ext}`;
          if (existsSync(output)) output = `${stem} (服务器-${randomUUID().slice(0, 8)})${ext}`;
          safePath(scope, relative(scope, output)); status.conflicts++;
        }
        mkdirSync(dirname(output), { recursive: true });
        const tmp = output + '.' + randomUUID() + '.tmp';
        writeFileSync(tmp, bytes, { flag: 'wx' });
        safePath(scope, relative(scope, output)); renameSync(tmp, output);
        c.entries[key] = { version: f.version, hash: f.hash, baseHash: conflict ? old?.baseHash : f.hash, path: relative(scope, output), conflict };
        this.save(origin, m.accountId, c); status.synced++;
      } catch (e) { status.errors.push(`${f.name}: ${e instanceof Error ? e.message : '同步失败'}`); }
    }
    return status;
  }
  localPath(origin: string, account: string, taskId: string, name: string, version?: string): string | null {
    const c = this.read(origin, account), entry = c.entries[taskId + '/' + name];
    if (!c.directory || !entry || (version && entry.version !== version)) return null;
    const path = safePath(join(c.directory, 'WorkPivot-' + this.key(origin, account)), entry.path);
    return existsSync(path) ? path : null;
  }
}
