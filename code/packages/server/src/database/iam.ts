import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import type { Pool } from 'pg';
import { getSecretBox, type SecretEnvelope } from '../secret.js';
import { RepositoryError, transaction, uuid } from './connection.js';

interface ProviderRow {
  id: string;
  organizationId: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: SecretEnvelope | null;
  redirectUri: string;
  enabled: boolean;
  revision: number;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface LoginTransaction {
  id: string;
  browserHash: string;
  providerId: string;
  providerRevision: number;
  organizationId: string;
  verifier: SecretEnvelope;
  nonce: string;
  returnTo: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  azp?: string;
  exp: number;
  iat: number;
  nonce: string;
  email?: string;
  name?: string;
  preferred_username?: string;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const jwksCache = new Map<string, { expiresAt: number; keys: Array<Record<string, unknown>> }>();

function safeReturnTo(value: unknown): string {
  if (value === undefined) return '/';
  if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || value.startsWith('//') || /[\r\n]/u.test(value)) throw new RepositoryError(400, '登录返回地址无效');
  return value;
}

function jsonBase64(value: string): Record<string, unknown> {
  if (value.length > 65536) throw new RepositoryError(401, '身份令牌内容过大');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('invalid');
    return parsed as Record<string, unknown>;
  } catch {
    throw new RepositoryError(401, '身份令牌格式无效');
  }
}

function allowedOrigin(issuer: string): string {
  let url: URL;
  try { url = new URL(issuer); } catch { throw new RepositoryError(400, '身份源 issuer 无效'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new RepositoryError(400, '身份源必须使用 HTTPS，只有本机测试允许 HTTP');
  if (url.username || url.password || url.search || url.hash) throw new RepositoryError(400, '身份源 issuer 不能包含凭据、查询或片段');
  return url.origin;
}

async function boundedJson(url: string, origin: string): Promise<Record<string, unknown>> {
  let target: URL;
  try { target = new URL(url); } catch { throw new RepositoryError(502, '身份源端点无效'); }
  if (target.origin !== origin || target.username || target.password) throw new RepositoryError(502, '身份源端点必须与 issuer 同源');
  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new RepositoryError(502, '身份源请求失败');
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > 512 * 1024) throw new RepositoryError(502, '身份源响应过大');
  const text = await response.text();
  if (text.length > 512 * 1024) throw new RepositoryError(502, '身份源响应过大');
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new RepositoryError(502, '身份源响应格式无效'); }
}

async function discovery(provider: ProviderRow): Promise<Discovery> {
  const origin = allowedOrigin(provider.issuer);
  const value = await boundedJson(provider.issuer.replace(/\/$/u, '') + '/.well-known/openid-configuration', origin);
  if (value['issuer'] !== provider.issuer || typeof value['authorization_endpoint'] !== 'string' ||
    typeof value['token_endpoint'] !== 'string' || typeof value['jwks_uri'] !== 'string') {
    throw new RepositoryError(502, '身份源发现配置与登记的 issuer 不匹配');
  }
  for (const endpoint of [value['authorization_endpoint'], value['token_endpoint'], value['jwks_uri']]) {
    const parsed = new URL(endpoint);
    if (parsed.origin !== origin) throw new RepositoryError(502, '身份源端点跨域，已拒绝');
  }
  return value as unknown as Discovery;
}

async function keys(provider: ProviderRow, value: Discovery): Promise<Array<Record<string, unknown>>> {
  const cached = jwksCache.get(provider.id + ':' + provider.revision);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const body = await boundedJson(value.jwks_uri, allowedOrigin(provider.issuer));
  const list = body['keys'];
  if (!Array.isArray(list) || list.length > 30 || list.some(key => !key || typeof key !== 'object' || Array.isArray(key))) {
    throw new RepositoryError(502, '身份源签名密钥格式无效');
  }
  const result = list as Array<Record<string, unknown>>;
  jwksCache.set(provider.id + ':' + provider.revision, { expiresAt: Date.now() + 5 * 60 * 1000, keys: result });
  return result;
}

function validateIdToken(token: string, provider: ProviderRow, nonce: string, jwks: Array<Record<string, unknown>>): IdTokenClaims {
  if (typeof token !== 'string' || token.length > 32768) throw new RepositoryError(401, '身份令牌格式无效');
  const parts = token.split('.');
  if (parts.length !== 3) throw new RepositoryError(401, '身份令牌格式无效');
  const header = jsonBase64(parts[0]!), claims = jsonBase64(parts[1]!) as unknown as IdTokenClaims;
  if (header['alg'] !== 'RS256' || typeof header['kid'] !== 'string') throw new RepositoryError(401, '身份令牌签名算法不受支持');
  const jwk = jwks.find(key => key['kid'] === header['kid'] && key['kty'] === 'RSA' && key['use'] === 'sig');
  if (!jwk) throw new RepositoryError(401, '身份令牌签名密钥未知');
  let valid = false;
  try {
    valid = verifySignature('RSA-SHA256', Buffer.from(parts[0]! + '.' + parts[1]!), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2]!, 'base64url'));
  } catch {
    valid = false;
  }
  if (!valid) throw new RepositoryError(401, '身份令牌签名无效');
  const now = Math.floor(Date.now() / 1000), audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== provider.issuer || !audience.includes(provider.clientId) || (audience.length > 1 && claims.azp !== provider.clientId) ||
    !Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.nonce !== nonce ||
    typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 1000) {
    throw new RepositoryError(401, '身份令牌 issuer、受众、时效或 nonce 校验失败');
  }
  return claims;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
  }
  return null;
}

export class IamRepository {
  constructor(private readonly db: Pool) {}

  async publicProviders() {
    return (await this.db.query(`SELECT p.id,p.name,o.name AS "organizationName"
      FROM identity.identity_providers p JOIN identity.organizations o ON o.id=p.organization_id
      WHERE p.enabled AND o.status='active' ORDER BY o.name,p.name LIMIT 20`)).rows;
  }

  async adminOverview(actor: string) {
    uuid(actor);
    return transaction(this.db, async c => {
      const organizations = (await c.query(`SELECT id,name,status,revision,created_at AS "createdAt"
        FROM identity.organizations ORDER BY name,id LIMIT 100`)).rows;
      const providers = (await c.query(`SELECT id,organization_id AS "organizationId",name,kind,issuer,client_id AS "clientId",
        redirect_uri AS "redirectUri",enabled,revision,updated_at AS "updatedAt"
        FROM identity.identity_providers ORDER BY name,id LIMIT 100`)).rows;
      const pending = (await c.query(`SELECT p.id,p.provider_id AS "providerId",p.organization_id AS "organizationId",
        p.issuer,p.subject,p.email,p.display_name AS "displayName",p.status,p.revision,p.created_at AS "createdAt"
        FROM identity.external_pending p WHERE p.status='pending' ORDER BY p.created_at,p.id LIMIT 100`)).rows;
      const events = (await c.query(`SELECT id,action,result,reason,correlation_id AS "correlationId",created_at AS "createdAt"
        FROM identity.identity_events ORDER BY created_at DESC,id DESC LIMIT 100`)).rows;
      return { organizations, providers, pending, events };
    }, actor);
  }

  async createOrganization(actor: string, name: string) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) throw new RepositoryError(400, '企业名称无效');
    uuid(actor);
    return transaction(this.db, async c => (await c.query(`INSERT INTO identity.organizations(id,name)
      VALUES($1,$2) RETURNING id,name,status,revision,created_at AS "createdAt"`, [randomUUID(), name.trim()])).rows[0], actor);
  }

  async createProvider(actor: string, input: {
    organizationId: string; name: string; issuer: string; clientId: string; clientSecret?: string; redirectUri: string; enabled?: boolean;
  }) {
    uuid(actor); uuid(input.organizationId);
    const issuerUrl = new URL(input.issuer).toString().replace(/\/$/u, '');
    allowedOrigin(issuerUrl);
    const redirect = new URL(input.redirectUri);
    if (redirect.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(redirect.hostname)) throw new RepositoryError(400, '回调地址必须使用 HTTPS');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 120) throw new RepositoryError(400, '身份源名称无效');
    if (typeof input.clientId !== 'string' || !input.clientId || input.clientId.length > 500) throw new RepositoryError(400, 'client_id 无效');
    const secret = input.clientSecret ? getSecretBox().encrypt(input.clientSecret) : null;
    return transaction(this.db, async c => {
      const org = await c.query("SELECT 1 FROM identity.organizations WHERE id=$1 AND status='active'", [input.organizationId]);
      if (!org.rowCount) throw new RepositoryError(404, '企业不存在或已停用');
      return (await c.query(`INSERT INTO identity.identity_providers(
          id,organization_id,name,issuer,client_id,client_secret,redirect_uri,enabled
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING id,organization_id AS "organizationId",name,issuer,client_id AS "clientId",
          redirect_uri AS "redirectUri",enabled,revision,updated_at AS "updatedAt"`,
      [randomUUID(), input.organizationId, input.name.trim(), issuerUrl, input.clientId, secret ? JSON.stringify(secret) : null, redirect.toString(), input.enabled === true])).rows[0];
    }, actor);
  }

  async updateProvider(actor: string, id: string, input: { enabled?: boolean; clientSecret?: string; revision: number }) {
    uuid(actor); uuid(id);
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) throw new RepositoryError(400, '身份源版本无效');
    return transaction(this.db, async c => {
      const current = (await c.query<ProviderRow>('SELECT id,revision FROM identity.identity_providers WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!current) throw new RepositoryError(404, '身份源不存在');
      if (current.revision !== input.revision) throw new RepositoryError(409, '身份源已更新');
      const updated = (await c.query(`UPDATE identity.identity_providers SET
          enabled=COALESCE($2,enabled),client_secret=COALESCE($3,client_secret),revision=revision+1,updated_at=now()
        WHERE id=$1 RETURNING revision,enabled`, [id, input.enabled ?? null, input.clientSecret ? JSON.stringify(getSecretBox().encrypt(input.clientSecret)) : null])).rows[0];
      await c.query(`INSERT INTO identity.identity_events(actor_id,provider_id,action,result,correlation_id)
        VALUES($1,$2,'provider_updated','success',$3)`, [actor, id, randomUUID()]);
      return updated;
    }, actor);
  }

  async approvePending(actor: string, id: string, userId: string, revision: number) {
    uuid(actor); uuid(id); uuid(userId);
    return transaction(this.db, async c => {
      const pending = (await c.query<{
        id: string; organizationId: string; providerId: string; issuer: string; subject: string;
        email: string | null; displayName: string | null; revision: number;
      }>(`SELECT id,organization_id AS "organizationId",provider_id AS "providerId",issuer,subject,email,
          display_name AS "displayName",revision
        FROM identity.external_pending WHERE id=$1 AND status='pending' FOR UPDATE`, [id])).rows[0];
      if (!pending) throw new RepositoryError(404, '待授权外部身份不存在');
      if (pending.revision !== revision) throw new RepositoryError(409, '待授权记录已更新');
      const user = await c.query('SELECT 1 FROM identity.users WHERE id=$1 AND NOT disabled', [userId]);
      if (!user.rowCount) throw new RepositoryError(404, '目标账号不存在或已停用');
      await c.query(`INSERT INTO identity.external_identities(id,provider_id,organization_id,user_id,issuer,subject,email,display_name)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(provider_id,issuer,subject) DO UPDATE SET user_id=EXCLUDED.user_id,email=EXCLUDED.email,display_name=EXCLUDED.display_name`,
      [randomUUID(), pending.providerId, pending.organizationId, userId, pending.issuer, pending.subject, pending.email, pending.displayName]);
      await c.query(`INSERT INTO identity.organization_members(organization_id,user_id,source)
        VALUES($1,$2,'oidc') ON CONFLICT(organization_id,user_id) DO UPDATE SET status='active',manual_disabled=false,revision=identity.organization_members.revision+1,updated_at=now()`,
      [pending.organizationId, userId]);
      const done = await c.query(`UPDATE identity.external_pending SET status='approved',revision=revision+1,decided_at=now(),decided_by=$2
        WHERE id=$1 RETURNING revision`, [id, actor]);
      await c.query(`INSERT INTO identity.identity_events(actor_id,organization_id,provider_id,subject_user_id,action,result,correlation_id)
        VALUES($1,$2,$3,$4,'external_identity_approved','success',$5)`, [actor, pending.organizationId, pending.providerId, userId, randomUUID()]);
      return { ok: true, revision: done.rows[0]?.revision };
    }, actor);
  }

  async rejectPending(actor: string, id: string, revision: number) {
    uuid(actor); uuid(id);
    return transaction(this.db, async c => {
      const updated = await c.query(`UPDATE identity.external_pending SET status='rejected',revision=revision+1,decided_at=now(),decided_by=$2
        WHERE id=$1 AND status='pending' AND revision=$3 RETURNING organization_id AS "organizationId",provider_id AS "providerId"`, [id, actor, revision]);
      if (!updated.rowCount) throw new RepositoryError(409, '待授权记录不存在或已更新');
      await c.query(`INSERT INTO identity.identity_events(actor_id,organization_id,provider_id,action,result,correlation_id)
        VALUES($1,$2,$3,'external_identity_rejected','denied',$4)`, [actor, updated.rows[0].organizationId, updated.rows[0].providerId, randomUUID()]);
      return { ok: true };
    }, actor);
  }

  async start(providerId: string, returnToValue: unknown, existingBinding?: string | null) {
    uuid(providerId);
    const returnTo = safeReturnTo(returnToValue);
    const provider = (await this.db.query<ProviderRow>(`SELECT p.id,p.organization_id AS "organizationId",p.name,p.issuer,p.client_id AS "clientId",
        p.client_secret AS "clientSecret",p.redirect_uri AS "redirectUri",p.enabled,p.revision
      FROM identity.identity_providers p JOIN identity.organizations o ON o.id=p.organization_id
      WHERE p.id=$1 AND p.enabled AND o.status='active'`, [providerId])).rows[0];
    if (!provider) throw new RepositoryError(404, '身份源不可用');
    const config = await discovery(provider);
    const state = random(), verifier = random(), nonce = random();
    const binding = existingBinding && /^[A-Za-z0-9_-]{43}$/u.test(existingBinding) ? existingBinding : random();
    const envelope = getSecretBox().encrypt(verifier);
    await this.db.query(`INSERT INTO identity.login_transactions(
        id,state_hash,browser_hash,provider_id,provider_revision,organization_id,verifier,nonce,return_to,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes')`, [
      randomUUID(), digest(state), digest(binding), provider.id, provider.revision, provider.organizationId,
      JSON.stringify(envelope), nonce, returnTo,
    ]);
    // 过期事务不再参与回调；只清理登录事务，不影响身份映射和审计。
    await this.db.query("DELETE FROM identity.login_transactions WHERE expires_at<now()-interval '1 day'");
    const url = new URL(config.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: provider.clientId, redirect_uri: provider.redirectUri, response_type: 'code',
      scope: 'openid profile email', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return { authorizationUrl: url.toString(), binding, maxAge: 300 };
  }

  async callback(state: string, code: string, binding: string | null) {
    if (!state || !code || !binding) throw new RepositoryError(400, 'OIDC 回调参数不完整');
    const tx = (await this.db.query<LoginTransaction>(`SELECT id,browser_hash AS "browserHash",provider_id AS "providerId",
        provider_revision AS "providerRevision",organization_id AS "organizationId",verifier,nonce,return_to AS "returnTo",
        expires_at AS "expiresAt",used_at AS "usedAt"
      FROM identity.login_transactions WHERE state_hash=$1`, [digest(state)])).rows[0];
    if (!tx || tx.usedAt || tx.expiresAt.getTime() <= Date.now() || tx.browserHash !== digest(binding)) {
      throw new RepositoryError(401, '登录事务不存在、已过期或浏览器不匹配');
    }
    const provider = (await this.db.query<ProviderRow>(`SELECT p.id,p.organization_id AS "organizationId",p.name,p.issuer,p.client_id AS "clientId",
        p.client_secret AS "clientSecret",p.redirect_uri AS "redirectUri",p.enabled,p.revision
      FROM identity.identity_providers p JOIN identity.organizations o ON o.id=p.organization_id
      WHERE p.id=$1 AND p.enabled AND o.status='active'`, [tx.providerId])).rows[0];
    if (!provider || provider.revision !== tx.providerRevision || !provider.clientSecret) throw new RepositoryError(409, '身份源配置已变化，请重新登录');
    const config = await discovery(provider);
    const verifier = getSecretBox().decrypt(tx.verifier);
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: provider.redirectUri, client_id: provider.clientId,
      client_secret: getSecretBox().decrypt(provider.clientSecret), code_verifier: verifier,
    });
    const response = await fetch(config.token_endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form,
    });
    if (!response.ok) throw new RepositoryError(401, '身份源拒绝授权码交换');
    const text = await response.text();
    if (text.length > 512 * 1024) throw new RepositoryError(502, '身份令牌响应过大');
    let tokens: Record<string, unknown>;
    try { tokens = JSON.parse(text) as Record<string, unknown>; } catch { throw new RepositoryError(502, '身份令牌响应格式无效'); }
    const idToken = tokens['id_token'];
    if (typeof idToken !== 'string') throw new RepositoryError(401, '身份源未返回 ID Token');
    const claims = validateIdToken(idToken, provider, tx.nonce, await keys(provider, config));
    return transaction(this.db, async c => {
      const locked = (await c.query('SELECT used_at AS "usedAt",expires_at AS "expiresAt",browser_hash AS "browserHash",organization_id AS "organizationId",return_to AS "returnTo" FROM identity.login_transactions WHERE id=$1 FOR UPDATE', [tx.id])).rows[0];
      if (!locked || locked.usedAt || locked.expiresAt.getTime() <= Date.now() || locked.browserHash !== digest(binding)) throw new RepositoryError(401, '登录事务已消费');
      await c.query('UPDATE identity.login_transactions SET used_at=now() WHERE id=$1', [tx.id]);
      const identity = (await c.query<{
        userId: string; memberActive: boolean; manualDisabled: boolean; userDisabled: boolean;
      }>(`SELECT e.user_id AS "userId",COALESCE(m.status='active',false) AS "memberActive",
          COALESCE(m.manual_disabled,false) AS "manualDisabled",u.disabled AS "userDisabled"
        FROM identity.external_identities e
        LEFT JOIN identity.organization_members m ON m.organization_id=e.organization_id AND m.user_id=e.user_id
        JOIN identity.users u ON u.id=e.user_id
        WHERE e.provider_id=$1 AND e.issuer=$2 AND e.subject=$3`, [provider.id, claims.iss, claims.sub])).rows[0];
      if (!identity) {
        await c.query(`INSERT INTO identity.external_pending(id,provider_id,organization_id,issuer,subject,email,display_name)
          VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(provider_id,issuer,subject) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,revision=identity.external_pending.revision+1`,
        [randomUUID(), provider.id, locked.organizationId, claims.iss, claims.sub, claims.email ?? null, claims.name ?? claims.preferred_username ?? null]);
        await c.query(`INSERT INTO identity.identity_events(organization_id,provider_id,action,result,reason,correlation_id)
          VALUES($1,$2,'oidc_login','denied','等待管理员绑定本地账号',$3)`, [locked.organizationId, provider.id, tx.id]);
        return { status: 'pending' as const, returnTo: locked.returnTo };
      }
      if (!identity.memberActive || identity.manualDisabled || identity.userDisabled) {
        await c.query(`INSERT INTO identity.identity_events(organization_id,provider_id,subject_user_id,action,result,reason,correlation_id)
          VALUES($1,$2,$3,'oidc_login','denied','企业成员或本地账号已停用',$4)`, [locked.organizationId, provider.id, identity.userId, tx.id]);
        return { status: 'denied' as const, returnTo: locked.returnTo };
      }
      await c.query('UPDATE identity.external_identities SET last_login_at=now(),email=$4,display_name=$5 WHERE provider_id=$1 AND issuer=$2 AND subject=$3', [
        provider.id, claims.iss, claims.sub, claims.email ?? null, claims.name ?? claims.preferred_username ?? null,
      ]);
      const ticket = random();
      await c.query(`INSERT INTO identity.oidc_completions(ticket_hash,user_id,browser_hash,return_to,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '90 seconds')`, [digest(ticket), identity.userId, digest(binding), locked.returnTo]);
      await c.query(`INSERT INTO identity.identity_events(organization_id,provider_id,subject_user_id,action,result,correlation_id)
        VALUES($1,$2,$3,'oidc_login','success',$4)`, [locked.organizationId, provider.id, identity.userId, tx.id]);
      return { status: 'authorized' as const, ticket, returnTo: locked.returnTo };
    });
  }

  async complete(ticket: string, binding: string | null) {
    if (!ticket || !binding) throw new RepositoryError(400, '登录完成凭据缺失');
    return transaction(this.db, async c => {
      const row = (await c.query<{ userId: string; browserHash: string; expiresAt: Date; consumedAt: Date | null; returnTo: string }>(`SELECT user_id AS "userId",
          browser_hash AS "browserHash",expires_at AS "expiresAt",consumed_at AS "consumedAt",return_to AS "returnTo"
        FROM identity.oidc_completions WHERE ticket_hash=$1 FOR UPDATE`, [digest(ticket)])).rows[0];
      if (!row || row.consumedAt || row.expiresAt.getTime() <= Date.now() || row.browserHash !== digest(binding)) throw new RepositoryError(401, '登录完成凭据无效或已使用');
      await c.query('UPDATE identity.oidc_completions SET consumed_at=now() WHERE ticket_hash=$1', [digest(ticket)]);
      return row;
    });
  }
}

export { cookieValue as oidcBindingCookie };
