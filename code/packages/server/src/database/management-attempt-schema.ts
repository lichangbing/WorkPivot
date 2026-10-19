/** 失败审计只保留固定元数据；不保存未通过校验的参数和错误原文。 */
export const managementAttemptSchema=`
CREATE TABLE workpivot.management_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,
 actor_id uuid NOT NULL,target_id uuid,action text NOT NULL CHECK(action='automation.capacity.update'),
 category text NOT NULL CHECK(category IN ('permission_denied','invalid_input','conflict','not_found','internal_error')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX management_attempt_history ON workpivot.management_attempts(owner_user_id,created_at DESC,id DESC);
ALTER TABLE workpivot.management_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.management_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY management_attempt_owner ON workpivot.management_attempts USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE TRIGGER management_attempt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.management_attempts FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
`;
