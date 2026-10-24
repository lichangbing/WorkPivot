import {personalProjectSchema} from './personal-project-schema.js';
import { memoryAnalysisSchema } from './memory-analysis-schema.js';
import {modelCapacitySchema} from './model-capacity-schema.js';
import {browserProfileSchema} from './browser-profile-schema.js';
import {networkTargetSchema} from './network-target-schema.js';
import {requestAuditCleanupSchema} from './request-audit-cleanup-schema.js';
import {requestAuditSchema} from './request-audit-schema.js';
import {captureSchema} from './capture-schema.js';
import {managementAttemptSchema} from './management-attempt-schema.js';
import {automationCapacitySchema} from './automation-capacity-schema.js';
import {embeddingSchema} from './embedding-schema.js';
import {trashSchema} from './trash-schema.js';
import { automationSchema } from './automation-schema.js';
import { skillBuildSchema } from './skill-build-schema.js';
import { memoryReviewSchema } from './memory-review.js';
import { memoryContextSchema } from './memory-context-schema.js';
import { expertSchema } from './expert-schema.js';
/** 采用版本化的新数据库结构，不导入旧文件系统数据。 */
export const schemaVersion = 1;
// v1 仅将 SQL 注释翻译为中文；保留此前已部署结构的校验值，不改变任何建表语句。
export const legacyV1Checksum = '1f9e155f434ec33d0ad80216978187a3bee49ade54391b7e5f4129734a5d4b62';
const chineseV1Checksum = '2005cc5c41df2099114defb9e50fb4b20ec7765b8e3dbb0dc8f552a938a84fb8';
// 只兼容本次纯注释翻译，后续若误改 v1 结构，不得借历史校验值跳过检查。
export function matchesV1Checksum(stored: string, current: string): boolean {
  return stored === current || current === chineseV1Checksum && stored === legacyV1Checksum;
}
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
-- 首版只开放个人使用，暂不提供邀请或成员授权访问；项目数据不通过外键绑定创建者。
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

/** 只做增量结构升级，保留 v1 历史校验兼容，不导入旧对话。 */
export const schemaUpgrades = [{ version: 2, sql: `
ALTER TABLE workpivot.tasks ADD COLUMN next_turn_sequence bigint NOT NULL DEFAULT 1;
CREATE TABLE workpivot.conversation_turns (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id),
 UNIQUE(task_id,sequence), UNIQUE(task_id,request_id), UNIQUE(owner_user_id,task_id,id)
);
CREATE TABLE workpivot.conversation_events (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL, turn_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence>0), request_id uuid NOT NULL, run_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('user','assistant','thinking','tool_use','tool_result','meta')),
 content text NOT NULL CHECK(length(content)<=200000), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,task_id,turn_id) REFERENCES workpivot.conversation_turns(owner_user_id,task_id,id),
 UNIQUE(task_id,sequence), UNIQUE(task_id,request_id)
);
CREATE INDEX conversation_events_turn ON workpivot.conversation_events(turn_id,sequence);
ALTER TABLE workpivot.conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.conversation_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.conversation_turns USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.conversation_events FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.conversation_events USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 3, sql: `
CREATE TABLE workpivot.task_runs (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL, turn_id uuid NOT NULL,
 request_id uuid NOT NULL, fence uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('running','stopping','completed','stopped','failed','interrupted')),
 lease_until timestamptz NOT NULL, stop_reason text, model_messages jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(owner_user_id,task_id,turn_id) REFERENCES workpivot.conversation_turns(owner_user_id,task_id,id),
 UNIQUE(task_id,request_id)
);
CREATE UNIQUE INDEX task_one_active_run ON workpivot.task_runs(task_id) WHERE status IN ('running','stopping');
ALTER TABLE workpivot.task_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.task_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.task_runs USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 4, sql: `
CREATE TABLE workpivot.model_providers (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 name text NOT NULL, base_url text NOT NULL, model_id text NOT NULL,
 protocol text NOT NULL CHECK(protocol IN ('openai','anthropic')),
 secret jsonb, active boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_provider ON workpivot.model_providers(owner_user_id) WHERE active;
ALTER TABLE workpivot.model_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.model_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.model_providers USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 5, sql: `
CREATE TABLE workpivot.mcp_connections (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 name text NOT NULL, url text NOT NULL, secret jsonb, revision integer NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'untested' CHECK(status IN ('untested','ready','error')),
 tools jsonb NOT NULL DEFAULT '[]', disabled_tools jsonb NOT NULL DEFAULT '[]',
 UNIQUE(owner_user_id,name)
);
ALTER TABLE workpivot.mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.mcp_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.mcp_connections USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 6, sql: `
CREATE TABLE workpivot.run_permissions (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES identity.users(id),
 task_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES workpivot.task_runs(id),
 request jsonb NOT NULL, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','allowed','denied','consumed','expired','cancelled')),
 decision text CHECK(decision IN ('allow','deny')), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
CREATE UNIQUE INDEX one_pending_permission ON workpivot.run_permissions(run_id) WHERE state IN ('pending','allowed');
ALTER TABLE workpivot.run_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.run_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.run_permissions USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 7, sql: `
CREATE TABLE workpivot.documents (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id),
 UNIQUE(owner_user_id,id)
);
CREATE TABLE workpivot.document_versions (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, document_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0), request_id uuid NOT NULL,
 name text NOT NULL, size integer NOT NULL CHECK(size>=0 AND size<=10485760),
 sha256 text NOT NULL CHECK(length(sha256)=64), created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(owner_user_id,document_id) REFERENCES workpivot.documents(owner_user_id,id) ON DELETE CASCADE,
 UNIQUE(document_id,revision), UNIQUE(owner_user_id,request_id)
);
CREATE INDEX documents_task ON workpivot.documents(task_id);
ALTER TABLE workpivot.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.documents USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.document_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.document_versions USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 8, sql: `
ALTER TABLE workpivot.task_runs ADD COLUMN attachment_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE workpivot.task_runs ADD CONSTRAINT attachment_count CHECK(cardinality(attachment_ids)<=10);
` }, { version: 9, sql: `
CREATE TABLE workpivot.skill_drafts (
 name text PRIMARY KEY, owner_user_id uuid NOT NULL, revision uuid NOT NULL,
 files jsonb NOT NULL, directories jsonb NOT NULL DEFAULT '[]', published uuid, disabled boolean NOT NULL DEFAULT false
);
CREATE TABLE workpivot.skill_releases (
 id uuid PRIMARY KEY, name text NOT NULL REFERENCES workpivot.skill_drafts(name) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL, files jsonb NOT NULL, directories jsonb NOT NULL,
 label text NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workpivot.skill_catalog (
 name text PRIMARY KEY REFERENCES workpivot.skill_drafts(name) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL, release_id uuid NOT NULL REFERENCES workpivot.skill_releases(id), disabled boolean NOT NULL
);
CREATE TABLE workpivot.skill_selections (
 owner_user_id uuid NOT NULL, name text NOT NULL REFERENCES workpivot.skill_catalog(name) ON DELETE CASCADE,
 PRIMARY KEY(owner_user_id,name)
);
ALTER TABLE workpivot.skill_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY private_draft ON workpivot.skill_drafts USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.skill_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY published_read ON workpivot.skill_releases FOR SELECT USING(true);
CREATE POLICY owner_insert ON workpivot.skill_releases FOR INSERT WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.skill_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_read ON workpivot.skill_catalog FOR SELECT USING(true);
CREATE POLICY catalog_insert ON workpivot.skill_catalog FOR INSERT WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE POLICY catalog_update ON workpivot.skill_catalog FOR UPDATE USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.skill_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_selection ON workpivot.skill_selections USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 10, sql: `
CREATE TABLE workpivot.memory_suggestions (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL, scope text NOT NULL CHECK(scope IN ('user','project','task')),
 project_id uuid, content text NOT NULL CHECK(length(content)<=20000), fingerprint text NOT NULL,
 epoch bigint NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','stale')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_user_id,task_id,fingerprint),
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
ALTER TABLE workpivot.memory_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_suggestions ON workpivot.memory_suggestions USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 11, sql: `
ALTER TABLE workpivot.memory_suggestions ADD COLUMN target_id uuid;
ALTER TABLE workpivot.memory_suggestions ADD COLUMN target_revision integer;
ALTER TABLE workpivot.memory_suggestions ADD CONSTRAINT suggestion_target_pair CHECK((target_id IS NULL AND target_revision IS NULL) OR (target_id IS NOT NULL AND target_revision>0));
` }, { version: 12, sql: `
CREATE TABLE workpivot.memory_jobs (
 run_id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, task_id uuid NOT NULL,
 epoch bigint NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','stale')),
 attempts integer NOT NULL DEFAULT 0, lease_until timestamptz, error text,
 FOREIGN KEY(run_id) REFERENCES workpivot.task_runs(id) ON DELETE CASCADE
);
ALTER TABLE workpivot.memory_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_jobs ON workpivot.memory_jobs USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.memory_suggestions ADD COLUMN source_run_id uuid REFERENCES workpivot.task_runs(id) ON DELETE CASCADE;
ALTER TABLE workpivot.memory_suggestions ADD COLUMN evidence text;
CREATE TABLE workpivot.memory_sources (
 owner_user_id uuid NOT NULL, memory_id uuid NOT NULL, run_id uuid NOT NULL,
 PRIMARY KEY(memory_id,run_id), FOREIGN KEY(owner_user_id,memory_id) REFERENCES workpivot.memories(owner_user_id,id),
 FOREIGN KEY(run_id) REFERENCES workpivot.task_runs(id) ON DELETE CASCADE
);
ALTER TABLE workpivot.memory_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_sources ON workpivot.memory_sources USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.task_runs ADD COLUMN context_revoked boolean NOT NULL DEFAULT false;
ALTER TABLE workpivot.task_runs ADD COLUMN memory_epoch bigint NOT NULL DEFAULT 0;
` }, { version: 13, sql: `
ALTER TABLE workpivot.memory_suggestions ADD COLUMN merge_targets jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workpivot.memories ADD COLUMN merged_into uuid;
ALTER POLICY personal_memory_revisions ON workpivot.memory_revisions
 USING(owner_user_id=workpivot.actor_id() AND EXISTS(SELECT 1 FROM workpivot.memories m WHERE m.id=memory_id AND (m.deleted_at IS NULL OR m.merged_into IS NOT NULL)));
` }, { version: 14, sql: `
ALTER TABLE workpivot.documents ADD COLUMN purpose text NOT NULL DEFAULT 'upload' CHECK(purpose IN ('upload','artifact'));
` }, { version: 15, sql: `
CREATE TABLE workpivot.skill_executions (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, run_id uuid NOT NULL REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,
 task_id uuid NOT NULL, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','interrupted')),
 artifact_id uuid REFERENCES workpivot.document_versions(id) ON DELETE SET NULL,
 error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
ALTER TABLE workpivot.skill_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.skill_executions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_executions ON workpivot.skill_executions USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE INDEX skill_executions_running ON workpivot.skill_executions(task_id) WHERE status='running';
` }, { version: 16, sql: `
CREATE TABLE workpivot.default_model (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 owner_user_id uuid NOT NULL, provider_id uuid NOT NULL REFERENCES workpivot.model_providers(id) ON DELETE CASCADE
);
ALTER TABLE workpivot.default_model ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.default_model FORCE ROW LEVEL SECURITY;
CREATE POLICY model_reference_read ON workpivot.default_model FOR SELECT USING(true);
CREATE POLICY model_reference_insert ON workpivot.default_model FOR INSERT WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE POLICY model_reference_update ON workpivot.default_model FOR UPDATE USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 17, sql: `
CREATE TABLE workpivot.execution_artifacts (
 owner_user_id uuid NOT NULL,
 execution_id uuid NOT NULL REFERENCES workpivot.skill_executions(id) ON DELETE CASCADE,
 version_id uuid NOT NULL REFERENCES workpivot.document_versions(id) ON DELETE CASCADE,
 PRIMARY KEY(execution_id,version_id)
);
ALTER TABLE workpivot.execution_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.execution_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_execution_artifacts ON workpivot.execution_artifacts USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
INSERT INTO workpivot.execution_artifacts SELECT owner_user_id,id,artifact_id FROM workpivot.skill_executions WHERE artifact_id IS NOT NULL;
` }, { version: 18, sql: `
CREATE TABLE workpivot.document_processing (
 version_id uuid PRIMARY KEY REFERENCES workpivot.document_versions(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
 attempts integer NOT NULL DEFAULT 0, fence uuid, lease_until timestamptz, error text, parts jsonb NOT NULL DEFAULT '[]'
);
ALTER TABLE workpivot.document_processing ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.document_processing FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_document_processing ON workpivot.document_processing USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
INSERT INTO workpivot.document_processing(version_id,owner_user_id) SELECT v.id,v.owner_user_id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id WHERE d.purpose='upload' AND lower(v.name) ~ '[.](docx|xlsx|pptx|pdf)$';
` }, { version: 19, sql: `
CREATE TABLE workpivot.knowledge_versions (
 version_id uuid PRIMARY KEY REFERENCES workpivot.document_versions(id) ON DELETE CASCADE,
 owner_user_id uuid NOT NULL
);
CREATE TABLE workpivot.knowledge_chunks (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,
 version_id uuid NOT NULL REFERENCES workpivot.knowledge_versions(version_id) ON DELETE CASCADE,
 ordinal integer NOT NULL,location text NOT NULL,source_offset integer NOT NULL,content text NOT NULL,
 UNIQUE(version_id,ordinal)
);
ALTER TABLE workpivot.knowledge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.knowledge_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_knowledge_versions ON workpivot.knowledge_versions USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
ALTER TABLE workpivot.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.knowledge_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_knowledge_chunks ON workpivot.knowledge_chunks USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 20, sql: `
ALTER TABLE workpivot.memories ADD COLUMN locked boolean NOT NULL DEFAULT false;
CREATE TABLE workpivot.memory_controls (
 owner_user_id uuid NOT NULL,scope text NOT NULL CHECK(scope IN ('user','project','task')),
 load_enabled boolean NOT NULL DEFAULT true,update_enabled boolean NOT NULL DEFAULT true,revision integer NOT NULL DEFAULT 1,
 PRIMARY KEY(owner_user_id,scope)
);
ALTER TABLE workpivot.memory_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_controls FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_memory_controls ON workpivot.memory_controls USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
` }, { version: 21, sql: `
CREATE TABLE workpivot.memory_templates (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,name text NOT NULL,content text NOT NULL,
 scope text NOT NULL CHECK(scope IN ('user','project','task')),enabled boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1
);
ALTER TABLE workpivot.memory_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.memory_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY templates_read ON workpivot.memory_templates FOR SELECT USING(enabled OR owner_user_id=workpivot.actor_id());
CREATE POLICY templates_insert ON workpivot.memory_templates FOR INSERT WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE POLICY templates_update ON workpivot.memory_templates FOR UPDATE USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE POLICY templates_delete ON workpivot.memory_templates FOR DELETE USING(owner_user_id=workpivot.actor_id());
` }, { version: 22, sql: `
CREATE TABLE workpivot.context_checkpoints (
 id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,task_id uuid NOT NULL REFERENCES workpivot.tasks(id) ON DELETE CASCADE,
 through_sequence bigint NOT NULL,source_hash text NOT NULL,source_ids uuid[] NOT NULL,
 status text NOT NULL DEFAULT 'generating' CHECK(status IN ('generating','pending','accepted','rejected','failed','stale','superseded')),
 content text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,error text,
 lease_until timestamptz NOT NULL DEFAULT now()+interval '3 minutes',created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workpivot.context_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.context_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_checkpoints ON workpivot.context_checkpoints USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE UNIQUE INDEX one_pending_checkpoint ON workpivot.context_checkpoints(task_id) WHERE status IN ('generating','pending');
CREATE UNIQUE INDEX one_active_checkpoint ON workpivot.context_checkpoints(task_id) WHERE status='accepted';
CREATE FUNCTION workpivot.invalidate_checkpoints() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='knowledge_state' THEN
  UPDATE workpivot.context_checkpoints SET status='stale',content='',error=NULL,revision=revision+1 WHERE owner_user_id=NEW.owner_user_id AND status<>'stale';
 ELSIF TG_TABLE_NAME='tasks' THEN
  DELETE FROM workpivot.context_checkpoints WHERE task_id=OLD.id;
 ELSIF TG_TABLE_NAME='task_runs' THEN
  UPDATE workpivot.context_checkpoints SET status='stale',content='',error=NULL,revision=revision+1 WHERE OLD.id=ANY(source_ids) AND status<>'stale';
 ELSE
  UPDATE workpivot.context_checkpoints SET status='stale',content='',error=NULL,revision=revision+1 WHERE OLD.run_id=ANY(source_ids) AND status<>'stale';
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER checkpoint_epoch AFTER INSERT OR UPDATE OF epoch ON workpivot.knowledge_state FOR EACH ROW EXECUTE FUNCTION workpivot.invalidate_checkpoints();
CREATE TRIGGER checkpoint_task AFTER UPDATE OF deleted_at ON workpivot.tasks FOR EACH ROW WHEN(NEW.deleted_at IS NOT NULL) EXECUTE FUNCTION workpivot.invalidate_checkpoints();
CREATE TRIGGER checkpoint_run_update AFTER UPDATE OF context_revoked,model_messages ON workpivot.task_runs FOR EACH ROW WHEN(OLD.context_revoked IS DISTINCT FROM NEW.context_revoked OR OLD.model_messages IS DISTINCT FROM NEW.model_messages) EXECUTE FUNCTION workpivot.invalidate_checkpoints();
CREATE TRIGGER checkpoint_run_delete AFTER DELETE ON workpivot.task_runs FOR EACH ROW EXECUTE FUNCTION workpivot.invalidate_checkpoints();
CREATE TRIGGER checkpoint_event AFTER UPDATE OF content OR DELETE ON workpivot.conversation_events FOR EACH ROW EXECUTE FUNCTION workpivot.invalidate_checkpoints();
` }, { version: 23, sql: `
ALTER TABLE workpivot.model_providers ADD COLUMN context_budget integer NOT NULL DEFAULT 65536 CHECK(context_budget BETWEEN 12000 AND 1000000);
ALTER TABLE workpivot.context_checkpoints ADD COLUMN processed_batches integer NOT NULL DEFAULT 0;
ALTER TABLE workpivot.context_checkpoints ADD COLUMN total_batches integer NOT NULL DEFAULT 0;
` }, { version: 24, sql: `
CREATE FUNCTION workpivot.notify_task_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='tasks' THEN
  PERFORM pg_notify('workpivot_task_events',COALESCE(NEW.id,OLD.id)::text);
 ELSE
  PERFORM pg_notify('workpivot_task_events',COALESCE(NEW.task_id,OLD.task_id)::text);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER notify_conversation AFTER INSERT ON workpivot.conversation_events FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();
CREATE TRIGGER notify_permissions AFTER INSERT OR UPDATE OR DELETE ON workpivot.run_permissions FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();
CREATE TRIGGER notify_task_state AFTER UPDATE OF status,deleted_at ON workpivot.tasks FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();
` }, {version:25,sql:expertSchema}, {version:26,sql:memoryContextSchema}, {version:27,sql:memoryReviewSchema}, {version:28,sql:skillBuildSchema}, {version:29,sql:automationSchema}, {version:30,sql:trashSchema}, {version:31,sql:embeddingSchema}, {version:32,sql:`
ALTER TABLE workpivot.document_processing ADD COLUMN parser_fingerprint text;
ALTER TABLE workpivot.document_processing ADD COLUMN coverage text NOT NULL DEFAULT 'unknown' CHECK(coverage IN ('unknown','text-only','partial'));
ALTER TABLE workpivot.document_processing ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings)='array');
`}, {version:33,sql:`
INSERT INTO workpivot.document_processing(version_id,owner_user_id)
SELECT v.id,v.owner_user_id FROM workpivot.document_versions v JOIN workpivot.documents d ON d.id=v.document_id
WHERE d.purpose='upload' AND lower(v.name) ~ '[.](png|jpg|jpeg)$'
ON CONFLICT(version_id) DO NOTHING;
UPDATE workpivot.document_processing p SET status='pending',attempts=0,error=NULL
FROM workpivot.document_versions v WHERE v.id=p.version_id AND p.status='failed' AND lower(v.name) ~ '[.]pdf$';
`}, {version:34,sql:usageSchema}, {version:35,sql:`
ALTER TABLE identity.sessions ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE identity.sessions ADD CONSTRAINT sessions_public_id UNIQUE(id);
`}, {version:36,sql:`
ALTER TABLE workpivot.trash_entries DROP CONSTRAINT trash_entries_kind_check;
ALTER TABLE workpivot.trash_entries ADD CONSTRAINT trash_entries_kind_check CHECK(kind IN ('project','task','document','memory','skill','expert','automation'));
`}, {version:37,sql:`
ALTER TABLE workpivot.task_runs ADD COLUMN resource_scope jsonb;
ALTER TABLE workpivot.task_runs ADD CONSTRAINT resource_scope_object CHECK(resource_scope IS NULL OR (jsonb_typeof(resource_scope)='object' AND resource_scope->>'version'='1'));
`}, {version:38,sql:`
UPDATE workpivot.automations SET state=CASE WHEN state='enabled' THEN 'blocked' ELSE state END,
 grant_id=NULL,next_at=NULL,revision=revision+1,updated_at=now(),
 issue='旧网页来源授权已失效，请编辑完整 URL 并重新确认'
WHERE state<>'deleted' AND COALESCE(config->'webOrigins','[]'::jsonb)<>'[]'::jsonb;
UPDATE workpivot.automation_runs SET revoked=true,
 status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
 finished_at=CASE WHEN status='queued' THEN now() ELSE finished_at END,
 error='旧网页来源授权已失效，请编辑完整 URL 并重新确认'
WHERE status IN ('queued','running') AND COALESCE(config->'webOrigins','[]'::jsonb)<>'[]'::jsonb;
`}, {version:39,sql:automationCapacitySchema}, {version:40,sql:managementAttemptSchema}, {version:41,sql:captureSchema}, {version:42,sql:`
ALTER TABLE workpivot.capture_observations ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 2);
ALTER TABLE workpivot.capture_audit ADD COLUMN retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 2);
`}, {version:43,sql:`
ALTER TABLE workpivot.capture_versions ADD COLUMN original_body bytea, ADD COLUMN original_type text, ADD COLUMN original_hash text;
ALTER TABLE workpivot.capture_versions ADD CONSTRAINT capture_original_valid CHECK (
 (original_body IS NULL AND original_type IS NULL AND original_hash IS NULL) OR
 (original_body IS NOT NULL AND original_type IS NOT NULL AND original_hash IS NOT NULL AND octet_length(original_body)<=2097152 AND length(original_type) BETWEEN 1 AND 200 AND original_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE workpivot.capture_audit DROP CONSTRAINT capture_audit_action_check;
ALTER TABLE workpivot.capture_audit ADD CONSTRAINT capture_audit_action_check CHECK(action IN ('new_version','unchanged','view','recycle','restore','purge','download'));
`}, {version:44,sql:`
ALTER TABLE workpivot.capture_versions ADD COLUMN original_kind text NOT NULL DEFAULT 'http' CHECK(original_kind IN ('http','dom'));
`}, {version:45,sql:requestAuditSchema}, {version:46,sql:`
ALTER TABLE workpivot.capture_versions DROP CONSTRAINT capture_versions_original_kind_check;
ALTER TABLE workpivot.capture_versions ADD CONSTRAINT capture_versions_original_kind_check CHECK(original_kind IN ('http','dom','bundle'));
`}, {version:47,sql:requestAuditCleanupSchema}, {version:48,sql:networkTargetSchema}, {version:49,sql:browserProfileSchema}, {version:50,sql:modelCapacitySchema}, {version:51,sql:memoryAnalysisSchema}, {version:52,sql:personalProjectSchema}, {version:53,sql:`
ALTER TABLE workpivot.skill_executions ADD COLUMN kind text NOT NULL DEFAULT 'skill' CHECK(kind IN ('skill','code'));
CREATE INDEX skill_executions_kind ON workpivot.skill_executions(kind,task_id);
`}, {version:54,sql:`
ALTER TABLE workpivot.task_runs ADD COLUMN step_limit integer NOT NULL DEFAULT 0 CHECK(step_limit>=0);
ALTER TABLE workpivot.task_runs ADD COLUMN used_steps integer NOT NULL DEFAULT 0 CHECK(used_steps>=0);
CREATE TABLE workpivot.tool_dispatches (
 run_id uuid NOT NULL REFERENCES workpivot.task_runs(id) ON DELETE CASCADE,
 call_id text NOT NULL, owner_user_id uuid NOT NULL, task_id uuid NOT NULL, tool text NOT NULL,
 status text NOT NULL DEFAULT 'dispatched' CHECK(status IN ('dispatched','completed','failed','interrupted')),
 dispatched_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 PRIMARY KEY(run_id,call_id)
);
ALTER TABLE workpivot.tool_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.tool_dispatches FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_dispatches ON workpivot.tool_dispatches USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE INDEX tool_dispatches_open ON workpivot.tool_dispatches(run_id) WHERE status='dispatched';
`}] as const;
import { usageSchema } from './usage-schema.js';
