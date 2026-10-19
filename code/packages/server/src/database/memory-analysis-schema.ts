/** 新周期从升级后的对话开始；只保存来源标识，不复制聊天正文。 */
export const memoryAnalysisSchema = `
ALTER TABLE workpivot.task_runs ADD COLUMN memory_analysis_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE workpivot.task_runs ALTER COLUMN memory_analysis_eligible SET DEFAULT true;
CREATE INDEX memory_analysis_runs ON workpivot.task_runs(owner_user_id,turn_id) WHERE memory_analysis_eligible AND status='completed' AND NOT context_revoked;
CREATE TABLE workpivot.memory_analysis_batches (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('user','project')),scope_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','stale')),
 attempts integer NOT NULL DEFAULT 0,fence uuid,lease_until timestamptz,error text,
 created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 UNIQUE(owner_user_id,id)
);
CREATE TABLE workpivot.memory_analysis_turns (
 owner_user_id uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('user','project')),scope_id uuid NOT NULL,
 turn_id uuid NOT NULL REFERENCES workpivot.conversation_turns(id) ON DELETE CASCADE,
 run_id uuid NOT NULL REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,
 batch_id uuid REFERENCES workpivot.memory_analysis_batches(id),counted_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,scope,scope_id,turn_id)
);
CREATE INDEX memory_analysis_queue ON workpivot.memory_analysis_turns(owner_user_id,scope,scope_id,counted_at) WHERE batch_id IS NULL;
ALTER TABLE workpivot.memory_suggestions ADD COLUMN analysis_reason text;
ALTER TABLE workpivot.memory_suggestions ADD COLUMN analysis_id uuid REFERENCES workpivot.memory_analysis_batches(id);
CREATE FUNCTION workpivot.clear_analysis_reason() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.status<>'pending' THEN NEW.analysis_reason=NULL; END IF; RETURN NEW; END $$;
CREATE TRIGGER clear_analysis_reason BEFORE UPDATE OF status ON workpivot.memory_suggestions FOR EACH ROW EXECUTE FUNCTION workpivot.clear_analysis_reason();
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['memory_analysis_batches','memory_analysis_turns'] LOOP
 EXECUTE format('ALTER TABLE workpivot.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE workpivot.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY personal_scope ON workpivot.%I USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id())',n);
END LOOP; END $$;
`;
