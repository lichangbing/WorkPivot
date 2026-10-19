/** 旧全局个人记忆须由用户指定归属，禁止升级时猜测项目。 */
export const personalProjectSchema = `
ALTER TABLE workpivot.memories ADD COLUMN legacy_personal boolean NOT NULL DEFAULT false;
UPDATE workpivot.memories SET legacy_personal=true WHERE scope='user';
ALTER TABLE workpivot.memories DROP CONSTRAINT memories_check;
ALTER TABLE workpivot.memories ADD CONSTRAINT memories_check CHECK (
 (scope='user' AND task_id IS NULL) OR
 (scope='project' AND project_id IS NOT NULL AND task_id IS NULL) OR
 (scope='task' AND task_id IS NOT NULL AND project_id IS NULL));
ALTER TABLE workpivot.memory_analysis_batches ADD COLUMN legacy_personal boolean NOT NULL DEFAULT false;
UPDATE workpivot.memory_analysis_batches SET legacy_personal=true,status='stale',error='旧全局个人分析已停用',lease_until=NULL WHERE scope='user';
DELETE FROM workpivot.memory_analysis_turns WHERE scope='user' AND batch_id IS NULL;
UPDATE workpivot.task_runs SET memory_analysis_eligible=false;
UPDATE workpivot.memory_suggestions SET status='stale',content='',evidence=NULL WHERE scope='user' AND status='pending';
UPDATE workpivot.task_runs SET context_revoked=true,model_messages='[]'::jsonb WHERE owner_user_id IN(SELECT owner_user_id FROM workpivot.memories WHERE legacy_personal);
INSERT INTO workpivot.knowledge_state(owner_user_id,epoch) SELECT DISTINCT owner_user_id,1 FROM workpivot.memories WHERE legacy_personal ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1;
CREATE UNIQUE INDEX memory_analysis_turn_once ON workpivot.memory_analysis_turns(owner_user_id,scope,turn_id) WHERE scope='user';
`;
