/** 请求开始与结束分别追加，身份库角色独占访问权限。 */
export const requestAuditSchema=`
CREATE TABLE identity.request_audit (
 id uuid PRIMARY KEY,actor_id uuid,method text NOT NULL CHECK(method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER')),
 area text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE identity.request_audit_results (
 request_id uuid PRIMARY KEY REFERENCES identity.request_audit(id),status integer NOT NULL CHECK(status BETWEEN 100 AND 599),
 outcome text NOT NULL CHECK(outcome IN ('responded','disconnected')),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX request_audit_history ON identity.request_audit(created_at DESC,id DESC);
CREATE INDEX request_audit_actor_history ON identity.request_audit(actor_id,created_at DESC,id DESC);
CREATE FUNCTION identity.protect_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '请求审计不允许修改或删除'; END $$;
CREATE TRIGGER request_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON identity.request_audit FOR EACH STATEMENT EXECUTE FUNCTION identity.protect_request_audit();
CREATE TRIGGER request_audit_result_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON identity.request_audit_results FOR EACH STATEMENT EXECUTE FUNCTION identity.protect_request_audit();
`;
