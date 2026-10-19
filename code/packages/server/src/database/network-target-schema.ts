export const networkTargetSchema=`
CREATE TABLE workpivot.network_targets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,url text NOT NULL,address text NOT NULL,
 created_by uuid NOT NULL,revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE workpivot.network_target_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,target_id uuid NOT NULL,actor_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('approve','revoke')),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
${['network_targets','network_target_audit'].map(t=>`ALTER TABLE workpivot.${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY network_target_owner ON workpivot.${t} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());`).join('\n')}
CREATE TRIGGER network_target_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.network_target_audit FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
CREATE INDEX network_targets_owner ON workpivot.network_targets(owner_user_id,created_at DESC,id DESC);
`;
