import { rejectionHash, validateReplacements, type ProposalReview } from './memory-review.js';
import { validateMemoryContext, type MemorySource } from './memory-context.js';
import { memoryEnabled } from './memory-controls.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Tool } from '@workpivot/core';
import { RepositoryError, transaction, uuid } from './connection.js';

/** Proposals are not memories: only the authenticated user's decision publishes one. */
export class MemorySuggestions {
  constructor(private readonly db: Pool) {}
  async epoch(actor: string): Promise<string> { return transaction(this.db, async c => String((await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1', [actor])).rows[0]?.epoch ?? 0), actor); }
  async propose(actor: string, taskId: string, epoch: string, scope: string, content: string, targetId?: string, targetRevision?: number, source?: MemorySource & { context?: MemorySource[] }, mergeTargets: { id: string; revision: number }[] = [], review: ProposalReview = {}) {
    uuid(taskId); if (!['user', 'project', 'task'].includes(scope) || typeof content !== 'string' || !content.trim() || content.length > 20000) throw new RepositoryError(400, '记忆建议无效');
    if (targetId !== undefined) { uuid(targetId); if (!Number.isSafeInteger(targetRevision) || targetRevision! < 1) throw new RepositoryError(400, '需要目标记忆修订号'); }
    else if (targetRevision !== undefined) throw new RepositoryError(400, '缺少目标记忆');
    if (!Array.isArray(mergeTargets) || mergeTargets.length > 10 || (mergeTargets.length && (mergeTargets.length < 2 || targetId))) throw new RepositoryError(400, '合并需要2至10条记忆');
    const ids = new Set<string>();
    for (const t of mergeTargets) { uuid(t.id); if (ids.has(t.id.toLowerCase()) || !Number.isSafeInteger(t.revision) || t.revision < 1) throw new RepositoryError(400, '合并目标无效'); ids.add(t.id.toLowerCase()); }
    mergeTargets = mergeTargets.map(t => ({ ...t, id: t.id.toLowerCase() })).sort((a,b) => a.id.localeCompare(b.id));
    const dedupeHash = rejectionHash(actor, taskId, scope, review.dedupeKey);
    const replaces = review.replaces ?? [];
    return transaction(this.db, async c => {
      const task = (await c.query('SELECT project_id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [taskId])).rows[0];
      if (!task || (scope === 'project' && !task.project_id)) throw new RepositoryError(404, '建议归属不存在');
      if(!await memoryEnabled(c,scope,'update'))throw new RepositoryError(409,'此层自动更新已关闭');
      const current = String((await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1', [actor])).rows[0]?.epoch ?? 0);
      if (epoch !== current) throw new RepositoryError(409, '记忆已发生变更，当前轮次不能继续提交旧建议');
      if (targetId) {
        const target = (await c.query('SELECT revision,scope,project_id,task_id,locked FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [targetId])).rows[0];
        if (!target || target.scope !== scope || (scope === 'project' && target.project_id !== task.project_id) || (scope === 'task' && target.task_id !== taskId)) throw new RepositoryError(404, '目标记忆不属于当前任务范围');
        if (target.locked) throw new RepositoryError(409,'记忆已锁定');
        if (target.revision !== targetRevision) throw new RepositoryError(409, '目标记忆已修改，请重新读取');
      }
      for (const t of mergeTargets) {
        const m = (await c.query('SELECT revision,scope,project_id,task_id,locked FROM workpivot.memories WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [t.id])).rows[0];
        if (!m || m.scope !== scope || (scope === 'project' && m.project_id !== task.project_id) || (scope === 'task' && m.task_id !== taskId)) throw new RepositoryError(404, '合并目标不属于当前范围');
        if (m.locked) throw new RepositoryError(409,'记忆已锁定');
        if (m.revision !== t.revision) throw new RepositoryError(409, '合并目标已修改');
      }
      if (source) {
        if ((await c.query("SELECT value FROM workpivot.user_settings WHERE key='memory.auto-extraction'")).rows[0]?.value === false) throw new RepositoryError(409, '自动整理已关闭');
        await validateMemoryContext(c, taskId, source, source.context ?? []);
      }
      if (dedupeHash) {
        const rejected = (await c.query("SELECT id,status FROM workpivot.memory_suggestions WHERE task_id=$1 AND scope=$2 AND dedupe_hash=$3 AND status='rejected' LIMIT 1", [taskId, scope, dedupeHash])).rows[0];
        if (rejected) return rejected;
      }
      let fingerprint = createHash('sha256').update(scope + ':' + (targetId ?? '') + ':' + (targetRevision ?? '') + ':' + content.trim().normalize('NFKC') + (mergeTargets.length ? JSON.stringify(mergeTargets) : '')).digest('hex');
      let existing = (await c.query('SELECT id,status,replaced_by FROM workpivot.memory_suggestions WHERE task_id=$1 AND fingerprint=$2', [taskId, fingerprint])).rows[0];
      // A later explicit correction may return to a previously superseded value.
      // Forgotten/stale and rejected proposals remain protected against replay.
      if (existing?.status === 'stale' && existing.replaced_by && source && replaces.length) {
        fingerprint = createHash('sha256').update(fingerprint + ':' + source.runId).digest('hex');
        existing = (await c.query('SELECT id,status FROM workpivot.memory_suggestions WHERE task_id=$1 AND fingerprint=$2', [taskId, fingerprint])).rows[0];
      }
      if (existing) return existing;
      await validateReplacements(c, taskId, scope, epoch, source?.runId, replaces, targetId, targetRevision, mergeTargets, source?.context?.map(item => item.runId) ?? []);
      const id = randomUUID();
      await c.query('INSERT INTO workpivot.memory_suggestions(id,owner_user_id,task_id,scope,project_id,content,fingerprint,epoch,target_id,target_revision,source_run_id,evidence,merge_targets,source_context,dedupe_hash,replaces,review_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)', [id, actor, taskId, scope, scope === 'project' ? task.project_id : null, content.trim(), fingerprint, epoch, targetId ?? null, targetRevision ?? null, source?.runId ?? null, source?.evidence ?? null, JSON.stringify(mergeTargets), JSON.stringify(source?.context ?? []), dedupeHash, replaces, review.dedupeKey ?? null]);
      if (replaces.length) await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL,replaced_by=$1 WHERE id=ANY($2::uuid[])", [id, replaces]);
      return { id, status: 'pending' };
    }, actor);
  }
  async list(actor: string) {
    return transaction(this.db, async c => (await c.query(`SELECT s.id,s.scope,s.merge_targets AS "mergeTargets",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',mm.id,'content',rr.content,'revision',mm.revision)) FROM jsonb_to_recordset(s.merge_targets) AS mt(id uuid,revision integer) JOIN workpivot.memories mm ON mm.id=mt.id AND mm.deleted_at IS NULL AND mm.revision=mt.revision JOIN workpivot.memory_revisions rr ON rr.memory_id=mm.id AND rr.revision=mm.revision),'[]'::jsonb) AS "mergeOriginals",s.content,s.evidence,cardinality(s.replaces) AS "replacedCount",s.source_context AS "sourceContext",s.target_id AS "targetId",s.target_revision AS "targetRevision",r.content AS "originalContent",s.task_id AS "taskId",t.name AS "taskName",s.created_at AS "createdAt" FROM workpivot.memory_suggestions s JOIN workpivot.tasks t ON t.id=s.task_id LEFT JOIN workpivot.memories m ON m.id=s.target_id AND m.deleted_at IS NULL AND m.revision=s.target_revision LEFT JOIN workpivot.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision
      WHERE s.status='pending' AND (s.target_id IS NULL OR m.id IS NOT NULL) AND t.deleted_at IS NULL AND s.epoch=COALESCE((SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1),0) ORDER BY s.created_at,s.id LIMIT 50`, [actor])).rows, actor);
  }
  async decide(actor: string, id: string, accept: boolean, content?: string) {
    uuid(id); if (content !== undefined && (typeof content !== 'string' || !content.trim() || content.length > 20000)) throw new RepositoryError(400, '确认内容无效');
    return transaction(this.db, async c => {
      // Same task-first lock order as task/project deletion.
      const source = (await c.query('SELECT task_id,target_id,merge_targets FROM workpivot.memory_suggestions WHERE id=$1', [id])).rows[0];
      if (!source) throw new RepositoryError(404, '建议不存在');
      const task = (await c.query('SELECT id FROM workpivot.tasks WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [source.task_id])).rows[0];
      if (!task) throw new RepositoryError(404, '来源任务已删除');
      const target = source.target_id ? (await c.query('SELECT revision,deleted_at,locked FROM workpivot.memories WHERE id=$1 FOR UPDATE', [source.target_id])).rows[0] : null;
      const mergeRows = [];
      for (const t of source.merge_targets as { id: string; revision: number }[]) {
        const m = (await c.query('SELECT id,revision,deleted_at,locked FROM workpivot.memories WHERE id=$1 FOR UPDATE', [t.id])).rows[0];
        mergeRows.push({ expected: t.revision, memory: m });
      }
      const s = (await c.query('SELECT * FROM workpivot.memory_suggestions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (s.status !== 'pending') throw new RepositoryError(409, '建议已处理');
      if (accept && s.source_run_id) await validateMemoryContext(c, s.task_id, { runId: s.source_run_id, evidence: s.evidence }, s.source_context);
      if (!accept) { await c.query("UPDATE workpivot.memory_suggestions SET status='rejected',content='',evidence=NULL WHERE id=$1", [id]); return { status: 'rejected' }; }
      await c.query('INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) VALUES($1,0) ON CONFLICT DO NOTHING', [actor]);
      const epoch = (await c.query('SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1 FOR UPDATE', [actor])).rows[0].epoch;
      if (String(epoch) !== String(s.epoch)) throw new RepositoryError(409, '记忆已被修改或删除，此建议已失效');
      if (s.target_id && (!target || target.deleted_at || target.revision !== s.target_revision)) throw new RepositoryError(409, '目标记忆已被修改或删除');
      if (mergeRows.some(t => !t.memory || t.memory.deleted_at || t.memory.revision !== t.expected)) throw new RepositoryError(409, '合并目标已被修改或删除，请重新整理');
      if(!await memoryEnabled(c,s.scope,'update') || target?.locked || mergeRows.some(t=>t.memory?.locked))throw new RepositoryError(409,'记忆已锁定或该层自动更新已关闭');
      const memoryId = s.target_id ?? randomUUID();
      const revision = s.target_id ? s.target_revision + 1 : 1;
      if (!s.target_id) await c.query('INSERT INTO workpivot.memories(id,owner_user_id,scope,project_id,task_id) VALUES($1,$2,$3,$4,$5)', [memoryId, actor, s.scope, s.project_id, s.scope === 'task' ? s.task_id : null]);
      else await c.query('UPDATE workpivot.memories SET revision=$2 WHERE id=$1', [memoryId, revision]);
      await c.query('INSERT INTO workpivot.memory_revisions(owner_user_id,memory_id,revision,content) VALUES($1,$2,$3,$4)', [actor, memoryId, revision, content?.trim() ?? s.content]);
      const mergedIds = (s.merge_targets as { id: string }[]).map(t => t.id);
      if (mergedIds.length) {
        await c.query('INSERT INTO workpivot.memory_sources(owner_user_id,memory_id,run_id) SELECT owner_user_id,$1,run_id FROM workpivot.memory_sources WHERE memory_id=ANY($2::uuid[]) ON CONFLICT DO NOTHING', [memoryId, mergedIds]);
        // Flatten prior merge ancestry so forgetting the current memory erases all retained versions.
        await c.query('UPDATE workpivot.memories SET merged_into=$1 WHERE merged_into=ANY($2::uuid[])', [memoryId, mergedIds]);
        await c.query('UPDATE workpivot.memories SET merged_into=$1,deleted_at=now() WHERE id=ANY($2::uuid[])', [memoryId, mergedIds]);
      }
      if (s.source_run_id) for (const runId of [s.source_run_id, ...(s.source_context as MemorySource[]).map(item => item.runId)]) await c.query('INSERT INTO workpivot.memory_sources(owner_user_id,memory_id,run_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [actor, memoryId, runId]);
      await c.query('UPDATE workpivot.knowledge_state SET epoch=epoch+1 WHERE owner_user_id=$1', [actor]);
      await c.query('INSERT INTO workpivot.outbox_events(id,owner_user_id,kind,entity_id,revision) VALUES($1,$2,$3,$4,$5)', [randomUUID(), actor, 'memory_updated', memoryId, revision]);
      await c.query("UPDATE workpivot.memory_suggestions SET status='accepted',content='',evidence=NULL WHERE id=$1", [id]);
      await c.query("UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE owner_user_id=$1 AND status='pending' AND (target_id=ANY($2::uuid[]) OR EXISTS (SELECT 1 FROM jsonb_to_recordset(merge_targets) AS mt(id uuid,revision integer) WHERE mt.id=ANY($2::uuid[])))", [actor, [memoryId, ...mergedIds]]);
      await c.query("UPDATE workpivot.memory_suggestions SET epoch=(SELECT epoch FROM workpivot.knowledge_state WHERE owner_user_id=$1) WHERE owner_user_id=$1 AND status='pending'", [actor]);
      return { status: 'accepted', memoryId };
    }, actor);
  }
  tool(actor: string, taskId: string, epoch: string): Tool {
    return { name: 'propose_memory', kind: 'read', description: '整理用户明确表达的长期事实或偏好，提交新增或修改记忆建议供用户确认。此工具不会直接保存为有效记忆，禁止把推测当事实；修改时必须提供read_memory返回的targetId和targetRevision，不支持删除建议。', parameters: { type: 'object', properties: { scope: { type: 'string', enum: ['user', 'project', 'task'] }, content: { type: 'string' }, targetId: { type: 'string' }, targetRevision: { type: 'integer', minimum: 1 } }, required: ['scope', 'content'], additionalProperties: false }, run: async (args, ctx) => { ctx.signal?.throwIfAborted(); if (typeof args['scope'] !== 'string' || typeof args['content'] !== 'string') throw new RepositoryError(400, '建议参数无效'); return JSON.stringify(await this.propose(actor, taskId, epoch, args['scope'], args['content'], args['targetId'] as string | undefined, args['targetRevision'] as number | undefined)); } };
  }
}
