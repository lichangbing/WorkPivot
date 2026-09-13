/** Versioned fresh-database schema. No legacy filesystem import. */
export const schemaVersion = 1;
export const schemaSql = `
CREATE SCHEMA identity;
CREATE SCHEMA workpivot;
REVOKE ALL ON SCHEMA identity, workpivot FROM PUBLIC;
CREATE TABLE identity.users (
 id uuid PRIMARY KEY, username text NOT NULL, username_key text NOT NULL UNIQUE,
 role text NOT NULL CHECK(role IN ('admin','member')), platform_admin boolean NOT NULL DEFAULT false,
 disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (NOT platform_admin OR role='admin')
);
CREATE UNIQUE INDEX one_platform_admin ON identity.users(platform_admin) WHERE platform_admin;
CREATE TABLE identity.credentials (
 user_id uuid PRIMARY KEY REFERENCES identity.users(id), password_hash text NOT NULL,
 must_change boolean NOT NULL DEFAULT false, auth_version integer NOT NULL DEFAULT 1
);
CREATE TABLE identity.sessions (
 token_digest char(64) PRIMARY KEY, user_id uuid NOT NULL REFERENCES identity.users(id),
 auth_version integer NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON identity.sessions(user_id);
CREATE TABLE identity.audit_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES identity.users(id),
 target_id uuid REFERENCES identity.users(id), action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION workpivot.actor_id() RETURNS uuid LANGUAGE sql STABLE AS
 $$ SELECT NULLIF(current_setting('workpivot.user_id',true),'')::uuid $$;
CREATE TABLE workpivot.projects (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120), workspace_key text NOT NULL UNIQUE,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), deleted_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workpivot.project_members (
 project_id uuid NOT NULL REFERENCES workpivot.projects(id), user_id uuid NOT NULL REFERENCES identity.users(id),
 role text NOT NULL CHECK(role IN ('owner','editor','reader')), revoked_at timestamptz,
 PRIMARY KEY(project_id,user_id)
);
-- Personal first release: no invitation or member-driven access yet. Project data is not tied to its creator by FK.
CREATE TABLE workpivot.tasks (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 project_id uuid REFERENCES workpivot.projects(id), name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','queued','running','waiting','failed','interrupted','stopped')),
 revision integer NOT NULL DEFAULT 1, next_sequence bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, UNIQUE(owner_user_id,id)
);
CREATE INDEX tasks_project ON workpivot.tasks(owner_user_id,project_id,created_at,id);
CREATE TABLE workpivot.messages (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL,
 sequence bigint NOT NULL, role text NOT NULL CHECK(role IN ('user','assistant','tool','system')),
 content text NOT NULL, request_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id),
 UNIQUE(task_id,sequence), UNIQUE(task_id,request_id)
);
CREATE TABLE workpivot.user_settings (
 owner_user_id uuid NOT NULL REFERENCES identity.users(id), key text NOT NULL,
 value jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, PRIMARY KEY(owner_user_id,key)
);
CREATE TABLE workpivot.memories (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 scope text NOT NULL CHECK(scope IN ('user','project','task')),
 project_id uuid REFERENCES workpivot.projects(id), task_id uuid,
 revision integer NOT NULL DEFAULT 1, deleted_at timestamptz,
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id),
 CHECK ((scope='user' AND project_id IS NULL AND task_id IS NULL) OR
        (scope='project' AND project_id IS NOT NULL AND task_id IS NULL) OR
        (scope='task' AND task_id IS NOT NULL AND project_id IS NULL)),
 UNIQUE(owner_user_id,id)
);
CREATE TABLE workpivot.memory_revisions (
 owner_user_id uuid NOT NULL, memory_id uuid NOT NULL, revision integer NOT NULL,
 content text NOT NULL CHECK(length(content)<=20000), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(memory_id,revision), FOREIGN KEY(owner_user_id,memory_id) REFERENCES workpivot.memories(owner_user_id,id)
);
CREATE TABLE workpivot.forget_rules (
 memory_id uuid PRIMARY KEY, owner_user_id uuid NOT NULL,
 deleted_revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,memory_id) REFERENCES workpivot.memories(owner_user_id,id)
);
CREATE TABLE workpivot.knowledge_state (
 owner_user_id uuid PRIMARY KEY REFERENCES identity.users(id), epoch bigint NOT NULL DEFAULT 0
);
CREATE TABLE workpivot.outbox_events (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 kind text NOT NULL, entity_id uuid NOT NULL, revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,kind,entity_id,revision)
);
ALTER TABLE workpivot.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.projects FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_projects ON workpivot.projects USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.project_members FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_members ON workpivot.project_members USING(user_id=workpivot.actor_id())
 WITH CHECK(user_id=workpivot.actor_id() AND role='owner' AND EXISTS(SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.owner_user_id=workpivot.actor_id()));
ALTER TABLE workpivot.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_tasks ON workpivot.tasks USING(owner_user_id=workpivot.actor_id())
 WITH CHECK(owner_user_id=workpivot.actor_id() AND (project_id IS NULL OR EXISTS(SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.deleted_at IS NULL)));
ALTER TABLE workpivot.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memories FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_memories ON workpivot.memories USING(owner_user_id=workpivot.actor_id())
 WITH CHECK(owner_user_id=workpivot.actor_id() AND (project_id IS NULL OR EXISTS(SELECT 1 FROM workpivot.projects p WHERE p.id=project_id AND p.deleted_at IS NULL)));
ALTER TABLE workpivot.memory_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_memory_revisions ON workpivot.memory_revisions
 USING(owner_user_id=workpivot.actor_id() AND EXISTS(SELECT 1 FROM workpivot.memories m WHERE m.id=memory_id AND m.deleted_at IS NULL))
 WITH CHECK(owner_user_id=workpivot.actor_id() AND EXISTS(SELECT 1 FROM workpivot.memories m WHERE m.id=memory_id AND m.deleted_at IS NULL));
`;

export const personalTables = ['messages', 'user_settings', 'forget_rules', 'knowledge_state', 'outbox_events'] as const;
