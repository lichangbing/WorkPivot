import { TenantMap } from './tenant-map.js';
/** RL1-06：授权按用户、任务、读写模式和路径保存。旧全局白名单不自动继承。 */
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { canonicalPath } from '@workpivot/shared/node';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';

export interface PathGrant {
  id: string;
  userId: string;
  taskId: string;
  path: string;
  mode: 'read' | 'write';
  subtree: boolean;
  createdAt: string;
}
type Owner = Pick<PathGrant, 'userId' | 'taskId'>;
interface Registry { version: 2; grants: PathGrant[] }
const sessions = new TenantMap<string, PathGrant[]>();
const key = (owner: Owner): string => JSON.stringify([owner.userId, owner.taskId]);
const registryPath = (): string => join(ensureWorkpivotDir('config'), 'permissions.json');

/** 不接受通配符、相对路径或非法值；不把解析失败退化成全目录授权。 */
function normalized(path: unknown): string | null {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\0*?]/.test(path)) return null;
  try {
    return canonicalPath(path);
  } catch { return null; }
}
function valid(value: unknown): value is PathGrant {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PathGrant>;
  return typeof row.id === 'string' && row.id !== '' && typeof row.userId === 'string' && row.userId !== '' &&
    typeof row.taskId === 'string' && row.taskId !== '' && typeof row.path === 'string' && normalized(row.path) === row.path &&
    (row.mode === 'read' || row.mode === 'write') && typeof row.subtree === 'boolean' && typeof row.createdAt === 'string';
}
export function listPathGrants(): PathGrant[] {
  const data = readJsonSafe<unknown>(registryPath(), null).value;
  if (!data || typeof data !== 'object') return [];
  const file = data as Partial<Registry>;
  // v1 不含授权归属与读写模式，无法安全迁移，必须重新确认。
  return file.version === 2 && Array.isArray(file.grants) ? file.grants.filter(valid) : [];
}
function save(grants: PathGrant[]): void {
  writeAtomicWithBackup(registryPath(), JSON.stringify({ version: 2, grants }, null, 2));
}
export function revokePathGrant(id: string): boolean {
  const grants = listPathGrants();
  if (!grants.some((g) => g.id === id)) return false;
  save(grants.filter((g) => g.id !== id));
  clearSessionGrants(grants.find((g) => g.id === id)!.taskId);
  return true;
}
export function clearSessionGrants(taskId: string): void {
  for (const [id, grants] of sessions) if (grants[0]?.taskId === taskId) sessions.delete(id);
}
export function grantPath(owner: Owner, path: string, mode: PathGrant['mode'], scope: 'session' | 'forever'): void {
  const norm = normalized(path);
  if (!norm || !owner.userId || !owner.taskId) throw new Error('授权路径或归属无效，请重新确认');
  let subtree = false;
  try { subtree = statSync(path).isDirectory(); } catch { /* 尚不存在的路径仅精确匹配 */ }
  const grants = scope === 'forever' ? listPathGrants() : (sessions.get(key(owner)) ?? []);
  if (!grants.some((g) => g.userId === owner.userId && g.taskId === owner.taskId && g.path === norm && g.mode === mode && g.subtree === subtree)) {
    grants.push({ ...owner, id: randomUUID(), path: norm, mode, subtree, createdAt: new Date().toISOString() });
  }
  if (scope === 'forever') save(grants);
  else sessions.set(key(owner), grants);
}
export function pathIsGranted(owner: Owner, path: string, mode: PathGrant['mode']): boolean {
  const norm = normalized(path);
  if (!norm) return false;
  return [...listPathGrants(), ...(sessions.get(key(owner)) ?? [])].some((g) =>
    g.userId === owner.userId && g.taskId === owner.taskId && g.mode === mode &&
    (norm === g.path || (g.subtree && norm.startsWith(g.path.endsWith(sep) ? g.path : g.path + sep))));
}
