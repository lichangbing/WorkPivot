/** 用户级日限额：自助注册受限，管理员创建的账户默认全部不限。 */
export const dailyLimitSchema = `
CREATE OR REPLACE FUNCTION identity.quota_period_start(at_time timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN (at_time AT TIME ZONE 'Asia/Shanghai')::time < time '12:00'
      THEN (((at_time AT TIME ZONE 'Asia/Shanghai')::date - 1) + time '12:00') AT TIME ZONE 'Asia/Shanghai'
    ELSE (((at_time AT TIME ZONE 'Asia/Shanghai')::date) + time '12:00') AT TIME ZONE 'Asia/Shanghai'
  END
$$;

ALTER TABLE identity.users ADD COLUMN token_quota bigint NOT NULL DEFAULT 0 CHECK(token_quota>=0);
ALTER TABLE identity.users ADD COLUMN tokens_used bigint NOT NULL DEFAULT 0 CHECK(tokens_used>=0);
ALTER TABLE identity.users ADD COLUMN upload_quota_bytes bigint NOT NULL DEFAULT 0 CHECK(upload_quota_bytes BETWEEN 0 AND 1099511627776);
ALTER TABLE identity.users ADD COLUMN upload_bytes_used bigint NOT NULL DEFAULT 0 CHECK(upload_bytes_used>=0);
ALTER TABLE identity.users ADD COLUMN concurrent_task_limit integer NOT NULL DEFAULT 0 CHECK(concurrent_task_limit BETWEEN 0 AND 100);
ALTER TABLE identity.users ADD COLUMN provisioning_source text NOT NULL DEFAULT 'legacy'
  CHECK(provisioning_source IN ('first_admin','self','admin','legacy'));
ALTER TABLE identity.users ADD COLUMN limits_revision integer NOT NULL DEFAULT 1 CHECK(limits_revision>0);
ALTER TABLE identity.users ADD COLUMN usage_period_started_at timestamptz NOT NULL DEFAULT identity.quota_period_start(now());

ALTER TABLE identity.access_policy ADD COLUMN default_token_quota bigint NOT NULL DEFAULT 200000 CHECK(default_token_quota>=0);
ALTER TABLE identity.access_policy ADD COLUMN default_upload_quota_bytes bigint NOT NULL DEFAULT 52428800 CHECK(default_upload_quota_bytes BETWEEN 0 AND 1099511627776);
ALTER TABLE identity.access_policy ADD COLUMN default_concurrent_task_limit integer NOT NULL DEFAULT 1 CHECK(default_concurrent_task_limit BETWEEN 0 AND 100);

UPDATE identity.users u SET provisioning_source=CASE
  WHEN u.platform_admin THEN 'first_admin'
  WHEN EXISTS(SELECT 1 FROM identity.audit_events a WHERE a.target_id=u.id AND a.action='user_created') THEN 'admin'
  WHEN EXISTS(SELECT 1 FROM identity.audit_events a WHERE a.target_id=u.id AND a.action='user_registered') THEN 'self'
  ELSE 'legacy'
END;

-- 兼容升级前由管理员创建的账户：迁移为真正不限。
UPDATE identity.users u SET message_quota=0,token_quota=0,upload_quota_bytes=0,concurrent_task_limit=0
WHERE NOT u.platform_admin
  AND EXISTS(SELECT 1 FROM identity.audit_events a WHERE a.target_id=u.id AND a.action='user_created');

-- 自助注册账户沿用演示额度，并补齐 token、上传和并发默认值。
UPDATE identity.users u SET
  token_quota=p.default_token_quota,
  upload_quota_bytes=p.default_upload_quota_bytes,
  concurrent_task_limit=p.default_concurrent_task_limit
FROM identity.access_policy p
WHERE p.singleton AND NOT u.platform_admin AND u.provisioning_source='self';

GRANT SELECT(id,platform_admin,message_quota,messages_used,quota_reset_at,token_quota,tokens_used,upload_quota_bytes,upload_bytes_used,concurrent_task_limit,usage_period_started_at)
  ON identity.users TO workpivot_app;
GRANT UPDATE(tokens_used,upload_bytes_used,usage_period_started_at)
  ON identity.users TO workpivot_app;
GRANT EXECUTE ON FUNCTION identity.quota_period_start(timestamptz) TO workpivot_app,workpivot_auth;
`;
