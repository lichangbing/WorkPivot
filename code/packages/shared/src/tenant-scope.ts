import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantScope { id: string; home: string; workspace: string; userId?: string }
const scope = new AsyncLocalStorage<TenantScope>();
export const currentTenant = (): TenantScope | undefined => scope.getStore();
export function runInTenant<T>(tenant: TenantScope, action: () => T): T { return scope.run(tenant, action); }
