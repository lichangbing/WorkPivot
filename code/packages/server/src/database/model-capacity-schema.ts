/** 保留既有手工容量；只有管理员主动同步才更新服务端元数据。 */
export const modelCapacitySchema = `
ALTER TABLE workpivot.model_providers DROP CONSTRAINT model_providers_context_budget_check;
ALTER TABLE workpivot.model_providers ADD CONSTRAINT model_providers_context_budget_check CHECK(context_budget BETWEEN 12000 AND 2097152);
ALTER TABLE workpivot.model_providers ADD COLUMN context_source text NOT NULL DEFAULT 'manual' CHECK(context_source IN ('manual','api'));
ALTER TABLE workpivot.model_providers ADD COLUMN context_checked_at timestamptz;
CREATE TABLE workpivot.model_capacity_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),owner_user_id uuid NOT NULL,provider_id uuid NOT NULL,
 before_tokens integer,after_tokens integer NOT NULL,source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workpivot.model_capacity_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE workpivot.model_capacity_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY own_capacity_audit ON workpivot.model_capacity_audit USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id());
CREATE TRIGGER model_capacity_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON workpivot.model_capacity_audit FOR EACH STATEMENT EXECUTE FUNCTION workpivot.protect_capacity_audit();
CREATE FUNCTION workpivot.audit_model_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO workpivot.model_capacity_audit(owner_user_id,provider_id,before_tokens,after_tokens,source) VALUES(NEW.owner_user_id,NEW.id,NULL,NEW.context_budget,NEW.context_source);
 ELSIF OLD.context_budget IS DISTINCT FROM NEW.context_budget OR OLD.context_source IS DISTINCT FROM NEW.context_source OR OLD.context_checked_at IS DISTINCT FROM NEW.context_checked_at THEN
  INSERT INTO workpivot.model_capacity_audit(owner_user_id,provider_id,before_tokens,after_tokens,source) VALUES(NEW.owner_user_id,NEW.id,OLD.context_budget,NEW.context_budget,NEW.context_source);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER model_capacity_change AFTER INSERT OR UPDATE ON workpivot.model_providers FOR EACH ROW EXECUTE FUNCTION workpivot.audit_model_capacity();
`;
