/** 持久计划、授权快照和运行队列均受所有者 RLS 限制。 */
export const automationSchema=`
ALTER TABLE workpivot.tasks ADD COLUMN origin text NOT NULL DEFAULT 'chat' CHECK(origin IN ('chat','automation'));
CREATE TABLE workpivot.automations (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','enabled','paused','blocked','ended','deleted')),
 config jsonb,draft jsonb,grant_id uuid,request_id uuid NOT NULL,
 origin text NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','conversation')),
 source_task_id uuid REFERENCES workpivot.tasks(id) ON DELETE SET NULL,
 source_run_id uuid REFERENCES workpivot.task_runs(id) ON DELETE SET NULL,
 source_invalid boolean NOT NULL DEFAULT false,
 next_at timestamptz,issue text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_user_id,request_id)
);
CREATE TABLE workpivot.automation_runs (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,plan_id uuid NOT NULL REFERENCES workpivot.automations(id) ON DELETE CASCADE,
 task_id uuid REFERENCES workpivot.tasks(id) ON DELETE SET NULL,
 config jsonb NOT NULL,grant_id uuid NOT NULL,plan_revision integer NOT NULL,
 scheduled_for timestamptz NOT NULL,request_id uuid,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','interrupted','cancelled')),
 inputs jsonb NOT NULL DEFAULT '[]',fence uuid,lease_until timestamptz,revoked boolean NOT NULL DEFAULT false,
 error text NOT NULL DEFAULT '',summary text NOT NULL DEFAULT '',events jsonb NOT NULL DEFAULT '[]',
 model jsonb,started_at timestamptz,finished_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(plan_id,scheduled_for),UNIQUE(owner_user_id,request_id)
);
CREATE UNIQUE INDEX automation_running_owner ON workpivot.automation_runs(owner_user_id) WHERE status='running';
CREATE UNIQUE INDEX automation_running_plan ON workpivot.automation_runs(plan_id) WHERE status='running';
CREATE UNIQUE INDEX automation_queued_plan ON workpivot.automation_runs(plan_id) WHERE status='queued';
CREATE INDEX automation_due ON workpivot.automations(next_at) WHERE state='enabled';
CREATE INDEX automation_history ON workpivot.automation_runs(plan_id,scheduled_for DESC);
CREATE TABLE workpivot.automation_notices (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 plan_id uuid NOT NULL REFERENCES workpivot.automations(id) ON DELETE CASCADE,
 run_id uuid REFERENCES workpivot.automation_runs(id) ON DELETE CASCADE,
 notice_key text NOT NULL,message text NOT NULL,read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,notice_key)
);
${['automations','automation_runs','automation_notices'].map(t=>`ALTER TABLE workpivot.${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE workpivot.${t} FORCE ROW LEVEL SECURITY; CREATE POLICY personal_automation ON workpivot.${t} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());`).join('\n')}
CREATE FUNCTION workpivot.automation_source_invalidated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  UPDATE workpivot.automations SET source_invalid=true,draft=NULL,revision=revision+1 WHERE source_task_id=OLD.id AND draft IS NOT NULL;
  UPDATE workpivot.automation_runs SET revoked=true WHERE task_id=OLD.id AND status IN ('queued','running');
 ELSE
  UPDATE workpivot.automations SET source_invalid=true,draft=NULL,revision=revision+1 WHERE source_run_id=OLD.id AND draft IS NOT NULL;
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER automation_source_task AFTER UPDATE OF deleted_at ON workpivot.tasks FOR EACH ROW WHEN(NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION workpivot.automation_source_invalidated();
CREATE TRIGGER automation_source_run BEFORE DELETE ON workpivot.task_runs FOR EACH ROW EXECUTE FUNCTION workpivot.automation_source_invalidated();
CREATE TRIGGER automation_source_revoked AFTER UPDATE OF context_revoked ON workpivot.task_runs FOR EACH ROW WHEN(NEW.context_revoked) EXECUTE FUNCTION workpivot.automation_source_invalidated();
`;
