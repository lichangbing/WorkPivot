import type { Pool, PoolClient, Notification } from 'pg';

/** 每个应用共用一条 LISTEN 连接服务全部任务和工作区订阅；NOTIFY 不含消息正文。 */
export class TaskNotifications {
  private listeners = new Map<string, Set<() => void>>();
  private workspaceListeners = new Map<string, Set<() => void>>();
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
        if (event.channel === 'workpivot_workspace_events') for (const wake of this.workspaceListeners.get(event.payload ?? '') ?? []) wake();
      });
      try { await client.query('LISTEN workpivot_task_events; LISTEN workpivot_workspace_events'); this.client = client; }
      catch (error) { client.removeListener('error', failed); client.release(true); throw error; }
    })().finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  async subscribe(task: string, wake: () => void) {
    await this.connect();
    const listeners = this.listeners.get(task) ?? new Set(); listeners.add(wake); this.listeners.set(task, listeners);
    return () => {
      listeners.delete(wake); if (!listeners.size) this.listeners.delete(task);
      if (!this.listeners.size && !this.workspaceListeners.size && this.client) { const client = this.client; this.client = undefined; client.release(true); }
    };
  }
  async subscribeWorkspace(user: string, wake: () => void) {
    await this.connect();
    const listeners = this.workspaceListeners.get(user) ?? new Set(); listeners.add(wake); this.workspaceListeners.set(user, listeners);
    return () => {
      listeners.delete(wake); if (!listeners.size) this.workspaceListeners.delete(user);
      if (!this.listeners.size && !this.workspaceListeners.size && this.client) { const client = this.client; this.client = undefined; client.release(true); }
    };
  }
  async recover() { if (this.listeners.size || this.workspaceListeners.size) await this.connect(); }
}
