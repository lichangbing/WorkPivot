import { memoryEnabled } from './memory-controls.js';
import type { Pool, PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';

/** 任务只能检索个人记忆、所属项目记忆和本任务记忆。 */
export class DatabaseMemoryTools {
  constructor(private readonly db: Pool, private readonly purpose:'load'|'update'='load') {}
  private async scope(c: PoolClient, taskId: string) {
    uuid(taskId);
    const task = (await c.query<{ project_id: string | null }>('SELECT project_id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [taskId])).rows[0];
    if (!task) throw new RepositoryError(404, '任务不存在');
    return task.project_id;
  }
  async search(actor: string, taskId: string, query: string, after?: string) {
    if (typeof query !== 'string' || query.length > 200) throw new RepositoryError(400, '记忆检索词最多200字符');
    if (after) uuid(after);
    return transaction(this.db, async c => {
      const project = await this.scope(c, taskId);
      const rows = (await c.query<{ id: string; scope: string; revision: number; preview: string }>(`SELECT m.id,m.scope,m.revision,left(r.content,300) AS preview FROM workpivot.memories m JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision
        WHERE m.deleted_at IS NULL AND COALESCE((SELECT CASE WHEN $5='load' THEN load_enabled ELSE update_enabled END FROM workpivot.memory_controls WHERE scope=m.scope),true) AND ($5='load' OR NOT m.locked) AND (m.scope='user' OR (m.scope='project' AND m.project_id=$1) OR (m.scope='task' AND m.task_id=$2))
        AND ($3='' OR strpos(lower(r.content),lower($3))>0) AND ($4::uuid IS NULL OR m.id>$4) ORDER BY m.id LIMIT 21`, [project, taskId, query.trim(), after ?? null,this.purpose])).rows;
      return { memories: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19]!.id : null };
    }, actor);
  }
  async read(actor: string, taskId: string, id: string, offset = 0) {
    uuid(id); if (!Number.isSafeInteger(offset) || offset < 0 || offset > 20000) throw new RepositoryError(400, '读取位置无效');
    return transaction(this.db, async c => {
      const project = await this.scope(c, taskId);
      const row = (await c.query<{ revision: number; scope: string; content: string }>(`SELECT m.revision,m.scope,r.content FROM workpivot.memories m JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision
        WHERE m.id=$1 AND m.deleted_at IS NULL AND (m.scope='user' OR (m.scope='project' AND m.project_id=$2) OR (m.scope='task' AND m.task_id=$3))`, [id, project, taskId])).rows[0];
      if (row && !await memoryEnabled(c,row.scope,this.purpose)) throw new RepositoryError(409, '此层记忆已关闭');
      if (!row) throw new RepositoryError(404, '记忆不存在或不属于当前任务范围');
      return { id, revision: row.revision, scope: row.scope, content: row.content.slice(offset, offset + 4000), nextOffset: row.content.length > offset + 4000 ? offset + 4000 : null };
    }, actor);
  }
  tools(actor: string, taskId: string): Tool[] {
    return [{ name: 'search_memory', kind: 'read', description: '查找当前用户个人记忆、当前项目和任务记忆。query为空返回小概览；只读取已经保存的记忆，不自动新增或修改。', parameters: { type: 'object', properties: { query: { type: 'string' }, after: { type: 'string' } }, required: ['query'], additionalProperties: false }, run: async (args, ctx) => {
      ctx.signal?.throwIfAborted(); if (typeof args['query'] !== 'string' || (args['after'] !== undefined && typeof args['after'] !== 'string')) throw new RepositoryError(400, '记忆查询参数无效');
      return JSON.stringify(await this.search(actor, taskId, args['query'], args['after'] as string | undefined));
    } }, { name: 'read_memory', kind: 'read', description: '读取 search_memory 找到的记忆内容，每段最多4000字符；返回当前修订号。删除的记忆不可读取。', parameters: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }, required: ['id'], additionalProperties: false }, run: async (args, ctx) => {
      ctx.signal?.throwIfAborted(); if (typeof args['id'] !== 'string' || (args['offset'] !== undefined && typeof args['offset'] !== 'number')) throw new RepositoryError(400, '记忆读取参数无效');
      return JSON.stringify(await this.read(actor, taskId, args['id'], args['offset'] as number | undefined));
    } }];
  }
}
