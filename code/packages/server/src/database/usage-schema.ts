/** 请求级用量只保存计数和计价快照，不保存对话或凭据。 */
export const usageSchema = `
ALTER TABLE workpivot.model_providers ADD COLUMN input_price numeric(18,6), ADD COLUMN output_price numeric(18,6), ADD COLUMN currency text NOT NULL DEFAULT 'CNY';
ALTER TABLE workpivot.model_providers ADD CHECK(input_price>=0 AND output_price>=0), ADD CHECK(currency IN ('CNY','USD'));
CREATE TABLE workpivot.model_usage (
 id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, provider_id uuid NOT NULL, model text NOT NULL,
 task_id uuid, source text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','cancelled')),
 input_tokens bigint, output_tokens bigint, measurement text CHECK(measurement IN ('provider','estimated')),
 input_price numeric(18,6), output_price numeric(18,6), currency text NOT NULL,
 cost numeric(28,12), failure text,
 CHECK(input_tokens>=0 AND output_tokens>=0)
);
CREATE INDEX model_usage_owner_time ON workpivot.model_usage(owner_user_id,started_at);
CREATE TABLE workpivot.usage_budgets(owner_user_id uuid NOT NULL,currency text NOT NULL CHECK(currency IN ('CNY','USD')),amount numeric(18,6),revision integer NOT NULL DEFAULT 1,PRIMARY KEY(owner_user_id,currency),CHECK(amount>0));
CREATE TABLE workpivot.usage_alerts(owner_user_id uuid NOT NULL,currency text NOT NULL,month text NOT NULL,amount numeric(18,6) NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,PRIMARY KEY(owner_user_id,currency,month));
DO $$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['model_usage','usage_budgets','usage_alerts'] LOOP
 EXECUTE format('ALTER TABLE workpivot.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('ALTER TABLE workpivot.%I FORCE ROW LEVEL SECURITY',n);
 EXECUTE format('CREATE POLICY personal_scope ON workpivot.%I USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id())',n);
END LOOP; END $$;
`;
