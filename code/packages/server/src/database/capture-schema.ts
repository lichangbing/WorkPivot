/** 采集数据归属计划，随计划永久删除；审计元数据不携带正文或URL。 */
export const captureSchema=`
CREATE TABLE workpivot.capture_sources (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 plan_id uuid NOT NULL REFERENCES workpivot.automations(id) ON DELETE CASCADE,
 source_key text NOT NULL,revision integer NOT NULL DEFAULT 0,current_version uuid,content_hash text,
 UNIQUE(plan_id,source_key)
);
CREATE TABLE workpivot.capture_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 source_id uuid NOT NULL REFERENCES workpivot.capture_sources(id) ON DELETE CASCADE,
 revision integer NOT NULL,content_hash text NOT NULL,content jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(source_id,revision)
);
CREATE TABLE workpivot.capture_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 run_id uuid NOT NULL REFERENCES workpivot.automation_runs(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES workpivot.capture_versions(id) ON DELETE CASCADE,
 request_key text NOT NULL,changed boolean NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(run_id,request_key)
);
CREATE TABLE workpivot.capture_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,actor_id uuid NOT NULL,
 plan_id uuid NOT NULL,version_id uuid,run_id uuid,
 action text NOT NULL CHECK(action IN ('new_version','unchanged','view','recycle','restore','purge')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX capture_observation_run ON workpivot.capture_observations(run_id);
CREATE INDEX capture_audit_owner ON workpivot.capture_audit(owner_user_id,created_at DESC,id DESC);
${['capture_sources','capture_versions','capture_observations','capture_audit'].map(t=>`ALTER TABLE workpivot.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY capture_owner ON workpivot.${t} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());`).join('\n')}
CREATE TRIGGER capture_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.capture_audit FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
`;
