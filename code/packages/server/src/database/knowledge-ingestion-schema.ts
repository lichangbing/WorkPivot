/**
 * 项目知识入库必须由用户按文件版本确认。
 * 迁移会清除旧版本自动生成的知识分片，避免历史自动索引被误认为已获用户授权。
 */
export const knowledgeIngestionSchema = `
ALTER TABLE workpivot.memories ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE workpivot.business_fact_series ADD COLUMN needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE workpivot.business_relation_series ADD COLUMN needs_review boolean NOT NULL DEFAULT false;

CREATE TABLE workpivot.knowledge_ingestions (
  version_id uuid PRIMARY KEY REFERENCES workpivot.document_versions(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','confirmed','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  parser_fingerprint text NOT NULL,
  selected_ordinals integer[] NOT NULL DEFAULT '{}',
  excluded jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(excluded)='array'),
  decision_note text CHECK(decision_note IS NULL OR length(decision_note)<=1000),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(cardinality(selected_ordinals)<=20000)
);
ALTER TABLE workpivot.knowledge_ingestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.knowledge_ingestions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_knowledge_ingestions ON workpivot.knowledge_ingestions
  USING(owner_user_id=workpivot.actor_id())
  WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE INDEX knowledge_ingestions_pending
  ON workpivot.knowledge_ingestions(owner_user_id,created_at)
  WHERE status='pending';

-- 既有分片没有逐版本用户确认记录，不能继承为已确认内容。
WITH removed AS (
  DELETE FROM workpivot.knowledge_versions RETURNING owner_user_id
)
INSERT INTO workpivot.knowledge_state(owner_user_id,epoch)
SELECT DISTINCT owner_user_id,1 FROM removed
ON CONFLICT(owner_user_id) DO UPDATE SET epoch=workpivot.knowledge_state.epoch+1;

INSERT INTO workpivot.knowledge_ingestions(
  version_id,owner_user_id,status,revision,parser_fingerprint
)
SELECT p.version_id,p.owner_user_id,'pending',1,p.parser_fingerprint
FROM workpivot.document_processing p
JOIN workpivot.document_versions v ON v.id=p.version_id
JOIN workpivot.documents d ON d.id=v.document_id
JOIN workpivot.tasks t ON t.id=d.task_id
WHERE d.purpose='upload'
  AND t.project_id IS NOT NULL
  AND p.status='completed'
  AND p.parser_fingerprint IS NOT NULL
ON CONFLICT(version_id) DO NOTHING;

CREATE FUNCTION workpivot.mark_deleted_version_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  affected_runs uuid[];
BEGIN
  SELECT COALESCE(array_agg(r.id),'{}') INTO affected_runs
  FROM workpivot.task_runs r
  WHERE OLD.id=ANY(r.attachment_ids);

  IF cardinality(affected_runs)>0 THEN
    UPDATE workpivot.memories m
    SET needs_review=true
    WHERE m.deleted_at IS NULL
      AND NOT m.needs_review
      AND EXISTS(
        SELECT 1 FROM workpivot.memory_sources ms
        WHERE ms.memory_id=m.id AND ms.run_id=ANY(affected_runs)
      )
      AND NOT EXISTS(
        SELECT 1
        FROM workpivot.memory_sources other
        LEFT JOIN workpivot.task_runs r ON r.id=other.run_id
        WHERE other.memory_id=m.id
          AND NOT (other.run_id=ANY(affected_runs))
          AND NOT COALESCE(r.context_revoked,false)
      );
  END IF;

  UPDATE workpivot.business_fact_series s
  SET needs_review=true,updated_at=now()
  WHERE s.current_revision_id IN(
    SELECT e.fact_revision_id
    FROM workpivot.business_fact_evidence e
    WHERE e.source_document_version_id=OLD.id
  )
  AND NOT EXISTS(
    SELECT 1
    FROM workpivot.business_fact_evidence other
    WHERE other.fact_revision_id=s.current_revision_id
      AND other.source_document_version_id IS DISTINCT FROM OLD.id
  );
  INSERT INTO workpivot.business_fact_epoch(owner_user_id,project_id,revision)
  SELECT DISTINCT s.owner_user_id,s.project_id,1
  FROM workpivot.business_fact_series s
  JOIN workpivot.business_fact_evidence e ON e.fact_revision_id=s.current_revision_id
  WHERE e.source_document_version_id=OLD.id
  ON CONFLICT(owner_user_id,project_id) DO UPDATE
    SET revision=workpivot.business_fact_epoch.revision+1,updated_at=now();
  PERFORM pg_notify('workpivot_business_facts',notification.project_id::text)
  FROM (
    SELECT DISTINCT s.project_id
    FROM workpivot.business_fact_series s
    JOIN workpivot.business_fact_evidence e ON e.fact_revision_id=s.current_revision_id
    WHERE e.source_document_version_id=OLD.id
  ) notification;

  UPDATE workpivot.business_relation_series s
  SET needs_review=true,updated_at=now()
  WHERE s.current_revision_id IN(
    SELECT e.relation_revision_id
    FROM workpivot.business_fact_evidence e
    WHERE e.source_document_version_id=OLD.id
  )
  AND NOT EXISTS(
    SELECT 1
    FROM workpivot.business_fact_evidence other
    WHERE other.relation_revision_id=s.current_revision_id
      AND other.source_document_version_id IS DISTINCT FROM OLD.id
  );
  INSERT INTO workpivot.business_fact_epoch(owner_user_id,project_id,revision)
  SELECT DISTINCT s.owner_user_id,s.project_id,1
  FROM workpivot.business_relation_series s
  JOIN workpivot.business_fact_evidence e ON e.relation_revision_id=s.current_revision_id
  WHERE e.source_document_version_id=OLD.id
  ON CONFLICT(owner_user_id,project_id) DO UPDATE
    SET revision=workpivot.business_fact_epoch.revision+1,updated_at=now();
  PERFORM pg_notify('workpivot_business_facts',notification.project_id::text)
  FROM (
    SELECT DISTINCT s.project_id
    FROM workpivot.business_relation_series s
    JOIN workpivot.business_fact_evidence e ON e.relation_revision_id=s.current_revision_id
    WHERE e.source_document_version_id=OLD.id
  ) notification;
  RETURN OLD;
END $$;
CREATE TRIGGER review_sources_before_version_delete
BEFORE DELETE ON workpivot.document_versions
FOR EACH ROW EXECUTE FUNCTION workpivot.mark_deleted_version_sources();
`;
