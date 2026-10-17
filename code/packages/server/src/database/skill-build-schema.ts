/** 私人技能沿用现有包与版本身份；历史公共技能保持原可见性。 */
export const skillBuildSchema = `
ALTER TABLE workpivot.skill_drafts ADD COLUMN skill_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE;
ALTER TABLE workpivot.skill_drafts ADD COLUMN display_name text NOT NULL DEFAULT '';
ALTER TABLE workpivot.skill_drafts ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private'));
ALTER TABLE workpivot.skill_drafts ADD COLUMN deleted_at timestamptz;
UPDATE workpivot.skill_drafts SET display_name=name;
ALTER TABLE workpivot.skill_releases ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private'));
ALTER TABLE workpivot.skill_catalog ADD COLUMN visibility text NOT NULL DEFAULT 'public' CHECK(visibility IN ('public','private'));
ALTER TABLE workpivot.skill_catalog ADD COLUMN display_name text NOT NULL DEFAULT '';
UPDATE workpivot.skill_catalog SET display_name=name;
ALTER POLICY published_read ON workpivot.skill_releases USING(visibility='public' OR owner_user_id=workpivot.actor_id());
ALTER POLICY catalog_read ON workpivot.skill_catalog USING(visibility='public' OR owner_user_id=workpivot.actor_id());
CREATE TABLE workpivot.skill_builds (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,
 name text NOT NULL REFERENCES workpivot.skill_drafts(name) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES workpivot.tasks(id) ON DELETE CASCADE,
 source_run_id uuid REFERENCES workpivot.task_runs(id) ON DELETE SET NULL,
 source_epoch bigint NOT NULL DEFAULT 0,source_invalid boolean NOT NULL DEFAULT false,request_id uuid NOT NULL,
 revision uuid NOT NULL,content_hash text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','activated','cancelled','stale')),
 purpose text NOT NULL,permissions text NOT NULL DEFAULT '离线沙箱；仅显式选择的测试输入；不联网、不外发、不覆盖业务文件',
 validation jsonb,trial jsonb,trial_attempts integer NOT NULL DEFAULT 0,revision_attempts integer NOT NULL DEFAULT 0,
 dismissed boolean NOT NULL DEFAULT false,release_id uuid REFERENCES workpivot.skill_releases(id),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(owner_user_id,request_id)
);
CREATE TABLE workpivot.skill_trials (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,
 build_id uuid NOT NULL REFERENCES workpivot.skill_builds(id) ON DELETE CASCADE,
 revision uuid NOT NULL,content_hash text NOT NULL,command text NOT NULL,
 input_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','passed','failed','interrupted')),
 report jsonb,lease_until timestamptz NOT NULL DEFAULT now()+interval '150 seconds',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workpivot.skill_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_builds FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_build ON workpivot.skill_builds USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.skill_trials ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_trials FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_trial ON workpivot.skill_trials USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE UNIQUE INDEX skill_trial_running ON workpivot.skill_trials(owner_user_id) WHERE status='running';
CREATE INDEX skill_build_task ON workpivot.skill_builds(task_id,created_at);
CREATE FUNCTION workpivot.skill_visibility_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM workpivot.skill_drafts d WHERE d.name=NEW.name AND d.owner_user_id=NEW.owner_user_id AND d.visibility=NEW.visibility AND d.deleted_at IS NULL) THEN
  RAISE EXCEPTION '技能身份或可见性不匹配';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_visibility BEFORE INSERT ON workpivot.skill_releases FOR EACH ROW EXECUTE FUNCTION workpivot.skill_visibility_guard();
CREATE TRIGGER catalog_visibility BEFORE INSERT OR UPDATE OF visibility,release_id ON workpivot.skill_catalog FOR EACH ROW EXECUTE FUNCTION workpivot.skill_visibility_guard();
CREATE FUNCTION workpivot.invalidate_skill_builds() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid[]; names text[];
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  SELECT array_agg(id),array_agg(name) INTO affected,names FROM workpivot.skill_builds WHERE task_id=OLD.id AND status<>'cancelled';
 ELSIF TG_TABLE_NAME='task_runs' THEN
  SELECT array_agg(id),array_agg(name) INTO affected,names FROM workpivot.skill_builds WHERE source_run_id=OLD.id AND status<>'cancelled';
 ELSE
  SELECT array_agg(id),array_agg(name) INTO affected,names FROM workpivot.skill_builds WHERE task_id=OLD.task_id AND status<>'cancelled';
 END IF;
 UPDATE workpivot.skill_builds SET status='stale',source_invalid=true,validation=NULL,trial=NULL WHERE id=ANY(affected);
 UPDATE workpivot.skill_drafts SET disabled=true WHERE name=ANY(names);
 UPDATE workpivot.skill_catalog SET disabled=true WHERE name=ANY(names);
 IF TG_OP='DELETE' AND TG_TABLE_NAME='task_runs' THEN RETURN OLD; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER skill_source_task AFTER UPDATE OF deleted_at ON workpivot.tasks FOR EACH ROW WHEN(NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION workpivot.invalidate_skill_builds();
CREATE TRIGGER skill_source_run AFTER UPDATE OF context_revoked ON workpivot.task_runs FOR EACH ROW WHEN(NEW.context_revoked) EXECUTE FUNCTION workpivot.invalidate_skill_builds();
CREATE TRIGGER skill_source_run_delete BEFORE DELETE ON workpivot.task_runs FOR EACH ROW EXECUTE FUNCTION workpivot.invalidate_skill_builds();
CREATE TRIGGER skill_source_event AFTER UPDATE OF content OR DELETE ON workpivot.conversation_events FOR EACH ROW EXECUTE FUNCTION workpivot.invalidate_skill_builds();
`;
