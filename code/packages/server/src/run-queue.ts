import { TenantMap } from './tenant-map.js';
const queues = new TenantMap<string, { active: number; waiting: Array<() => void> }>();
/** 按已认证账号分配先进先出执行槽；取消等待后不再执行。 */
export async function inRunSlot<T>(limit: number, signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  let state = queues.get('slots');
  if (!state) { state = { active: 0, waiting: [] }; queues.set('slots', state); }
  const slots = state;
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { slots.waiting = slots.waiting.filter((fn) => fn !== grant); reject(new Error('任务已停止')); };
    const grant = (): void => { signal.removeEventListener('abort', abort); slots.active++; resolve(); };
    if (signal.aborted) return abort();
    if (slots.active < Math.max(1, limit)) grant();
    else { slots.waiting.push(grant); signal.addEventListener('abort', abort, { once: true }); }
  });
  try { if (signal.aborted) throw new Error('任务已停止'); return await start(); }
  finally { slots.active--; slots.waiting.shift()?.(); }
}
