import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { listTenants, withTenant, tenantId } from './tenants.js';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';

/** 原地补充明确归属，保持路径与加密供应商数据不变。 */
export function migrateTenantData(): void {
  for (const tenant of listTenants()) withTenant(tenant.id, () => {
    const path = join(ensureWorkpivotDir('data'), 'users.json');
    const users = readJsonSafe<{ version: number; users: Array<{ id: string; role: string; tenantId?: string; platformAdmin?: boolean }> }>(path, { version: 1, users: [] }).value;
    const firstAdmin = users.users.find((user) => user.role === 'admin')?.id;
    let changed = false;
    for (const user of users.users) {
      if (user.tenantId && user.tenantId !== tenantId()) throw new Error('账户租户归属异常，停止迁移');
      if (!user.tenantId) { user.tenantId = tenantId(); changed = true; }
      if (user.platformAdmin === undefined) { user.platformAdmin = tenantId() === 'default' && user.id === firstAdmin; changed = true; }
    }
    if (changed) writeAtomicWithBackup(path, JSON.stringify(users, null, 2));
    for (const kind of ['projects', 'tasks']) {
      const root = ensureWorkpivotDir('data', kind);
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const file = join(root, entry.name, kind === 'projects' ? 'project.json' : 'task.json');
        if (!existsSync(file)) continue;
        const record = readJsonSafe<Record<string, unknown>>(file, {}).value;
        if (record.tenantId && record.tenantId !== tenantId()) throw new Error('数据租户归属异常，停止迁移');
        let dirty = false;
        if (!record.tenantId) { record.tenantId = tenantId(); dirty = true; }
        if (kind === 'projects' && record.memberUserIds === undefined) {
          record.memberUserIds = users.users.map((user) => user.id);
          if (record.id === 'p-default') record.tenantShared = true;
          record.ownerUserId ??= firstAdmin;
          dirty = true;
        }
        if (dirty) writeAtomicWithBackup(file, JSON.stringify(record, null, 2));
      }
    }
  });
}
