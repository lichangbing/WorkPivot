import type { Request, Response } from 'express';
import type { ConversationRepository } from './conversation.js';
import type { TaskNotifications } from './task-notifications.js';

/** Durable sequence replay plus commit notifications. Slow consumers reconnect instead of buffering indefinitely. */
export async function taskStream(req: Request, res: Response, options: {
  actor: string; task: string; after: string; conversation: ConversationRepository; notifications: TaskNotifications;
  authorized: () => Promise<boolean>; state: () => Promise<unknown>;
}) {
  let after = options.after, closed = false, busy = false, dirty = false;
  const resources: {unsubscribe?:()=>void;heartbeat?:ReturnType<typeof setInterval>;lifetime?:ReturnType<typeof setTimeout>} = {};
  const close = () => { if (closed) return; closed = true; clearInterval(resources.heartbeat); clearTimeout(resources.lifetime); resources.unsubscribe?.(); res.end(); };
  res.once('close', close);
  const send = (value: unknown, id?: string) => {
    if (closed) return;
    if (!res.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(value)}\n\n`)) close();
  };
  const flush = async () => {
    dirty = true; if (busy || closed) return; busy = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        if (!await options.authorized()) { send({type:'unavailable',status:401}); close(); return; }
        let through: string | undefined, more = true;
        while (more && !closed) {
          const changes = await options.conversation.changes(options.actor, options.task, after, through);
          if (closed) return;
          send({type:'changes', ...changes}, changes.nextSequence);
          after = changes.nextSequence; through = changes.snapshotSequence; more = changes.hasMore;
        }
        if (!closed) send({type:'state', value:await options.state()});
      }
    } catch { if (!closed) { send({type:'unavailable',status:409}); close(); } }
    finally { busy = false; }
  };
  // Validate access/cursor before emitting HTTP 200, then subscribe before the replay query.
  await options.conversation.changes(options.actor, options.task, after);
  if (closed) return;
  resources.unsubscribe = await options.notifications.subscribe(options.task, () => { void flush(); });
  if (closed) { resources.unsubscribe(); return; }
  res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'}); res.flushHeaders();
  resources.heartbeat = setInterval(() => {
    void options.notifications.recover().catch(() => undefined);
    // Also recovers lost notifications and observes logout/expiry when idle.
    void flush();
    if (!closed && !res.write(': ping\n\n')) close();
  }, 15000);
  resources.lifetime = setTimeout(close, 300000);
  void flush();
}
