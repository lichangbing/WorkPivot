export const expertSchema = `
CREATE TABLE workpivot.experts (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,name text NOT NULL,public boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,settings jsonb NOT NULL,versions jsonb NOT NULL DEFAULT '[]',
 published integer,disabled boolean NOT NULL DEFAULT false,load_enabled boolean NOT NULL DEFAULT true,update_enabled boolean NOT NULL DEFAULT true,
 template_id uuid,template_revision integer,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workpivot.experts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.experts FORCE ROW LEVEL SECURITY;
CREATE POLICY experts_read ON workpivot.experts FOR SELECT USING(public OR owner_user_id=workpivot.actor_id());
CREATE POLICY experts_write ON workpivot.experts FOR ALL USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.projects ADD COLUMN expert_id uuid REFERENCES workpivot.experts(id) ON DELETE SET NULL;
ALTER TABLE workpivot.tasks ADD COLUMN expert_id uuid REFERENCES workpivot.experts(id) ON DELETE SET NULL;
ALTER TABLE workpivot.task_runs ADD COLUMN expert_snapshot jsonb;
CREATE TABLE workpivot.expert_experiences (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,expert_id uuid NOT NULL REFERENCES workpivot.experts(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1,content text NOT NULL,conditions text NOT NULL DEFAULT '',locked boolean NOT NULL DEFAULT false,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted','stale')),history jsonb NOT NULL DEFAULT '[]',
 source_runs uuid[] NOT NULL DEFAULT '{}',source_files uuid[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workpivot.expert_jobs (
 run_id uuid PRIMARY KEY REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,owner_user_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES workpivot.tasks(id),
 expert_id uuid NOT NULL REFERENCES workpivot.experts(id) ON DELETE CASCADE,epoch bigint NOT NULL,
 status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,lease_until timestamptz,error text
);
CREATE TABLE workpivot.expert_suggestions (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,expert_id uuid NOT NULL REFERENCES workpivot.experts(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES workpivot.tasks(id),run_id uuid NOT NULL REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,
 content text NOT NULL,conditions text NOT NULL DEFAULT '',evidence text NOT NULL,targets jsonb NOT NULL DEFAULT '[]',epoch bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending',revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['expert_experiences','expert_jobs','expert_suggestions'] LOOP
  EXECUTE format('ALTER TABLE workpivot.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE workpivot.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY personal ON workpivot.%I USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id())',t);
 END LOOP;
END $$;
CREATE FUNCTION workpivot.expert_source_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='document_versions' THEN
  UPDATE workpivot.expert_experiences SET state='stale',content='',conditions='',history='[]',revision=revision+1 WHERE OLD.id=ANY(source_files) AND state='active';
 ELSE
  UPDATE workpivot.expert_experiences SET state='stale',content='',conditions='',history='[]',revision=revision+1 WHERE OLD.id=ANY(source_runs) AND state='active';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER expert_file_delete BEFORE DELETE ON workpivot.document_versions FOR EACH ROW EXECUTE FUNCTION workpivot.expert_source_deleted();
CREATE TRIGGER expert_run_delete BEFORE DELETE ON workpivot.task_runs FOR EACH ROW EXECUTE FUNCTION workpivot.expert_source_deleted();
CREATE TRIGGER expert_suggestion_notify AFTER INSERT OR UPDATE OR DELETE ON workpivot.expert_suggestions FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();
CREATE FUNCTION workpivot.expert_epoch_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE workpivot.expert_suggestions SET state='stale',content='',conditions='',evidence='',targets='[]',revision=revision+1 WHERE owner_user_id=NEW.owner_user_id AND state<>'stale';
 UPDATE workpivot.expert_jobs SET status='stale',error=NULL WHERE owner_user_id=NEW.owner_user_id AND status IN ('pending','running');
 UPDATE workpivot.task_runs SET expert_snapshot=NULL WHERE owner_user_id=NEW.owner_user_id AND context_revoked;
 RETURN NULL;
END $$;
CREATE TRIGGER expert_epoch AFTER INSERT OR UPDATE OF epoch ON workpivot.knowledge_state FOR EACH ROW EXECUTE FUNCTION workpivot.expert_epoch_changed();
`;
