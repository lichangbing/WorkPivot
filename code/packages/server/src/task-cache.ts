/**
 * R007：chat 模式下任务元数据的进程内视图。
 *
 * `tasks.ts` 的对外 API 是同步的（被 filePolicy 等同步回调依赖）。为了让任务元数据也能进 PG，
 * 这里在启动时把全部任务加载进内存，读走内存、写「内存 + 异步落 PG」：
 * - PG 是唯一真值，进程重启后从 PG 重新加载；chat 模式不再写 task.json。
 * - 写的异步窗口只影响"刚创建的元数据"，消息本身仍逐条 await 落库，不会丢对话。
 */
export interface CachedTask {
  id: string;
  name: string;
  directory: string;
  status: string;
  createdAt: string;
  projectId?: string;
  temp?: boolean;
  ownerUserId?: string;
  tenantId?: string;
  lastStopReason?: string;
}

let cache: Map<string, CachedTask> | null = null;

export function taskCacheReady(): boolean {
  return cache !== null;
}

export function setTaskCache(tasks: readonly CachedTask[]): void {
  cache = new Map(tasks.map((task) => [task.id, task]));
}

export function cachedTask(id: string): CachedTask | undefined {
  return cache?.get(id);
}

export function cachedTasks(): CachedTask[] {
  return cache ? [...cache.values()] : [];
}

export function cacheTask(task: CachedTask): void {
  cache?.set(task.id, task);
}

export function uncacheTask(id: string): void {
  cache?.delete(id);
}

export function clearTaskCache(): void {
  cache = null;
}
