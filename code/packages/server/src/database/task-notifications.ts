import type { Pool, PoolClient, Notification } from 'pg';

/** 每个应用共用一条 LISTEN 连接服务全部任务订阅；NOTIFY 不含消息正文。 */
export class TaskNotifications {
  private listeners = new Map<string, Set<() => void>>();
  private client?: PoolClient;
  private connecting?: Promise<void>;
  constructor(private readonly db: Pool) {}
  private async connect() {
    if (this.client) return;
    if (!this.connecting) this.connecting = (async () => {
      const client = await this.db.connect();
      const failed = () => { if (this.client === client) this.client = undefined; client.release(true); };
      client.once('error', failed);
      client.on('notification', (event: Notification) => {
        if (event.channel === 'workpivot_task_events') for (const wake of this.listeners.get(event.payload ?? '') ?? []) wake();
      });
      try { await client.query('LISTEN workpivot_task_events'); this.client = client; }
      catch (error) { client.removeListener('error', failed); client.release(true); throw error; }
    })().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  async subscribe(task: string, wake: () => void) {
    await this.connect();
    const listeners = this.listeners.get(task) ?? new Set(); listeners.add(wake); this.listeners.set(task, listeners);
    return () => {
      listeners.delete(wake); if (!listeners.size) this.listeners.delete(task);
      if (!this.listeners.size && this.client) { const client = this.client; this.client = undefined; client.release(true); }
    };
  }
  async recover() { if (this.listeners.size) await this.connect(); }
}
