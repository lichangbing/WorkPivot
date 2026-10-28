/**
 * 项目业务事实的权威结构。事实身份(series)与值版本(revision)分离，
 * 所有业务数据都携带 project_id，RLS 只负责用户隔离，服务层和复合外键继续校验项目边界。
 */
export const businessFactSchema = `
CREATE TABLE workpivot.business_project_profile (
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid PRIMARY KEY REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  model_key text NOT NULL CHECK(model_key IN ('project.delivery','company.operations')),
  model_version integer NOT NULL DEFAULT 1 CHECK(model_version>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workpivot.business_object (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  model_key text NOT NULL CHECK(model_key IN ('project.delivery','company.operations')),
  model_version integer NOT NULL DEFAULT 1 CHECK(model_version>0),
  object_type text NOT NULL CHECK(length(object_type) BETWEEN 1 AND 80 AND object_type ~ '^[a-z][a-z0-9_.-]*$'),
  canonical_name text NOT NULL CHECK(length(btrim(canonical_name)) BETWEEN 1 AND 500),
  name_key text NOT NULL CHECK(length(name_key) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','merged','forgotten')),
  merged_into_id uuid,
  created_by text NOT NULL DEFAULT 'user' CHECK(created_by IN ('user','auto','external')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,merged_into_id) REFERENCES workpivot.business_object(project_id,id)
);
CREATE INDEX business_object_name ON workpivot.business_object(project_id,object_type,name_key,status);

CREATE TABLE workpivot.business_object_identifier (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  namespace text NOT NULL DEFAULT 'local' CHECK(length(namespace) BETWEEN 1 AND 80),
  identifier_type text NOT NULL CHECK(length(identifier_type) BETWEEN 1 AND 80),
  identifier_value text NOT NULL CHECK(length(btrim(identifier_value)) BETWEEN 1 AND 500),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX business_object_identifier_active
  ON workpivot.business_object_identifier(project_id,namespace,identifier_type,lower(identifier_value))
  WHERE valid_to IS NULL;

CREATE TABLE workpivot.business_object_alias (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  object_id uuid NOT NULL,
  alias text NOT NULL CHECK(length(btrim(alias)) BETWEEN 1 AND 500),
  alias_key text NOT NULL CHECK(length(alias_key) BETWEEN 1 AND 500),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE
);
CREATE INDEX business_object_alias_lookup ON workpivot.business_object_alias(project_id,alias_key) WHERE valid_to IS NULL;

CREATE TABLE workpivot.business_fact_series (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  subject_object_id uuid NOT NULL,
  predicate text NOT NULL CHECK(length(predicate) BETWEEN 1 AND 160 AND predicate ~ '^[a-z][a-z0-9_.-]*$'),
  dimensions_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(dimensions_json)='object'),
  dimension_key text NOT NULL DEFAULT '',
  series_key text NOT NULL CHECK(length(series_key)=64),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','conflicted','forgotten')),
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,id),
  UNIQUE(project_id,series_key),
  FOREIGN KEY(project_id,subject_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE
);
CREATE INDEX business_fact_series_subject ON workpivot.business_fact_series(project_id,subject_object_id,predicate,status);

CREATE TABLE workpivot.business_fact_revision (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  value_type text NOT NULL CHECK(value_type IN ('text','number','date','boolean','object','json')),
  value_text text,
  value_number numeric,
  value_date timestamptz,
  value_boolean boolean,
  value_object_id uuid,
  value_json jsonb,
  unit text CHECK(unit IS NULL OR length(unit) BETWEEN 1 AND 40),
  currency char(3) CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  status text NOT NULL CHECK(status IN ('candidate','active','superseded','rejected','forgotten')),
  authority text NOT NULL CHECK(authority IN ('external','user','manual','auto','derived')),
  confidence numeric NOT NULL DEFAULT 1 CHECK(confidence>=0 AND confidence<=1),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  supersedes_revision_id uuid,
  model_key text NOT NULL,
  model_version integer NOT NULL CHECK(model_version>0),
  extractor_version text NOT NULL,
  created_by text NOT NULL CHECK(created_by IN ('user','auto','external')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(valid_to IS NULL OR valid_to>=valid_from),
  UNIQUE(project_id,id),
  UNIQUE(project_id,series_id,revision),
  FOREIGN KEY(project_id,series_id) REFERENCES workpivot.business_fact_series(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,value_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(project_id,supersedes_revision_id) REFERENCES workpivot.business_fact_revision(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX business_fact_one_active_revision
  ON workpivot.business_fact_revision(project_id,series_id) WHERE status='active';
CREATE INDEX business_fact_value_number ON workpivot.business_fact_revision(project_id,value_number) WHERE status='active' AND value_type='number';

CREATE TABLE workpivot.business_relation_series (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  subject_object_id uuid NOT NULL,
  relation_type text NOT NULL CHECK(length(relation_type) BETWEEN 1 AND 120 AND relation_type ~ '^[a-z][a-z0-9_.-]*$'),
  object_object_id uuid NOT NULL,
  relation_key text NOT NULL CHECK(length(relation_key)=64),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','conflicted','forgotten')),
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,id),
  UNIQUE(project_id,relation_key),
  CHECK(subject_object_id<>object_object_id),
  FOREIGN KEY(project_id,subject_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,object_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE
);
CREATE INDEX business_relation_subject ON workpivot.business_relation_series(project_id,subject_object_id,relation_type,status);
CREATE INDEX business_relation_object ON workpivot.business_relation_series(project_id,object_object_id,relation_type,status);

CREATE TABLE workpivot.business_relation_revision (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  status text NOT NULL CHECK(status IN ('candidate','active','superseded','rejected','forgotten')),
  authority text NOT NULL CHECK(authority IN ('external','user','manual','auto','derived')),
  confidence numeric NOT NULL DEFAULT 1 CHECK(confidence>=0 AND confidence<=1),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  supersedes_revision_id uuid,
  model_key text NOT NULL,
  model_version integer NOT NULL CHECK(model_version>0),
  extractor_version text NOT NULL,
  created_by text NOT NULL CHECK(created_by IN ('user','auto','external')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(valid_to IS NULL OR valid_to>=valid_from),
  UNIQUE(project_id,id),
  UNIQUE(project_id,series_id,revision),
  FOREIGN KEY(project_id,series_id) REFERENCES workpivot.business_relation_series(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,supersedes_revision_id) REFERENCES workpivot.business_relation_revision(project_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX business_relation_one_active_revision
  ON workpivot.business_relation_revision(project_id,series_id) WHERE status='active';

CREATE TABLE workpivot.business_fact_evidence (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  fact_revision_id uuid,
  relation_revision_id uuid,
  source_kind text NOT NULL CHECK(source_kind IN ('conversation','manual','document','external')),
  source_event_id uuid REFERENCES workpivot.conversation_events(id) ON DELETE SET NULL,
  source_document_version_id uuid REFERENCES workpivot.document_versions(id) ON DELETE SET NULL,
  quote text CHECK(quote IS NULL OR length(quote)<=4000),
  source_hash char(64),
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((fact_revision_id IS NOT NULL)::int+(relation_revision_id IS NOT NULL)::int=1),
  FOREIGN KEY(project_id,fact_revision_id) REFERENCES workpivot.business_fact_revision(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,relation_revision_id) REFERENCES workpivot.business_relation_revision(project_id,id) ON DELETE CASCADE
);
CREATE INDEX business_fact_evidence_fact ON workpivot.business_fact_evidence(project_id,fact_revision_id);
CREATE INDEX business_fact_evidence_relation ON workpivot.business_fact_evidence(project_id,relation_revision_id);

CREATE TABLE workpivot.business_fact_conflict (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  series_id uuid NOT NULL,
  current_revision_id uuid,
  candidate_revision_id uuid NOT NULL,
  conflict_type text NOT NULL DEFAULT 'value_changed' CHECK(conflict_type IN ('value_changed','source_conflict','entity_ambiguous')),
  reason text CHECK(reason IS NULL OR length(reason)<=2000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,series_id) REFERENCES workpivot.business_fact_series(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,current_revision_id) REFERENCES workpivot.business_fact_revision(project_id,id) ON DELETE SET NULL,
  FOREIGN KEY(project_id,candidate_revision_id) REFERENCES workpivot.business_fact_revision(project_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX business_fact_one_pending_conflict
  ON workpivot.business_fact_conflict(project_id,series_id) WHERE status='pending';

CREATE TABLE workpivot.business_fact_job (
  run_id uuid PRIMARY KEY REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  task_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX business_fact_job_queue ON workpivot.business_fact_job(owner_user_id,created_at) WHERE status IN ('pending','running');

CREATE TABLE workpivot.business_fact_epoch (
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,project_id)
);

CREATE FUNCTION workpivot.bump_business_fact_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_owner uuid;
  target_project uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    target_owner:=OLD.owner_user_id;
    target_project:=OLD.project_id;
  ELSE
    target_owner:=NEW.owner_user_id;
    target_project:=NEW.project_id;
  END IF;
  INSERT INTO workpivot.business_fact_epoch(owner_user_id,project_id,revision)
  VALUES(target_owner,target_project,1)
  ON CONFLICT(owner_user_id,project_id) DO UPDATE
    SET revision=workpivot.business_fact_epoch.revision+1,updated_at=now();
  PERFORM pg_notify('workpivot_business_facts',target_project::text);
  RETURN NULL;
END $$;
CREATE TRIGGER bump_business_fact_epoch_fact AFTER INSERT OR UPDATE OR DELETE
  ON workpivot.business_fact_revision FOR EACH ROW EXECUTE FUNCTION workpivot.bump_business_fact_epoch();
CREATE TRIGGER bump_business_fact_epoch_relation AFTER INSERT OR UPDATE OR DELETE
  ON workpivot.business_relation_revision FOR EACH ROW EXECUTE FUNCTION workpivot.bump_business_fact_epoch();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'business_project_profile','business_object','business_object_identifier','business_object_alias',
    'business_fact_series','business_fact_revision','business_relation_series','business_relation_revision',
    'business_fact_evidence','business_fact_conflict','business_fact_job','business_fact_epoch'
  ] LOOP
    EXECUTE format('ALTER TABLE workpivot.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE workpivot.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format(
      'CREATE POLICY personal_scope ON workpivot.%I USING(owner_user_id=workpivot.actor_id() AND EXISTS(SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL)) WITH CHECK(owner_user_id=workpivot.actor_id() AND EXISTS(SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL))',
      table_name
    );
  END LOOP;
END $$;
`;
