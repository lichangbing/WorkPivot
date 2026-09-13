import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface DatabaseProject { id: string; name: string; revision: number; workspaceKey: string; createdAt: Date }
export interface DatabaseTask { id: string; name: string; projectId: string | null; status: string; revision: number }
export interface DatabaseMessage { id: string; sequence: string; role: string; content: string }
const projectColumns = 'id,name,revision,workspace_key AS "workspaceKey",created_at AS "createdAt"';
const taskColumns = 'id,name,project_id AS "projectId",status,revision';
function title(value: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new RepositoryError(400, '名称长度无效');
  return value.trim();
}
function revision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new RepositoryError(400, '版本无效'); }
async function task(client: PoolClient, id: string): Promise<void> {
  uuid(id);
  if (!(await client.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount) throw new RepositoryError(404, '任务不存在');
}

/** Actor identity must come from server authentication, never request body/query. */
export class WorkspaceRepository {
  constructor(private readonly db: Pool) {}
  async listProjects(actor: string): Promise<DatabaseProject[]> {
    return transaction(this.db, async c => (await c.query<DatabaseProject>(`SELECT ${projectColumns} FROM workpivot.projects WHERE deleted_at IS NULL ORDER BY created_at,id`)).rows, actor);
  }
  async createProject(actor: string, name: string): Promise<DatabaseProject> {
    const clean = title(name, 120), id = randomUUID();
    return transaction(this.db, async c => {
      const result = await c.query<DatabaseProject>(`INSERT INTO workpivot.projects(id,owner_user_id,name,workspace_key) VALUES($1,$2,$3,$4) RETURNING ${projectColumns}`, [id, actor, clean, `projects/${id}`]);
      await c.query("INSERT INTO workpivot.project_members(project_id,user_id,role) VALUES($1,$2,'owner')", [id, actor]);
      return result.rows[0]!;
    }, actor);
  }
  async renameProject(actor: string, id: string, name: string, expected: number): Promise<DatabaseProject> {
    uuid(id); revision(expected); const clean = title(name, 120);
    return transaction(this.db, async c => {
      if (!(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount) throw new RepositoryError(404, '项目不存在');
      const result = await c.query<DatabaseProject>(`UPDATE workpivot.projects SET name=$2,revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$3 AND deleted_at IS NULL RETURNING ${projectColumns}`, [id, clean, expected]);
      if (!result.rowCount) throw new RepositoryError(409, '项目已更新，请刷新后再修改');
      return result.rows[0]!;
    }, actor);
  }
  async createTask(actor: string, name: string, projectId?: string): Promise<DatabaseTask> {
    const clean = title(name, 200); if (projectId) uuid(projectId);
    return transaction(this.db, async c => {
      if (projectId && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [projectId])).rowCount) throw new RepositoryError(404, '项目不存在');
      return (await c.query<DatabaseTask>(`INSERT INTO workpivot.tasks(id,owner_user_id,project_id,name) VALUES($1,$2,$3,$4) RETURNING ${taskColumns}`, [randomUUID(), actor, projectId ?? null, clean])).rows[0]!;
    }, actor);
  }
  async listTasks(actor: string): Promise<DatabaseTask[]> {
    return transaction(this.db, async c => (await c.query<DatabaseTask>(`SELECT ${taskColumns} FROM workpivot.tasks WHERE deleted_at IS NULL ORDER BY created_at,id`)).rows, actor);
  }
  async appendMessage(actor: string, taskId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, requestId: string): Promise<DatabaseMessage> {
    uuid(taskId); uuid(requestId);
    if (typeof content !== 'string' || content.length > 200000) throw new RepositoryError(400, '消息长度无效');
    return transaction(this.db, async c => {
      // A row lock serializes per-task ordering and duplicate request checks; rollback consumes no sequence.
      if (!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [taskId])).rowCount) throw new RepositoryError(404, '任务不存在');
      const existing = await c.query<DatabaseMessage>('SELECT id,sequence,role,content FROM workpivot.messages WHERE task_id=$1 AND request_id=$2', [taskId, requestId]);
      if (existing.rows[0]) {
        if (existing.rows[0].role !== role || existing.rows[0].content !== content) throw new RepositoryError(409, '重复请求内容不同');
        return existing.rows[0];
      }
      const seq = (await c.query('UPDATE workpivot.tasks SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS seq', [taskId])).rows[0].seq;
      return (await c.query<DatabaseMessage>('INSERT INTO workpivot.messages(id,owner_user_id,task_id,sequence,role,content,request_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,sequence,role,content', [randomUUID(), actor, taskId, seq, role, content, requestId])).rows[0]!;
    }, actor);
  }
  async messages(actor: string, taskId: string, after = '0', limit = 100): Promise<DatabaseMessage[]> {
    if (!/^\d{1,18}$/.test(after) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new RepositoryError(400, '分页参数无效');
    return transaction(this.db, async c => { await task(c, taskId); return (await c.query<DatabaseMessage>('SELECT id,sequence,role,content FROM workpivot.messages WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3', [taskId, after, limit])).rows; }, actor);
  }
  async setting(actor: string, key: string): Promise<{ value: unknown; revision: number } | null> {
    return transaction(this.db, async c => (await c.query('SELECT value,revision FROM workpivot.user_settings WHERE owner_user_id=$1 AND key=$2', [actor, key])).rows[0] ?? null, actor);
  }
  async saveSetting(actor: string, key: string, value: unknown, expected: number): Promise<number> {
    if (!/^[a-z][a-z0-9.-]{0,79}$/.test(key) || !Number.isInteger(expected) || expected < 0) throw new RepositoryError(400, '设置参数无效');
    const payload = JSON.stringify(value);
    if (!payload || payload.length > 20000) throw new RepositoryError(400, '设置内容过大或无效');
    return transaction(this.db, async c => {
      const result = expected === 0
        ? await c.query('INSERT INTO workpivot.user_settings(owner_user_id,key,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING revision', [actor, key, payload])
        : await c.query('UPDATE workpivot.user_settings SET value=$3,revision=revision+1 WHERE owner_user_id=$1 AND key=$2 AND revision=$4 RETURNING revision', [actor, key, payload, expected]);
      if (!result.rows[0]) throw new RepositoryError(409, '设置已更新'); return result.rows[0].revision;
    }, actor);
  }
  async createMemory(actor: string, content: string, scope: 'user' | 'project' | 'task', scopeId?: string): Promise<{ id: string; revision: number }> {
    if (typeof content !== 'string' || content.length > 20000 || !['user', 'project', 'task'].includes(scope)) throw new RepositoryError(400, '记忆无效');
    if (scope !== 'user') { if (!scopeId) throw new RepositoryError(400, '缺少记忆归属'); uuid(scopeId); }
    else if (scopeId) throw new RepositoryError(400, '个人记忆不指定项目或任务');
    return transaction(this.db, async c => {
      if (scope === 'task') await task(c, scopeId!);
      if (scope === 'project' && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [scopeId])).rowCount) throw new RepositoryError(404, '项目不存在');
      const id = randomUUID();
      await c.query('INSERT INTO workpivot.memories(id,owner_user_id,scope,project_id,task_id) VALUES($1,$2,$3,$4,$5)', [id, actor, scope, scope === 'project' ? scopeId : null, scope === 'task' ? scopeId : null]);
      await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,1,$3)', [actor, id, content]);
      await this.memoryEvent(c, actor, id, 1, 'memory_updated');
      return { id, revision: 1 };
    }, actor);
  }
  async readMemory(actor: string, id: string): Promise<{ content: string; revision: number } | null> {
    uuid(id);
    return transaction(this.db, async c => (await c.query('SELECT r.content,m.revision FROM workpivot.memories m JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision WHERE m.id=$1 AND m.deleted_at IS NULL', [id])).rows[0] ?? null, actor);
  }
  async editMemory(actor: string, id: string, content: string, expected: number): Promise<number> {
    uuid(id); revision(expected);
    if (typeof content !== 'string' || content.length > 20000) throw new RepositoryError(400, '记忆内容无效');
    return transaction(this.db, async c => {
      const current = (await c.query('SELECT revision FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!current) throw new RepositoryError(404, '记忆不存在');
      if (current.revision !== expected) throw new RepositoryError(409, '记忆已更新');
      await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,$3,$4)', [actor, id, expected + 1, content]);
      await c.query('UPDATE workpivot.memories SET revision=revision+1 WHERE id=$1', [id]);
      await this.memoryEvent(c, actor, id, expected + 1, 'memory_updated'); return expected + 1;
    }, actor);
  }
  async deleteMemory(actor: string, id: string, expected: number): Promise<void> {
    uuid(id); revision(expected);
    await transaction(this.db, async c => {
      const current = (await c.query('SELECT revision FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
      if (!current) throw new RepositoryError(404, '记忆不存在');
      if (current.revision !== expected) throw new RepositoryError(409, '记忆已更新');
      await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3)', [id, actor, expected]);
      // Remove online history before tombstone changes its RLS visibility. No plaintext in deletion events.
      await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1', [id]);
      await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1', [id]);
      await this.memoryEvent(c, actor, id, expected + 1, 'memory_deleted');
    }, actor);
  }
  private async memoryEvent(c: PoolClient, actor: string, id: string, rev: number, kind: string): Promise<void> {
    await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1', [actor]);
    await c.query('INSERT INTO workpivot.outbox_events(id,owner_user_id,kind,entity_id,revision) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor, kind, id, rev]);
  }
}
