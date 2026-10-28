import type { Request, Response } from 'express';
import type { TaskNotifications } from './task-notifications.js';
import type { WorkspaceRepository } from './workspace.js';
import { RepositoryError } from './connection.js';

/**
 * 用户级工作区 SSE：项目/任务变化通过数据库版本唤醒，连接或漏通知时由心跳补拉。
 * 完整快照只包含当前认证用户可见的项目和聊天任务，不包含聊天正文。
 */
export async function workspaceStream(req: Request, res: Response, options: {
  user: string;
  after: string;
  workspace: WorkspaceRepository;
  notifications: TaskNotifications;
  authorized: () => Promise<boolean>;
}) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(options.after)) throw new RepositoryError(400, '工作区同步游标无效');
  let lastRevision = options.after, closed = false, busy = false, dirty = false, initialized = false;
  const resources: { unsubscribe?: () => void; heartbeat?: ReturnType<typeof setInterval>; lifetime?: ReturnType<typeof setTimeout> } = {};
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(resources.heartbeat);
    clearTimeout(resources.lifetime);
    resources.unsubscribe?.();
    res.end();
  };
  const send = (value: unknown, id?: string) => {
    if (closed) return;
    if (!res.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(value)}\n\n`)) close();
  };
  const flush = async () => {
    dirty = true;
    if (busy || closed) return;
    busy = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        if (!await options.authorized()) {
          send({ type: 'unavailable', status: 401 });
          close();
          return;
        }
        const snapshot = await options.workspace.snapshot(options.user);
        if (BigInt(snapshot.revision) < BigInt(lastRevision)) {
          send({ type: 'unavailable', status: 409 });
          close();
          return;
        }
        if (!initialized || snapshot.revision !== lastRevision) {
          send({ type: 'workspace', value: snapshot }, snapshot.revision);
          initialized = true;
          lastRevision = snapshot.revision;
        }
      }
    } catch {
      if (!closed) {
        send({ type: 'unavailable', status: 409 });
        close();
      }
    } finally {
      busy = false;
    }
  };

  res.once('close', close);
  resources.unsubscribe = await options.notifications.subscribeWorkspace(options.user, () => { void flush(); });
  if (closed) {
    resources.unsubscribe();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  resources.heartbeat = setInterval(() => {
    void options.notifications.recover().catch(() => undefined);
    void flush();
    if (!closed && !res.write(': ping\n\n')) close();
  }, 15000);
  resources.lifetime = setTimeout(close, 300000);
  await flush();
}
