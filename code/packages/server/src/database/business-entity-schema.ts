/**
 * 业务实体治理：实体合并只改变对象归属，不覆盖事实 revision。
 * 合并记录保存被移动的标识、事实系列和关系系列，支持用户再次确认后拆回。
 */
export const businessEntityGovernanceSchema = `
ALTER TABLE workpivot.business_object
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);

CREATE TABLE workpivot.business_object_merge (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  source_object_id uuid NOT NULL,
  target_object_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','reverted')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  source_object_revision integer NOT NULL CHECK(source_object_revision>0),
  target_object_revision integer NOT NULL CHECK(target_object_revision>0),
  identifier_ids uuid[] NOT NULL DEFAULT '{}',
  alias_ids uuid[] NOT NULL DEFAULT '{}',
  fact_series_ids uuid[] NOT NULL DEFAULT '{}',
  relation_series_ids uuid[] NOT NULL DEFAULT '{}',
  merged_at timestamptz NOT NULL DEFAULT now(),
  reverted_at timestamptz,
  reverted_by uuid REFERENCES identity.users(id),
  UNIQUE(project_id,id),
  CHECK(source_object_id<>target_object_id),
  FOREIGN KEY(project_id,source_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,target_object_id) REFERENCES workpivot.business_object(project_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX business_object_merge_one_active_source
  ON workpivot.business_object_merge(project_id,source_object_id)
  WHERE status='active';
CREATE INDEX business_object_merge_recent
  ON workpivot.business_object_merge(project_id,merged_at DESC);

CREATE TABLE workpivot.business_fact_import (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  project_id uuid NOT NULL REFERENCES workpivot.projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  version_id uuid NOT NULL REFERENCES workpivot.document_versions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  mapping jsonb NOT NULL CHECK(jsonb_typeof(mapping)='object'),
  candidates jsonb NOT NULL CHECK(jsonb_typeof(candidates)='array'),
  source_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(project_id,id),
  UNIQUE(version_id)
);

ALTER TABLE workpivot.business_fact_series
  ADD COLUMN merge_id uuid REFERENCES workpivot.business_object_merge(id) ON DELETE SET NULL,
  ADD COLUMN merged_from_object_id uuid;
ALTER TABLE workpivot.business_relation_series
  ADD COLUMN merge_id uuid REFERENCES workpivot.business_object_merge(id) ON DELETE SET NULL,
  ADD COLUMN merged_subject_from_object_id uuid,
  ADD COLUMN merged_object_from_object_id uuid;

ALTER TABLE workpivot.business_object_merge ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.business_object_merge FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_business_object_merge ON workpivot.business_object_merge
  USING(owner_user_id=workpivot.actor_id() AND EXISTS(
    SELECT 1 FROM workpivot.projects p
    WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL
  ))
  WITH CHECK(owner_user_id=workpivot.actor_id() AND EXISTS(
    SELECT 1 FROM workpivot.projects p
    WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL
  ));
ALTER TABLE workpivot.business_fact_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.business_fact_import FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_business_fact_import ON workpivot.business_fact_import
  USING(owner_user_id=workpivot.actor_id() AND EXISTS(
    SELECT 1 FROM workpivot.projects p
    WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL
  ))
  WITH CHECK(owner_user_id=workpivot.actor_id() AND EXISTS(
    SELECT 1 FROM workpivot.projects p
    WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id() AND p.deleted_at IS NULL
  ));

GRANT SELECT,INSERT,UPDATE,DELETE ON workpivot.business_object_merge TO workpivot_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON workpivot.business_fact_import TO workpivot_app;
`;
