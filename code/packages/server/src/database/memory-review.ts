import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { RepositoryError, uuid } from './connection.js';

export const memoryReviewSchema = `
ALTER TABLE workpivot.memory_suggestions ADD COLUMN dedupe_hash text;
ALTER TABLE workpivot.memory_suggestions ADD COLUMN review_key text CHECK(length(review_key)<=300);
ALTER TABLE workpivot.memory_suggestions ADD COLUMN replaces uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE workpivot.memory_suggestions ADD COLUMN replaced_by uuid;
CREATE INDEX memory_rejected_dedupe ON workpivot.memory_suggestions(owner_user_id,task_id,scope,dedupe_hash) WHERE status='rejected';
CREATE FUNCTION workpivot.clear_memory_review_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='memory_suggestions' THEN
  IF NEW.status NOT IN ('pending','rejected') THEN NEW.review_key=NULL; END IF;
  RETURN NEW;
 END IF;
 UPDATE workpivot.memory_suggestions SET review_key=NULL WHERE source_run_id=NEW.id;
 RETURN NULL;
END $$;
CREATE TRIGGER memory_review_key BEFORE UPDATE OF status ON workpivot.memory_suggestions FOR EACH ROW EXECUTE FUNCTION workpivot.clear_memory_review_key();
CREATE TRIGGER memory_review_source AFTER UPDATE OF context_revoked ON workpivot.task_runs FOR EACH ROW WHEN(NEW.context_revoked) EXECUTE FUNCTION workpivot.clear_memory_review_key();
`;


export interface ProposalReview { dedupeKey?: string; replaces?: string[] }
export function rejectionHash(actor: string, taskId: string, scope: string, key?: string) {
  if (key === undefined) return null;
  if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new RepositoryError(400, '记忆去重标识无效');
  return createHash('sha256').update(JSON.stringify([actor, taskId, scope, key.normalize('NFKC').toLowerCase().replace(/\s+/g, '')])).digest('hex');
}

/** 持有任务锁时调用；迟到模型结果不能替换更新的用户决定。 */
export async function validateReplacements(c: PoolClient, taskId: string, scope: string, epoch: string, runId: string | undefined,
  ids: string[], targetId?: string, targetRevision?: number, mergeTargets: { id: string; revision: number }[] = [], contextRunIds: string[] = []) {
  if (!Array.isArray(ids) || ids.length > 10 || new Set(ids).size !== ids.length) throw new RepositoryError(400, '替代建议无效');
  if (!ids.length) return;
  if (!runId) throw new RepositoryError(400, '替代建议需要本轮来源');
  const current = (await c.query('SELECT t.sequence FROM workpivot.task_runs r JOIN workpivot.conversation_turns t ON t.id=r.turn_id WHERE r.id=$1 AND r.task_id=$2', [runId, taskId])).rows[0];
  for (const id of [...ids].sort()) {
    uuid(id);
    const s = (await c.query(`SELECT s.*,t.sequence FROM workpivot.memory_suggestions s
      JOIN workpivot.task_runs r ON r.id=s.source_run_id AND NOT r.context_revoked
      JOIN workpivot.conversation_turns t ON t.id=r.turn_id WHERE s.id=$1 FOR UPDATE OF s`, [id])).rows[0];
    if (!current || !s || s.task_id !== taskId || s.scope !== scope || s.status !== 'pending' || String(s.epoch) !== epoch || BigInt(s.sequence) >= BigInt(current.sequence)) throw new RepositoryError(409, '待替代建议已变化，请重新整理');
    if (![s.source_run_id, ...s.source_context.map((item: { runId: string }) => item.runId)].every(id => contextRunIds.includes(id))) throw new RepositoryError(409, '替代建议缺少完整来源');
    if ((s.target_id ?? undefined) !== targetId || (s.target_revision ?? undefined) !== targetRevision || JSON.stringify(s.merge_targets) !== JSON.stringify(mergeTargets)) throw new RepositoryError(409, '替代建议的目标记忆不一致');
  }
}
