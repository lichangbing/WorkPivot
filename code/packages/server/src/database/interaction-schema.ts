/** v68：持久交互、计划文档与拒绝反馈；旧 run_permissions 继续作为动作授权权威。 */
export const interactionSchema = `
CREATE TABLE workpivot.interactions (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  task_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES workpivot.task_runs(id),
  kind text NOT NULL CHECK(kind IN ('clarification','artifact_review')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','answered','approved','denied','expired','cancelled')),
  blocking boolean NOT NULL DEFAULT true,
  risk text NOT NULL DEFAULT 'low' CHECK(risk IN ('low','medium','high')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
CREATE UNIQUE INDEX one_pending_blocking_interaction
  ON workpivot.interactions(run_id) WHERE state='pending' AND blocking;
CREATE INDEX interactions_pending_task ON workpivot.interactions(task_id,created_at);
CREATE INDEX interactions_owner_state ON workpivot.interactions(owner_user_id,task_id,state);
ALTER TABLE workpivot.interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.interactions FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.interactions
  USING(owner_user_id=workpivot.actor_id())
  WITH CHECK(owner_user_id=workpivot.actor_id());

CREATE TABLE workpivot.task_plans (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES identity.users(id),
  task_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','superseded')),
  goal text NOT NULL CHECK(length(goal) BETWEEN 1 AND 4000),
  assumptions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(assumptions)='array'),
  data_scope jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(data_scope)='array'),
  business_rules jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(business_rules)='array'),
  steps jsonb NOT NULL CHECK(jsonb_typeof(steps)='array'),
  external_actions jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(external_actions)='array'),
  outputs jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(outputs)='array'),
  risks jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(risks)='array'),
  verification jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(verification)='array'),
  plan_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,task_id,revision),
  UNIQUE(owner_user_id,task_id,id),
  FOREIGN KEY(owner_user_id,task_id) REFERENCES workpivot.tasks(owner_user_id,id)
);
CREATE INDEX task_plans_latest ON workpivot.task_plans(task_id,revision DESC);
ALTER TABLE workpivot.task_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.task_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_scope ON workpivot.task_plans
  USING(owner_user_id=workpivot.actor_id())
  WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE TRIGGER notify_interactions
  AFTER INSERT OR UPDATE OR DELETE ON workpivot.interactions
  FOR EACH ROW EXECUTE FUNCTION workpivot.notify_task_event();

ALTER TABLE workpivot.run_permissions ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE workpivot.run_permissions ADD COLUMN feedback text CHECK(feedback IS NULL OR length(feedback)<=2000);
ALTER TABLE workpivot.run_permissions ADD COLUMN risk text NOT NULL DEFAULT 'medium' CHECK(risk IN ('low','medium','high'));
`;
