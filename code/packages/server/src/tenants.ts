import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath, currentTenant, pathWithin, runInTenant } from '@workpivot/shared/node';

export interface Tenant { id: string; name: string; createdAt: string }
export const DEFAULT_TENANT = 'default';
export const baseHome = (): string => process.env['WORKPIVOT_HOME'] ?? join(homedir(), '.workpivot');
export const baseWorkspace = (): string => process.env['WORKPIVOT_WORKSPACE'] ?? join(homedir(), 'WorkPivot', 'workspace');
const registry = (): string => join(baseHome(), 'tenants.json');
export const tenantId = (): string => currentTenant()?.id ?? DEFAULT_TENANT;
export const tenantHome = (): string => tenantId() === DEFAULT_TENANT ? baseHome() : join(baseHome(), 'tenants', tenantId());
export const accountKey = (): string => `${tenantId()}:${currentTenant()?.userId ?? ''}`;
/** 身份与配置仍在旧注册表中；业务数据始终属于个人。 */
export function withAccount<T>(user: { id: string; tenantId?: string }, action: () => T): T {
  if (!/^[a-zA-Z0-9_-]+$/.test(user.id)) throw new Error('账户标识无效');
  return withTenant(user.tenantId ?? DEFAULT_TENANT, () => {
    const parent = currentTenant()!;
    const home = join(parent.home, 'accounts', user.id);
    const workspace = join(parent.workspace, '.accounts', user.id);
    for (const root of [join(parent.home, 'accounts'), join(parent.workspace, '.accounts'), home, workspace]) {
      if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('账户目录不能是符号链接');
    }
    for (const root of [home, workspace]) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    return runInTenant({ id: parent.id, userId: user.id, home, workspace }, action);
  });
}
/** 下次重启时不得从旧存储重复导入新账号。 */
export function markFreshAccount(user: { id: string; tenantId?: string }): void {
  withAccount(user, () => {
    const file = join(currentTenant()!.home, 'account-migration.json');
    writeFileSync(file, JSON.stringify({ version: 1, completedAt: new Date().toISOString(), archivedDirectories: 0 }), { flag: 'wx' });
  });
}
export function listTenants(): Tenant[] {
  if (!existsSync(registry())) return [{ id: DEFAULT_TENANT, name: '默认租户', createdAt: new Date(0).toISOString() }];
  const data: unknown = JSON.parse(readFileSync(registry(), 'utf8'));
  if (!Array.isArray(data) || !data.some((t) => t.id === DEFAULT_TENANT) || data.some((t) => !t || !/^[a-z][a-z0-9-]{0,39}$/.test(t.id) || typeof t.name !== 'string') || new Set(data.map((t) => t.id)).size !== data.length) throw new Error('租户注册表损坏');
  return data;
}
export function withTenant<T>(id: string, action: () => T): T {
  if (!listTenants().some((t) => t.id === id)) throw new Error('租户不存在');
  return runInTenant({ id, home: id === DEFAULT_TENANT ? baseHome() : join(baseHome(), 'tenants', id), workspace: id === DEFAULT_TENANT ? baseWorkspace() : join(baseWorkspace(), '.tenants', id) }, action);
}
export function addTenant(id: string, name: string): Tenant {
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id) || !name.trim() || name.length > 80) throw new Error('租户标识须为 2–40 位小写字母、数字或连字符，名称不能为空');
  const rows = listTenants();
  if (rows.some((t) => t.id === id)) throw new Error('租户标识已存在');
  for (const parent of [join(baseHome(), 'tenants'), join(baseWorkspace(), '.tenants')]) {
    if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new Error('租户根目录不能是符号链接');
    if (existsSync(join(parent, id))) throw new Error('租户目录已存在，拒绝覆盖');
    mkdirSync(join(parent, id), { recursive: true, mode: 0o700 });
  }
  const tenant = { id, name: name.trim(), createdAt: new Date().toISOString() };
  mkdirSync(baseHome(), { recursive: true });
  writeFileSync(registry() + '.tmp', JSON.stringify([...rows, tenant], null, 2));
  renameSync(registry() + '.tmp', registry());
  return tenant;
}

/** 租户管理员授予的文件权限不能扩大此边界。 */
export function tenantPathAllowed(path: string): boolean {
  const scope = currentTenant();
  if (!scope) return true; // 独立工具或测试；HTTP 请求始终设置作用域。
  try {
    const actual = canonicalPath(path);
    if (pathWithin(actual, baseHome())) return false;
    if (scope.userId) return pathWithin(actual, scope.workspace);
    if (scope.id === DEFAULT_TENANT && listTenants().length === 1) return !pathWithin(actual, join(baseWorkspace(), '.tenants'));
    if (!pathWithin(actual, scope.workspace)) return false;
    return scope.id !== DEFAULT_TENANT || !pathWithin(actual, join(baseWorkspace(), '.tenants'));
  } catch { return false; }
}
