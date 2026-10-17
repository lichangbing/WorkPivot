import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { RepositoryError, transaction, uuid } from '../database/connection.js';
import type { BrowserConfiguration } from './tools.js';

/** 认证和任务归属始终在业务后端校验，浏览器服务只接收派生会话键。 */
export class BrowserWorkspace {
  constructor(private readonly db: Pool, private readonly config?: BrowserConfiguration) {}
  key(actor: string, taskId: string): string | undefined { return this.config ? createHmac('sha256', this.config.token).update(actor + ':' + taskId).digest('hex') : undefined; }
  async request(actor: string, taskId: string, action?: Record<string, unknown>, signal?: AbortSignal) {
    uuid(taskId);
    await transaction(this.db, async c => { if (!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [taskId])).rowCount) throw new RepositoryError(404, '任务不存在'); }, actor);
    if (!this.config) { if (action) throw new RepositoryError(503, '浏览器服务尚未启用'); return { available: false, open: false }; }
    const response = await fetch(this.config.url + '/v1/sessions/' + this.key(actor, taskId), { method: action ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + this.config.token, 'content-type': 'application/json' }, body: action ? JSON.stringify(action) : undefined, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(action ? 50000 : 10000), ...(signal ? [signal] : [])]) });
    if (!response.body) throw new RepositoryError(502, '浏览器响应为空');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 8 * 1024 * 1024) throw new RepositoryError(502, '浏览器画面过大'); chunks.push(result.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw new RepositoryError(422, String(value.error ?? '浏览器操作失败').slice(0, 300));
    return { ...value, available: true };
  }
}
