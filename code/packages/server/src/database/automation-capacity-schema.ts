/** 额度和审计按目标用户隔离，管理变更与审计在同一事务提交。 */
export const automationCapacitySchema=`
CREATE TABLE workpivot.automation_capacity (
 owner_user_id uuid PRIMARY KEY, enabled_limit integer NOT NULL CHECK(enabled_limit BETWEEN 0 AND 100),
 queued_limit integer NOT NULL CHECK(queued_limit BETWEEN 0 AND 100),revision integer NOT NULL CHECK(revision>0)
);
CREATE TABLE workpivot.automation_capacity_audit (
 owner_user_id uuid NOT NULL,revision integer NOT NULL,actor_id uuid NOT NULL,
 request_id uuid NOT NULL,before_limits jsonb NOT NULL,after_limits jsonb NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 300),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_user_id,revision),UNIQUE(owner_user_id,request_id)
);
${['automation_capacity','automation_capacity_audit'].map(t=>`ALTER TABLE workpivot.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_capacity ON workpivot.${t} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());`).join('\n')}
CREATE FUNCTION workpivot.protect_capacity_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '容量审计不允许修改或删除'; END $$;
CREATE TRIGGER capacity_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.automation_capacity_audit FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
`;
