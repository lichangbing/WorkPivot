/** 模型空间不可变，重建与当前可用索引并存；分片删除级联撤销作业。 */
export const embeddingSchema=`
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE TABLE workpivot.embedding_spaces (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 name text NOT NULL,base_url text NOT NULL,model_id text NOT NULL,model_version text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('ollama','openai')),dimensions integer NOT NULL CHECK(dimensions BETWEEN 1 AND 4096),secret jsonb,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','building','active','retired')),
 enabled boolean NOT NULL DEFAULT false,tested boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,owner_user_id,dimensions)
);
CREATE UNIQUE INDEX one_active_embedding ON workpivot.embedding_spaces(owner_user_id) WHERE state='active';
CREATE UNIQUE INDEX one_building_embedding ON workpivot.embedding_spaces(owner_user_id) WHERE state='building';
CREATE TABLE workpivot.embedding_jobs (
 space_id uuid NOT NULL,owner_user_id uuid NOT NULL,dimensions integer NOT NULL,
 chunk_id uuid NOT NULL REFERENCES workpivot.knowledge_chunks(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
 attempts integer NOT NULL DEFAULT 0,fence uuid,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now(),
 error text,embedding public.vector,PRIMARY KEY(space_id,chunk_id),
 FOREIGN KEY(space_id,owner_user_id,dimensions) REFERENCES workpivot.embedding_spaces(id,owner_user_id,dimensions) ON DELETE CASCADE,
 CHECK(embedding IS NULL OR public.vector_dims(embedding)=dimensions),
 CHECK((status='completed')=(embedding IS NOT NULL))
);
CREATE INDEX embedding_pending ON workpivot.embedding_jobs(space_id,status,next_attempt_at);
ALTER TABLE workpivot.embedding_spaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.embedding_spaces FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_embedding_spaces ON workpivot.embedding_spaces USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.embedding_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.embedding_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_embedding_jobs ON workpivot.embedding_jobs USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
`;
