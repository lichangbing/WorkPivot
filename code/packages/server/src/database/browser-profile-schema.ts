export const browserProfileSchema=`
CREATE TABLE workpivot.browser_profiles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,name text NOT NULL,
 login_url text NOT NULL,urls jsonb NOT NULL,network_grant_ids jsonb NOT NULL DEFAULT '[]',state_cipher jsonb,
 revision integer NOT NULL DEFAULT 1,revoked_at timestamptz,lease_id uuid,lease_kind text CHECK(lease_kind IN ('manual','automation')),
 lease_until timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE workpivot.browser_profile_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,profile_id uuid NOT NULL,actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','open','allow_url','save','cancel','revoke','lease','release','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
${['browser_profiles','browser_profile_audit'].map(t=>`ALTER TABLE workpivot.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_profile_owner ON workpivot.${t} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());`).join('\n')}
CREATE TRIGGER browser_profile_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.browser_profile_audit FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
ALTER TABLE workpivot.automation_runs DROP CONSTRAINT automation_runs_status_check;
ALTER TABLE workpivot.automation_runs ADD CONSTRAINT automation_runs_status_check CHECK(status IN ('queued','waiting_login','running','completed','failed','interrupted','cancelled'));
ALTER TABLE workpivot.automation_runs ADD COLUMN login_deadline timestamptz;
DROP INDEX workpivot.automation_queued_plan;
CREATE UNIQUE INDEX automation_queued_plan ON workpivot.automation_runs(plan_id) WHERE status IN ('queued','waiting_login');
CREATE FUNCTION workpivot.sync_waiting_login_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='waiting_login' AND NEW.status IN ('cancelled','failed','interrupted') AND NEW.task_id IS NOT NULL THEN
  UPDATE workpivot.tasks SET status=CASE WHEN NEW.status='cancelled' THEN 'stopped' ELSE 'failed' END WHERE id=NEW.task_id AND status='waiting';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_waiting_login_task AFTER UPDATE OF status ON workpivot.automation_runs FOR EACH ROW EXECUTE FUNCTION workpivot.sync_waiting_login_task();
CREATE OR REPLACE FUNCTION workpivot.automation_source_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  UPDATE workpivot.automations SET source_invalid=true,draft=NULL,revision=revision+1 WHERE source_task_id=OLD.id AND draft IS NOT NULL;
  UPDATE workpivot.automation_runs SET revoked=true,status=CASE WHEN status IN ('queued','waiting_login') THEN 'cancelled' ELSE status END WHERE task_id=OLD.id AND status IN ('queued','waiting_login','running');
 ELSE
  UPDATE workpivot.automations SET source_invalid=true,draft=NULL,revision=revision+1 WHERE source_run_id=OLD.id AND draft IS NOT NULL;
 END IF;
 RETURN OLD;
END $$;
`;
