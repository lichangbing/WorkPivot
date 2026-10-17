import {captureTrash,revokeTrashAutomations} from './trash-capture.js';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface DatabaseProject { id: string; name: string; revision: number; workspaceKey: string; createdAt: Date }
export interface DatabaseTask { id: string; name: string; projectId: string | null; status: string; revision: number }
export interface DatabaseMessage { id: string; sequence: string; role: string; content: string }
const projectColumns = 'id,name,revision,expert_id AS "expertId",workspace_key AS "workspaceKey",created_at AS "createdAt"';
const taskColumns = 'id,name,project_id AS "projectId",expert_id AS "expertId",status,revision';
function title(value: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new RepositoryError(400, '名称长度无效');
  return value.trim();
}
function revision(value: number): void { if (!Number.isSafeInteger(value) || value < 1) throw new RepositoryError(400, '版本无效'); }
async function task(client: PoolClient, id: string): Promise<void> {
  uuid(id);
  if (!(await client.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rowCount) throw new RepositoryError(404, '任务不存在');
}

/** 操作者身份必须来自服务器认证，不能取自请求体或查询参数。 */
export class WorkspaceRepository {
  constructor(private readonly db: Pool,private readonly retainTrash=true) {}
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
      if (projectId && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [projectId])).rowCount) throw new RepositoryError(404, '项目不存在');
      return (await c.query<DatabaseTask>(`INSERT INTO workpivot.tasks(id,owner_user_id,project_id,name,expert_id) VALUES($1,$2,$3,$4,(SELECT p.expert_id FROM workpivot.projects p JOIN workpivot.experts e ON e.id=p.expert_id WHERE p.id=$3 AND NOT e.disabled)) RETURNING ${taskColumns}`, [randomUUID(), actor, projectId ?? null, clean])).rows[0]!;
    }, actor);
  }
  async listTasks(actor: string, includeAutomation = false): Promise<DatabaseTask[]> {
    return transaction(this.db, async c => (await c.query<DatabaseTask>(`SELECT ${taskColumns} FROM workpivot.tasks WHERE deleted_at IS NULL ${includeAutomation ? '' : "AND origin='chat'"} ORDER BY created_at,id`)).rows, actor);
  }
  async deleteTask(actor: string, id: string, expected: number): Promise<void> {
    uuid(id); revision(expected);
    await transaction(this.db, async c => {
      const current = (await c.query('SELECT revision,status,deleted_at FROM workpivot.tasks WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new RepositoryError(404, '任务不存在');
      if (current.deleted_at) return;
      if (current.revision !== expected) throw new RepositoryError(409, '任务已更新，请刷新后再删除');
      this.assertDeletable([current]);
      if(!this.retainTrash)await c.query("SELECT set_config('workpivot.skip_trash','1',true)");
      await captureTrash(c,'task',id);
      await revokeTrashAutomations(c,'task',id);
      await this.eraseMemories(c, actor, [id]);
      await this.eraseTasks(c, actor, [id]);
    }, actor);
  }
  async deleteProject(actor: string, id: string, expected: number): Promise<void> {
    uuid(id); revision(expected);
    await transaction(this.db, async c => {
      // 先锁父项目；创建任务或项目记忆时持有同一把锁。
      const current = (await c.query('SELECT revision,deleted_at FROM workpivot.projects WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new RepositoryError(404, '项目不存在');
      if (current.deleted_at) return;
      if (current.revision !== expected) throw new RepositoryError(409, '项目已更新，请刷新后再删除');
      const children = (await c.query('SELECT id,status FROM workpivot.tasks WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id FOR UPDATE', [id])).rows;
      this.assertDeletable(children);
      if(!this.retainTrash)await c.query("SELECT set_config('workpivot.skip_trash','1',true)");
      await captureTrash(c,'project',id);
      await revokeTrashAutomations(c,'project',id);
      for(const child of children){await captureTrash(c,'task',child.id);await revokeTrashAutomations(c,'task',child.id);}
      const ids = children.map((t: { id: string }) => t.id);
      await this.eraseMemories(c, actor, ids, id);
      await this.eraseTasks(c, actor, ids);
      await c.query('DELETE FROM workpivot.project_members WHERE project_id=$1', [id]);
      // 只保留后续文件清理所需的删除标记身份和工作区键。
      await c.query("UPDATE workpivot.projects SET name='已删除项目',deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1", [id]);
      await this.memoryEvent(c, actor, id, expected + 1, 'project_deleted');
    }, actor);
  }
  /** 由个人清空事务调用；不得在持有用户独占锁时另开事务。 */
  async recyclePersonal(c: PoolClient, actor: string): Promise<void> {
    const tasks=(await c.query('SELECT id,status FROM workpivot.tasks WHERE deleted_at IS NULL ORDER BY id FOR UPDATE')).rows;
    this.assertDeletable(tasks);
    const projects=(await c.query('SELECT id,revision FROM workpivot.projects WHERE deleted_at IS NULL ORDER BY id FOR UPDATE')).rows;
    for(const p of projects)await captureTrash(c,'project',p.id);
    for(const t of tasks)await captureTrash(c,'task',t.id);
    await this.eraseMemories(c,actor,[],undefined,true);
    await this.eraseTasks(c,actor,tasks.map(t=>t.id));
    for(const p of projects){
      await c.query('DELETE FROM workpivot.project_members WHERE project_id=$1',[p.id]);
      await c.query("UPDATE workpivot.projects SET name='已删除项目',deleted_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",[p.id]);
      await this.memoryEvent(c,actor,p.id,p.revision+1,'project_deleted');
    }
  }
  private assertDeletable(rows: { status: string }[]): void {
    // 尚未接入执行取消：原子拒绝删除，不得假称活动运行已停止。
    if (rows.some(r => ['queued', 'running', 'waiting'].includes(r.status))) throw new RepositoryError(409, '请先停止运行中的任务再删除');
  }
  private async eraseTasks(c: PoolClient, actor: string, ids: string[]): Promise<void> {
    await c.query('DELETE FROM workpivot.documents WHERE task_id=ANY($1::uuid[])', [ids]);
    await c.query('DELETE FROM workpivot.run_permissions WHERE task_id=ANY($1::uuid[])', [ids]);
    await c.query('DELETE FROM workpivot.task_runs WHERE task_id=ANY($1::uuid[])', [ids]);
    await c.query('DELETE FROM workpivot.conversation_events WHERE task_id=ANY($1::uuid[])', [ids]);
    await c.query('DELETE FROM workpivot.conversation_turns WHERE task_id=ANY($1::uuid[])', [ids]);
    await c.query('DELETE FROM workpivot.messages WHERE task_id=ANY($1::uuid[])', [ids]);
    const deleted = await c.query("UPDATE workpivot.tasks SET name='已删除任务',deleted_at=now(),revision=revision+1 WHERE id=ANY($1::uuid[]) RETURNING id,revision", [ids]);
    for (const row of deleted.rows) await this.memoryEvent(c, actor, row.id, row.revision, 'task_deleted');
  }
  private async eraseMemories(c: PoolClient, actor: string, taskIds: string[], projectId?: string, all = false): Promise<void> {
    await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE task_id=ANY($1::uuid[])", [taskIds]);
    const memories = await c.query('SELECT id,revision FROM workpivot.memories WHERE deleted_at IS NULL AND ($3::boolean OR task_id=ANY($1::uuid[]) OR project_id=$2 OR id IN (SELECT ms.memory_id FROM workpivot.memory_sources ms JOIN workpivot.task_runs r ON r.id=ms.run_id WHERE r.task_id=ANY($1::uuid[]))) ORDER BY id FOR UPDATE', [taskIds, projectId ?? null, all]);
    for (const m of memories.rows) {
      await captureTrash(c,'memory',m.id);
      await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3) ON CONFLICT(memory_id) DO UPDATE SET deleted_revision=EXCLUDED.deleted_revision', [m.id, actor, m.revision]);
      await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1 OR memory_id IN (SELECT id FROM workpivot.memories WHERE merged_into=$1)', [m.id]);
      await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1', [m.id]);
      await this.memoryEvent(c, actor, m.id, m.revision + 1, 'memory_deleted');
    }
  }
  async appendMessage(actor: string, taskId: string, role: 'user' | 'assistant' | 'tool' | 'system', content: string, requestId: string): Promise<DatabaseMessage> {
    uuid(taskId); uuid(requestId);
    if (typeof content !== 'string' || content.length > 200000) throw new RepositoryError(400, '消息长度无效');
    return transaction(this.db, async c => {
      // 通过行锁串行处理任务排序和重复请求检查；回滚不消耗序号。
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
    if (key === 'execution.mode' && value !== 'manual' && value !== 'auto') throw new RepositoryError(400, '执行模式只能为确认模式或自动模式');
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
  async listMemories(actor: string, scope: 'user' | 'project' | 'task', scopeId?: string, after?: string): Promise<{ memories: { id: string; content: string; revision: number }[]; nextCursor: string | null }> {
    if (!['user', 'project', 'task'].includes(scope)) throw new RepositoryError(400, '记忆层级无效');
    if (scope !== 'user') { if (!scopeId) throw new RepositoryError(400, '缺少记忆归属'); uuid(scopeId); }
    else if (scopeId) throw new RepositoryError(400, '个人记忆不指定项目或任务');
    if (after) uuid(after);
    return transaction(this.db, async c => {
      if (scope === 'task') await task(c, scopeId!);
      if (scope === 'project' && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL', [scopeId])).rowCount) throw new RepositoryError(404, '项目不存在');
      const rows = (await c.query<{ id: string; content: string; revision: number }>(`SELECT m.id,r.content,m.revision,m.locked FROM workpivot.memories m
        JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision
        WHERE m.deleted_at IS NULL AND m.scope=$1 AND ($2::uuid IS NULL OR m.project_id=$2 OR m.task_id=$2)
        AND ($3::uuid IS NULL OR m.id>$3) ORDER BY m.id LIMIT 51`, [scope, scopeId ?? null, after ?? null])).rows;
      return { memories: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49]!.id : null };
    }, actor);
  }
  async createMemory(actor: string, content: string, scope: 'user' | 'project' | 'task', scopeId?: string): Promise<{ id: string; revision: number }> {
    if (typeof content !== 'string' || content.length > 20000 || !['user', 'project', 'task'].includes(scope)) throw new RepositoryError(400, '记忆无效');
    if (scope !== 'user') { if (!scopeId) throw new RepositoryError(400, '缺少记忆归属'); uuid(scopeId); }
    else if (scopeId) throw new RepositoryError(400, '个人记忆不指定项目或任务');
    return transaction(this.db, async c => {
      if (scope === 'task') await task(c, scopeId!);
      if (scope === 'project' && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [scopeId])).rowCount) throw new RepositoryError(404, '项目不存在');
      const id = randomUUID();
      await c.query('INSERT INTO workpivot.memories(id,owner_user_id,scope,project_id,task_id) VALUES($1,$2,$3,$4,$5)', [id, actor, scope, scope === 'project' ? scopeId : null, scope === 'task' ? scopeId : null]);
      await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,1,$3)', [actor, id, content]);
      await this.memoryEvent(c, actor, id, 1, 'memory_updated');
      return { id, revision: 1 };
    }, actor);
  }
  /** 用户核对过的一批条目原子提交；拆分保留来源依据。 */
  async saveMemoryEntries(actor: string, entries: unknown, scope: 'user' | 'project' | 'task', scopeId?: string, replace?: { id: string; revision: number }) {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100 || entries.some(v => typeof v !== 'string' || !v.trim() || v.length > 20000) || entries.join('').length > 100000) throw new RepositoryError(400, '请提供1至100条非空记忆，总长度不超过10万字');
    if (!['user','project','task'].includes(scope) || (scope === 'user' && scopeId) || (scope !== 'user' && !scopeId)) throw new RepositoryError(400, '记忆归属无效');
    if (scopeId) uuid(scopeId);
    if (replace) { uuid(replace.id); revision(replace.revision); }
    return transaction(this.db, async c => {
      if (scope === 'task') await task(c, scopeId!);
      if (scope === 'project' && !(await c.query('SELECT id FROM workpivot.projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [scopeId])).rowCount) throw new RepositoryError(404, '项目不存在');
      let locked = false;
      if (replace) {
        const old = (await c.query('SELECT revision,scope,project_id,task_id,locked FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [replace.id])).rows[0];
        if (!old) throw new RepositoryError(404, '记忆不存在');
        if (old.revision !== replace.revision) throw new RepositoryError(409, '记忆已更新，请重新打开');
        if (old.scope !== scope || (scope !== 'user' && (old.project_id ?? old.task_id) !== scopeId)) throw new RepositoryError(400, '不能通过拆分改变记忆归属');
        locked = old.locked;
      }
      const saved = [];
      for (const content of entries as string[]) {
        const id = randomUUID();
        await c.query('INSERT INTO workpivot.memories(id,owner_user_id,scope,project_id,task_id,locked) VALUES($1,$2,$3,$4,$5,$6)', [id,actor,scope,scope === 'project' ? scopeId : null,scope === 'task' ? scopeId : null,locked]);
        await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,1,$3)', [actor,id,content.trim()]);
        if (replace) await c.query('INSERT INTO workpivot.memory_sources(owner_user_id,memory_id,run_id) SELECT owner_user_id,$2,run_id FROM workpivot.memory_sources WHERE memory_id=$1 ON CONFLICT DO NOTHING', [replace.id,id]);
        await this.memoryEvent(c,actor,id,1,'memory_updated');
        saved.push({id,revision:1});
      }
      if (replace) {
        await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3)', [replace.id,actor,replace.revision]);
        await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1 OR memory_id IN (SELECT id FROM workpivot.memories WHERE merged_into=$1)', [replace.id]);
        await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1', [replace.id]);
        await this.memoryEvent(c,actor,replace.id,replace.revision+1,'memory_deleted');
      }
      return saved;
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
      await captureTrash(c,'memory',id);
      await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3) ON CONFLICT(memory_id) DO UPDATE SET deleted_revision=EXCLUDED.deleted_revision', [id, actor, expected]);
      // 删除标记改变 RLS 可见性前先清理在线历史；删除事件不含明文。
      await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1 OR memory_id IN (SELECT id FROM workpivot.memories WHERE merged_into=$1)', [id]);
      await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1', [id]);
      await this.memoryEvent(c, actor, id, expected + 1, 'memory_deleted');
    }, actor);
  }
  private async memoryEvent(c: PoolClient, actor: string, id: string, rev: number, kind: string): Promise<void> {
    if (kind === 'memory_deleted' || kind === 'task_deleted' || kind === 'project_deleted') {
      // 保守失效处理：任意任务的旧回复都可能转述已遗忘事实。
      await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]'::jsonb WHERE owner_user_id=$1", [actor]);
      await c.query("UPDATE workpivot.memory_jobs SET status='stale',error=NULL WHERE owner_user_id=$1 AND status IN ('pending','running')", [actor]);
    }

    await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE owner_user_id=$1 AND status='pending'", [actor]);
    await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1', [actor]);
    await c.query('INSERT INTO workpivot.outbox_events(id,owner_user_id,kind,entity_id,revision) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor, kind, id, rev]);
  }
}
