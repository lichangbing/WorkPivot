import { accountKey } from './tenants.js';

/** 为进程内存提供请求级视图，覆盖并发流和审批。 */
export class TenantMap<K, V> {
  private readonly tenants = new Map<string, Map<K, V>>();
  private scoped(): Map<K, V> {
    const id = accountKey();
    let map = this.tenants.get(id);
    if (!map) { map = new Map(); this.tenants.set(id, map); }
    return map;
  }
  get size(): number { return this.scoped().size; }
  get(key: K): V | undefined { return this.scoped().get(key); }
  set(key: K, value: V): this { this.scoped().set(key, value); return this; }
  has(key: K): boolean { return this.scoped().has(key); }
  delete(key: K): boolean { return this.scoped().delete(key); }
  values(): MapIterator<V> { return this.scoped().values(); }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.scoped()[Symbol.iterator](); }
  *allValues(): Generator<V> { for (const map of this.tenants.values()) yield* map.values(); }
}
