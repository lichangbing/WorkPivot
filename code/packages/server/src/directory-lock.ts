/**
 * 同一目录内的执行串行化。
 *
 * 文件链路的项目目录被多个对话共享；直接在工作目录执行时没有快照回写的冲突检查，
 * 两个对话同时跑会互相覆盖。这里按目录排队，保证同一目录同一时刻只有一个代码执行。
 * 服务端是单进程多用户模型，进程内队列即可；多实例部署需要换成跨进程锁。
 */
const tails = new Map<string, Promise<unknown>>();

export function withDirectoryLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(dir) ?? Promise.resolve();
  const current = previous.then(task, task);
  const tail = current.then(() => undefined, () => undefined);
  tails.set(dir, tail);
  void tail.then(() => { if (tails.get(dir) === tail) tails.delete(dir); });
  return current;
}
