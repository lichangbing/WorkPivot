import {captureTrash,revokeTrashAutomations} from './trash-capture.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

const maximum = 10 * 1024 * 1024, quota = 100 * 1024 * 1024;
interface Version { id: string; documentId: string; revision: number; name: string; size: number; sha256: string }
const columns = 'v.id,v.document_id AS "documentId",v.revision,v.name,v.size,v.sha256';
/** 磁盘原件不可变；归属、版本和发布在 PostgreSQL 事务中维护。 */
export class FileRepository {
  private readonly root: string;
  constructor(private readonly db: Pool, root: string, private readonly retainTrash=true) { this.root = resolve(root); }
  private async directory(actor: string): Promise<string> {
    uuid(actor);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, actor);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(path)).isSymbolicLink()) throw new Error('文件存储目录不能是链接');
    return path;
  }
  private async lock(c: PoolClient, actor: string): Promise<void> { await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['files:' + actor]); }
  private async task(c: PoolClient, taskId: string): Promise<void> {
    uuid(taskId);
    if (!(await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [taskId])).rowCount) throw new RepositoryError(404, '任务不存在');
  }
  async upload(actor: string, taskId: string, name: string, data: Buffer, requestId: string, documentId?: string, expected?: number, purpose: 'upload' | 'artifact' = 'upload', signal?: AbortSignal, guard?: (c: PoolClient) => Promise<void>, onPublished?: (c: PoolClient, version: Version) => Promise<void>): Promise<Version> {
    return transaction(this.db, c => this.publish(c, actor, taskId, name, data, requestId, documentId, expected, purpose, signal, guard, onPublished), actor);
  }
  async uploadArtifacts(actor: string, taskId: string, entries: { name: string; data: Buffer; documentId?: string; revision?: number }[], signal?: AbortSignal, guard?: (c: PoolClient) => Promise<void>, onPublished?: (c: PoolClient, versions: Version[]) => Promise<void>): Promise<Version[]> {
    if (!entries.length || entries.length > 10 || new Set(entries.map(e => e.name)).size !== entries.length || new Set(entries.filter(e => e.documentId).map(e => e.documentId!.toLowerCase())).size !== entries.filter(e => e.documentId).length) throw new RepositoryError(400, '产物清单重复或数量无效');
    return transaction(this.db, async c => {
      await this.lock(c, actor); await this.task(c, taskId); signal?.throwIfAborted(); await guard?.(c);
      const versions: Version[] = [];
      for (const entry of entries) versions.push(await this.publish(c, actor, taskId, entry.name, entry.data, randomUUID(), entry.documentId, entry.revision, 'artifact', signal));
      signal?.throwIfAborted(); await onPublished?.(c, versions); signal?.throwIfAborted(); return versions;
    }, actor);
  }
  private async publish(c: PoolClient, actor: string, taskId: string, name: string, data: Buffer, requestId: string, documentId?: string, expected?: number, purpose: 'upload' | 'artifact' = 'upload', signal?: AbortSignal, guard?: (c: PoolClient) => Promise<void>, onPublished?: (c: PoolClient, version: Version) => Promise<void>): Promise<Version> {
    uuid(requestId); if (documentId) uuid(documentId);
    if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name) || ['.', '..'].includes(name.trim())) throw new RepositoryError(400, '文件名无效');
    if (!Buffer.isBuffer(data) || data.length > maximum) throw new RepositoryError(413, '单个文件不能超过10MB');
    if (documentId && (!Number.isSafeInteger(expected) || expected! < 1)) throw new RepositoryError(400, '文件版本无效');
    const sha256 = createHash('sha256').update(data).digest('hex');
    await this.lock(c, actor); await this.task(c, taskId); signal?.throwIfAborted();
      await guard?.(c);
      const retry = (await c.query<Version & { taskId: string; purpose: string }>(`SELECT ${columns},d.task_id AS "taskId",d.purpose FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE v.request_id=$1`, [requestId])).rows[0];
      if (retry) {
        if (retry.purpose !== purpose || retry.taskId !== taskId || retry.name !== name || retry.sha256 !== sha256 || (documentId ? retry.documentId !== documentId || retry.revision !== expected! + 1 : retry.revision !== 1)) throw new RepositoryError(409, '上传请求标识已被不同内容使用');
        const { taskId: _task, purpose: _purpose, ...version } = retry; void _task; void _purpose; return version;
      }
      const usage = (await c.query(`SELECT (COALESCE((SELECT sum(size) FROM workpivot.document_versions),0)+COALESCE((SELECT sum((f->>'size')::bigint) FROM workpivot.trash_entries CROSS JOIN LATERAL jsonb_array_elements(files) f),0))::bigint AS bytes`)).rows[0];
      if (BigInt(usage.bytes) + BigInt(data.length) > BigInt(quota)) throw new RepositoryError(413, '资料存储额度为100MB，请清理不再需要的资料及回收站');
      const id = documentId ?? randomUUID();
      const count = (await c.query(documentId ? 'SELECT count(*)::int AS n FROM workpivot.document_versions WHERE document_id=$1' : 'SELECT count(*)::int AS n FROM workpivot.documents WHERE task_id=$1', [documentId ?? taskId])).rows[0].n;
      if (count >= 100) throw new RepositoryError(413, documentId ? '单个文件最多保留100个版本' : '每个任务最多100个文件');
      const revision = documentId ? expected! + 1 : 1;
      if (documentId) {
        const current = (await c.query('SELECT revision FROM workpivot.documents WHERE id=$1 AND task_id=$2 AND purpose=$3 FOR UPDATE', [id, taskId, purpose])).rows[0];
        if (!current) throw new RepositoryError(404, '文件不存在');
        if (current.revision !== expected) throw new RepositoryError(409, '文件已更新，请刷新后上传新版本');
        await c.query('UPDATE workpivot.documents SET revision=$2 WHERE id=$1', [id, revision]);
      } else await c.query('INSERT INTO workpivot.documents(id,owner_user_id,task_id,revision,purpose) VALUES($1,$2,$3,1,$4)', [id, actor, taskId, purpose]);
      const versionId = randomUUID();
      // 失败或 COMMIT 结果不明时留下无引用对象交给 collect()，禁止删除可能已提交的原件。
      await writeFile(join(await this.directory(actor), versionId), data, { flag: 'wx', mode: 0o600, flush: true });
      signal?.throwIfAborted();
      const published = (await c.query<Version>(`INSERT INTO workpivot.document_versions AS v(id,owner_user_id,document_id,revision,request_id,name,size,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`, [versionId, actor, id, revision, requestId, name, data.length, sha256])).rows[0]!;
      if (purpose === 'upload' && /[.](docx|xlsx|pptx|pdf|png|jpg|jpeg)$/i.test(name)) await c.query('INSERT INTO workpivot.document_processing(version_id,owner_user_id) VALUES($1,$2)', [versionId,actor]);
      signal?.throwIfAborted(); await onPublished?.(c, published); return published;
  }
  async list(actor: string, taskId: string, purpose: 'upload' | 'artifact' = 'upload'): Promise<Version[]> {
    return transaction(this.db, async c => { await this.task(c, taskId); return (await c.query<Version>(`SELECT ${columns} FROM workpivot.documents d JOIN workpivot.document_versions v ON v.document_id=d.id AND v.revision=d.revision WHERE d.task_id=$1 AND d.purpose=$2 ORDER BY v.created_at,v.id LIMIT 100`, [taskId, purpose])).rows; }, actor);
  }
  async versions(actor: string, taskId: string, documentId: string): Promise<Version[]> {
    uuid(documentId);
    return transaction(this.db, async c => { await this.task(c, taskId); return (await c.query<Version>(`SELECT ${columns} FROM workpivot.documents d JOIN workpivot.document_versions v ON v.document_id=d.id WHERE d.task_id=$1 AND d.id=$2 ORDER BY v.revision DESC LIMIT 100`, [taskId, documentId])).rows; }, actor);
  }
  async download(actor: string, taskId: string, versionId: string): Promise<{ version: Version; data: Buffer }> {
    uuid(versionId);
    return transaction(this.db, async c => {
      await this.task(c, taskId);
      const version = (await c.query<Version>(`SELECT ${columns} FROM workpivot.documents d JOIN workpivot.document_versions v ON v.document_id=d.id WHERE d.task_id=$1 AND v.id=$2`, [taskId, versionId])).rows[0];
      if (!version) throw new RepositoryError(404, '文件版本不存在');
      const data = await readFile(join(await this.directory(actor), version.id));
      if (data.length !== version.size || createHash('sha256').update(data).digest('hex') !== version.sha256) throw new RepositoryError(503, '文件校验失败，请联系部署管理员');
      return { version, data };
    }, actor);
  }
  async remove(actor: string, taskId: string, documentId: string, expected: number): Promise<void> {
    uuid(documentId); if (!Number.isSafeInteger(expected) || expected < 1) throw new RepositoryError(400, '文件版本无效');
    await transaction(this.db, async c => {
      await this.task(c, taskId);
      const row = (await c.query('SELECT revision FROM workpivot.documents WHERE id=$1 AND task_id=$2 FOR UPDATE', [documentId, taskId])).rows[0];
      if (!row) return;
      if (row.revision !== expected) throw new RepositoryError(409, '文件已更新，请刷新后删除');
      if(!this.retainTrash)await c.query("SELECT set_config('workpivot.skip_trash','1',true)");
      await captureTrash(c,'document',documentId);
      await revokeTrashAutomations(c,'document',documentId);
      // 工具结果可能包含已删原件，不得重放旧任务上下文。
      const derived=(await c.query('SELECT DISTINCT m.id,m.revision FROM workpivot.memories m JOIN workpivot.memory_sources s ON s.memory_id=m.id JOIN workpivot.task_runs r ON r.id=s.run_id WHERE r.task_id=$1 AND m.deleted_at IS NULL',[taskId])).rows;
      for(const memory of derived){
        await captureTrash(c,'memory',memory.id);
        await c.query('INSERT INTO workpivot.forget_rules(memory_id,owner_user_id,deleted_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[memory.id,actor,memory.revision]);
        await c.query('DELETE FROM workpivot.memory_revisions WHERE memory_id=$1 OR memory_id IN (SELECT id FROM workpivot.memories WHERE merged_into=$1)',[memory.id]);
        await c.query('UPDATE workpivot.memories SET deleted_at=now(),revision=revision+1 WHERE id=$1',[memory.id]);
      }
      await c.query("UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]' WHERE owner_user_id=$1", [actor]);
      await c.query("UPDATE workpivot.memory_jobs SET status='stale',error=NULL WHERE owner_user_id=$1 AND status IN ('pending','running')", [actor]);
        await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE owner_user_id=$1 AND (status='pending' OR source_run_id IN (SELECT id FROM workpivot.task_runs WHERE task_id=$2))", [actor,taskId]);
      await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,1) ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1', [actor]);
      await c.query('DELETE FROM workpivot.documents WHERE id=$1', [documentId]);
    }, actor);
  }
  async verifyRetained(actor:string,versions:{id:string;size:number;sha256:string}[]){
    const directory=await this.directory(actor);
    for(const v of versions){uuid(v.id);const bytes=await readFile(join(directory,v.id));if(bytes.length!==v.size||createHash('sha256').update(bytes).digest('hex')!==v.sha256)throw new RepositoryError(409,'回收站原件缺失或校验失败，恢复未执行');}
  }
  /** 按所有者加锁使清理与发布串行；上传响应不明时仍保留已提交引用。 */
  async collect(actor: string): Promise<number> {
    return transaction(this.db, async c => {
      await this.lock(c, actor);
      const directory = await this.directory(actor);
      const keep = new Set((await c.query('SELECT id FROM workpivot.document_versions')).rows.map(r => r.id as string));
      for(const entry of (await c.query('SELECT files FROM workpivot.trash_entries')).rows)for(const file of entry.files)keep.add(file.id);
      let removed = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9-]{36}$/.test(entry.name) || keep.has(entry.name)) continue;
        await unlink(join(directory, entry.name)); removed++;
      }
      return removed;
    }, actor);
  }
}
