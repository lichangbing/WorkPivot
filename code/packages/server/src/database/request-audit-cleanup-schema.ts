/** 只提供带快照核对的有限清理入口；普通连接仍不能直接改删审计。 */
export const requestAuditCleanupSchema=`
CREATE TABLE identity.request_audit_cleanups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL,before_date date NOT NULL,
 removed integer NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER request_audit_cleanup_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON identity.request_audit_cleanups FOR EACH STATEMENT EXECUTE FUNCTION identity.protect_request_audit();
CREATE OR REPLACE FUNCTION identity.protect_request_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RETURN NULL; END IF;
 RAISE EXCEPTION '请求审计不允许修改或删除';
END $$;
CREATE FUNCTION identity.cleanup_request_audit(p_actor uuid,p_before date,p_fingerprint text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actual text; amount integer; chosen uuid[];
BEGIN
 IF p_before IS NULL OR p_before<'2000-01-01' OR p_before::timestamp AT TIME ZONE 'UTC'>now()-interval '30 days' THEN RAISE EXCEPTION '清理日期必须早于30天前'; END IF;
 LOCK TABLE identity.request_audit,identity.request_audit_results IN SHARE ROW EXCLUSIVE MODE;
 SELECT count(*)::integer,md5(COALESCE(string_agg(id::text,',' ORDER BY id),'')),array_agg(id) INTO amount,actual,chosen FROM (
 SELECT a.id FROM identity.request_audit a JOIN identity.request_audit_results r ON r.request_id=a.id
 WHERE a.created_at<p_before::timestamp AT TIME ZONE 'UTC' AND r.created_at<p_before::timestamp AT TIME ZONE 'UTC' LIMIT 100001
 ) selected;
 IF amount>100000 THEN RAISE EXCEPTION '单次清理超过100000条，请缩小日期范围'; END IF;
 IF p_fingerprint IS DISTINCT FROM actual THEN RAISE EXCEPTION '清理范围已变化，请重新预览'; END IF;
 DELETE FROM identity.request_audit_results WHERE request_id=ANY(chosen);
 DELETE FROM identity.request_audit WHERE id=ANY(chosen);
 INSERT INTO identity.request_audit_cleanups(actor_id,before_date,removed,fingerprint) VALUES(p_actor,p_before,amount,actual);
 RETURN amount;
END $$;
REVOKE ALL ON FUNCTION identity.cleanup_request_audit(uuid,date,text) FROM PUBLIC;
`;
