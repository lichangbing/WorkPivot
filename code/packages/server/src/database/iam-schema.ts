/** 企业身份基础：组织、成员、外部映射、一次性登录事务和审计。 */
export const iamSchema = `
CREATE TABLE identity.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.organization_members (
  organization_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  source text NOT NULL DEFAULT 'local' CHECK(source IN ('local','oidc','wecom','sync')),
  manual_disabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(organization_id,user_id)
);

CREATE TABLE identity.identity_providers (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  kind text NOT NULL DEFAULT 'oidc' CHECK(kind IN ('oidc')),
  issuer text NOT NULL CHECK(length(issuer) BETWEEN 8 AND 1000),
  client_id text NOT NULL CHECK(length(client_id) BETWEEN 1 AND 500),
  client_secret jsonb,
  redirect_uri text NOT NULL CHECK(length(redirect_uri) BETWEEN 8 AND 1000),
  enabled boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,issuer,client_id)
);

CREATE TABLE identity.external_identities (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES identity.identity_providers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 1000),
  email text,
  display_name text,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id,issuer,subject),
  UNIQUE(provider_id,user_id)
);

CREATE TABLE identity.external_pending (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES identity.identity_providers(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text,
  display_name text,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid REFERENCES identity.users(id),
  UNIQUE(provider_id,issuer,subject)
);

CREATE TABLE identity.login_transactions (
  id uuid PRIMARY KEY,
  state_hash char(64) NOT NULL UNIQUE,
  browser_hash char(64) NOT NULL,
  provider_id uuid NOT NULL REFERENCES identity.identity_providers(id) ON DELETE CASCADE,
  provider_revision integer NOT NULL,
  organization_id uuid NOT NULL REFERENCES identity.organizations(id) ON DELETE CASCADE,
  verifier jsonb NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_transactions_expiry ON identity.login_transactions(expires_at);

CREATE TABLE identity.oidc_completions (
  ticket_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
  browser_hash char(64) NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.identity_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES identity.organizations(id) ON DELETE SET NULL,
  provider_id uuid REFERENCES identity.identity_providers(id) ON DELETE SET NULL,
  subject_user_id uuid REFERENCES identity.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  result text NOT NULL CHECK(result IN ('success','denied','failed')),
  reason text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_events_org_time ON identity.identity_events(organization_id,created_at DESC);
`;
