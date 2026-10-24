/**
 * 同一目录内的执行串行化。
 *
 * 文件链路的项目目录被多个对话共享；直接在工作目录执行时没有快照回写冲突检查，
 * 两个对话同时跑会互相覆盖。这里按目录排队，保证同一目录同一时刻只有一个代码执行。
 *
 * O-12：进程内队列之外再加一把文件锁（`<目录>/.workpivot/locks/<hash>.lock`），
 * 多实例部署或父子进程共享同一目录时也能串行；锁超过 2 分钟视为残留并被回收。
 */
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const tails = new Map<string, Promise<unknown>>();
const STALE_MS = 120_000;
const WAIT_MS = 30_000;
const RETRY_MS = 50;

function lockPath(dir: string): string {
  const name = createHash('sha1').update(dir).digest('hex').slice(0, 16);
  return join(dir, '.workpivot', 'locks', `${name}.lock`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(dir: string, signal?: AbortSignal): Promise<() => void> {
  const path = lockPath(dir);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    try {
      mkdirSync(join(path, '..'), { recursive: true });
      const fd = openSync(path, 'wx');
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } finally { closeSync(fd); }
      return () => { try { unlinkSync(path); } catch { /* 已被回收，忽略 */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // 残留锁：持有者崩溃后不会自己释放，按修改时间回收，避免永久卡死。
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) { unlinkSync(path); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error('同一目录的另一个执行尚未结束，请稍后重试');
      await sleep(RETRY_MS);
    }
  }
}

export function withDirectoryLock<T>(dir: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const run = async (): Promise<T> => {
    const release = await acquireFileLock(dir, signal);
    try { return await task(); } finally { release(); }
  };
  const previous = tails.get(dir) ?? Promise.resolve();
  const current = previous.then(run, run);
  const tail = current.then(() => undefined, () => undefined);
  tails.set(dir, tail);
  void tail.then(() => { if (tails.get(dir) === tail) tails.delete(dir); });
  return current;
}
