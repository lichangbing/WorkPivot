import { randomBytes, randomUUID, createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface DatabaseUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
  platformAdmin: boolean;
  mustChangePassword: boolean;
  email: string | null;
  disabled: boolean;
  messageQuota: number;
  messagesUsed: number;
  quotaResetAt: string | null;
  tokenQuota: number;
  tokensUsed: number;
  uploadQuotaBytes: number;
  uploadBytesUsed: number;
  concurrentTaskLimit: number;
  provisioningSource: 'first_admin' | 'self' | 'admin' | 'legacy';
  limitsRevision: number;
  createdAt: string;
  lastLoginAt: string | null;
  activeSessions: number;
}
export interface AccessPolicy {
  registrationMode: 'closed' | 'open';
  defaultMessageQuota: number;
  defaultTokenQuota: number;
  defaultUploadQuotaBytes: number;
  defaultConcurrentTaskLimit: number;
  revision: number;
}
const userColumns = `u.id,u.username,u.role,u.platform_admin AS "platformAdmin",
  c.must_change AS "mustChangePassword",u.email,u.disabled,
  u.message_quota AS "messageQuota",
  CASE WHEN u.quota_reset_at<=now() THEN 0 ELSE u.messages_used END AS "messagesUsed",
  u.quota_reset_at AS "quotaResetAt",
  u.token_quota::double precision AS "tokenQuota",
  CASE WHEN u.usage_period_started_at<identity.quota_period_start(now()) THEN 0 ELSE u.tokens_used END::double precision AS "tokensUsed",
  u.upload_quota_bytes::double precision AS "uploadQuotaBytes",
  CASE WHEN u.usage_period_started_at<identity.quota_period_start(now()) THEN 0 ELSE u.upload_bytes_used END::double precision AS "uploadBytesUsed",
  u.concurrent_task_limit AS "concurrentTaskLimit",
  u.provisioning_source AS "provisioningSource",
  u.limits_revision AS "limitsRevision",
  u.created_at AS "createdAt",
  u.last_login_at AS "lastLoginAt",
  (SELECT count(*)::int FROM identity.sessions sx WHERE sx.user_id=u.id AND sx.revoked_at IS NULL AND sx.expires_at>now() AND sx.auth_version=c.auth_version) AS "activeSessions"`;
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
function passwordValid(password: string): void {
  if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 72) throw new RepositoryError(400, '密码需至少6位，且不超过72字节');
}
function usernameValid(value: string): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 80) throw new RepositoryError(400, '用户名需为2至80个字符');
  return value.trim().normalize('NFKC');
}
function emailValid(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new RepositoryError(400, '邮箱格式无效');
  const email = value.trim().normalize('NFKC').toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new RepositoryError(400, '邮箱格式无效');
  return email;
}
function quotaValid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000) throw new RepositoryError(400, '每日提问额度需为0至100000的整数');
  return value;
}
function bigintQuotaValid(value: unknown, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new RepositoryError(400, `${label}需为0至${maximum}的整数`);
  return value;
}
async function accessPolicy(c: PoolClient): Promise<AccessPolicy> {
  const row = (await c.query(`SELECT registration_mode AS "registrationMode",
    default_message_quota AS "defaultMessageQuota",
    default_token_quota::double precision AS "defaultTokenQuota",
    default_upload_quota_bytes::double precision AS "defaultUploadQuotaBytes",
    default_concurrent_task_limit AS "defaultConcurrentTaskLimit",
    revision
    FROM identity.access_policy WHERE singleton`)).rows[0];
  if (!row) throw new RepositoryError(503, '注册策略未初始化');
  return row as AccessPolicy;
}
async function loadUser(c: PoolClient, id: string): Promise<DatabaseUser> {
  const user = (await c.query<DatabaseUser>(`SELECT ${userColumns}
    FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id
    WHERE u.id=$1`, [id])).rows[0];
  if (!user) throw new RepositoryError(404, '用户不存在');
  return user;
}
async function resolve(client: PoolClient, token: string): Promise<DatabaseUser | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const result = await client.query<DatabaseUser>(`SELECT ${userColumns} FROM identity.sessions s
    JOIN identity.users u ON u.id=s.user_id JOIN identity.credentials c ON c.user_id=u.id
    WHERE s.token_digest=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.auth_version=c.auth_version AND NOT u.disabled`, [digest(token)]);
  return result.rows[0] ?? null;
}
async function administrator(client: PoolClient, token: string): Promise<DatabaseUser> {
  const user = await resolve(client, token);
  if (!user || user.role !== 'admin' || user.mustChangePassword) throw new RepositoryError(403, '需要有效管理员登录');
  return user;
}
async function issue(client: PoolClient, id: string, version: number): Promise<string> {
  const configured = Number(process.env['WORKPIVOT_SESSION_TTL_HOURS'] ?? 24);
  const ttlHours = Number.isSafeInteger(configured) && configured > 0 && configured <= 720 ? configured : 24;
  const token = randomBytes(32).toString('base64url');
  await client.query("INSERT INTO identity.sessions(token_digest,user_id,auth_version,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 hour')", [digest(token), id, version, ttlHours]);
  return token;
}
async function audit(client: PoolClient, actor: string, target: string, action: string): Promise<void> {
  await client.query('INSERT INTO identity.audit_events(actor_id,target_id,action) VALUES($1,$2,$3)', [actor, target, action]);
}

type QuotaRow = { platform_admin: boolean; message_quota: number | string; messages_used: number | string; quota_reset_at?: Date | string | null };

/** 与数据库函数保持一致：北京时间每天12:00进入下一额度周期。 */
export function nextQuotaReset(at = new Date()): Date {
  const shanghai = new Date(at.getTime() + 8 * 60 * 60 * 1000);
  const todayNoon = Date.UTC(shanghai.getUTCFullYear(), shanghai.getUTCMonth(), shanghai.getUTCDate(), 12) - 8 * 60 * 60 * 1000;
  return new Date(todayNoon > at.getTime() ? todayNoon : todayNoon + 24 * 60 * 60 * 1000);
}

/** 已过每日重置点时，旧 usage 不应继续占用新周期额度。 */
export function quotaPeriodUsed(row: QuotaRow, now = new Date()): number {
  if (!row.quota_reset_at) return Number(row.messages_used);
  const resetAt = row.quota_reset_at instanceof Date ? row.quota_reset_at : new Date(row.quota_reset_at);
  return Number.isFinite(resetAt.getTime()) && resetAt <= now ? 0 : Number(row.messages_used);
}

/** 演示额度判定（纯函数，便于单测边界）：platform_admin 或 quota=0 视为不限。 */
export function quotaDecision(row: QuotaRow, now = new Date()): { unlimited: boolean; remaining: number | null } {
  const limit = Number(row.message_quota);
  const used = quotaPeriodUsed(row, now);
  if (row.platform_admin || limit === 0) return { unlimited: true, remaining: null };
  return { unlimited: false, remaining: Math.max(0, limit - used) };
}

export class AccountRepository {
  constructor(private readonly db: Pool) {}
  async needsSetup(): Promise<boolean> { return !(await this.db.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount; }
  async publicAccessPolicy(): Promise<AccessPolicy & { registrationEnabled: boolean }> {
    return transaction(this.db, async client => {
      const policy = await accessPolicy(client);
      const setup = !(await client.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount;
      return { ...policy, registrationEnabled: setup || policy.registrationMode === 'open' };
    });
  }
  async adminAccessPolicy(token: string): Promise<AccessPolicy> {
    return transaction(this.db, async client => {
      await administrator(client, token);
      return accessPolicy(client);
    });
  }
  async updateAccessPolicy(token: string, input: {
    registrationMode: unknown;
    defaultMessageQuota: unknown;
    defaultTokenQuota?: unknown;
    defaultUploadQuotaBytes?: unknown;
    defaultConcurrentTaskLimit?: unknown;
    revision: unknown;
  }): Promise<AccessPolicy> {
    if (!['closed', 'open'].includes(String(input.registrationMode))) throw new RepositoryError(400, '注册策略无效');
    const revision = Number(input.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new RepositoryError(400, '策略版本无效');
    const defaultMessageQuota = quotaValid(input.defaultMessageQuota);
    return transaction(this.db, async client => {
      const actor = await administrator(client, token);
      const current = await accessPolicy(client);
      if (current.revision !== revision) throw new RepositoryError(409, '注册策略已变化，请刷新');
      const defaultTokenQuota = input.defaultTokenQuota === undefined ? current.defaultTokenQuota : bigintQuotaValid(input.defaultTokenQuota, 1000000000, '默认每日 Token 限额');
      const defaultUploadQuotaBytes = input.defaultUploadQuotaBytes === undefined ? current.defaultUploadQuotaBytes : bigintQuotaValid(input.defaultUploadQuotaBytes, 1099511627776, '默认每日上传额度');
      const defaultConcurrentTaskLimit = input.defaultConcurrentTaskLimit === undefined ? current.defaultConcurrentTaskLimit : bigintQuotaValid(input.defaultConcurrentTaskLimit, 100, '默认并发任务数');
      const row = (await client.query(`UPDATE identity.access_policy SET registration_mode=$1,
        default_message_quota=$2,default_token_quota=$3,default_upload_quota_bytes=$4,
        default_concurrent_task_limit=$5,revision=revision+1,updated_at=now()
        WHERE singleton AND revision=$6
        RETURNING registration_mode AS "registrationMode",default_message_quota AS "defaultMessageQuota",
          default_token_quota::double precision AS "defaultTokenQuota",
          default_upload_quota_bytes::double precision AS "defaultUploadQuotaBytes",
          default_concurrent_task_limit AS "defaultConcurrentTaskLimit",revision`,
      [input.registrationMode, defaultMessageQuota, defaultTokenQuota, defaultUploadQuotaBytes, defaultConcurrentTaskLimit, revision])).rows[0];
      if (!row) throw new RepositoryError(409, '注册策略已变化，请刷新');
      await audit(client, actor.id, actor.id, `registration_policy_${String(input.registrationMode)}`);
      return row as AccessPolicy;
    });
  }
  /** 自助注册：首个账户仍为管理员；后续账户仅在管理员明确开放注册时创建。 */
  async register(username: string, password: string): Promise<{ token: string; user: DatabaseUser }> {
    const name = usernameValid(username); passwordValid(password);
    const hash = await bcrypt.hash(password, 10);
    return transaction(this.db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(937032)');
      const first = !(await client.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount;
      const policy = await accessPolicy(client);
      if (!first && policy.registrationMode !== 'open') throw new RepositoryError(403, '自助注册已关闭，请联系管理员创建账户');
      const id = randomUUID();
      await client.query(
        `INSERT INTO identity.users(
          id,username,username_key,role,platform_admin,message_quota,token_quota,
          upload_quota_bytes,concurrent_task_limit,provisioning_source
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, name, name.toLowerCase(), first ? 'admin' : 'member', first,
          first ? 0 : policy.defaultMessageQuota, first ? 0 : policy.defaultTokenQuota,
          first ? 0 : policy.defaultUploadQuotaBytes, first ? 0 : policy.defaultConcurrentTaskLimit,
          first ? 'first_admin' : 'self'],
      );
      await client.query('INSERT INTO identity.credentials(user_id,password_hash) VALUES($1,$2)', [id, hash]);
      await audit(client, id, id, first ? 'first_admin_created' : 'user_registered');
      const token = await issue(client, id, 1);
      return { token, user: await loadUser(client, id) };
    });
  }

  /** 演示额度：消费一次用户消息；返回剩余次数（null 表示不限）。 */
  async consumeMessageQuota(actor: string): Promise<number | null> {
    const resetAt = nextQuotaReset();
    const updated = await this.db.query(
      `UPDATE identity.users SET
         messages_used=CASE WHEN quota_reset_at<=now() THEN 1 ELSE messages_used+1 END,
         quota_reset_at=CASE WHEN quota_reset_at<=now() THEN $2 ELSE quota_reset_at END
       WHERE id=$1 AND NOT platform_admin AND message_quota>0
         AND (quota_reset_at<=now() OR messages_used<message_quota)
       RETURNING message_quota-messages_used AS remaining`,
      [actor, resetAt],
    );
    if (updated.rowCount) return Number(updated.rows[0].remaining);
    const row = (await this.db.query('SELECT platform_admin,message_quota,messages_used,quota_reset_at FROM identity.users WHERE id=$1', [actor])).rows[0];
    if (!row) throw new RepositoryError(401, '账号不存在');
    if (row.platform_admin || Number(row.message_quota) === 0) return null;
    throw new RepositoryError(429, `演示额度已用完（${row.message_quota} 次），请联系管理员开通`);
  }

  /** 当前额度状态，供前端展示与禁用输入。 */
  async quota(actor: string): Promise<{ used: number; limit: number; remaining: number | null; resetsAt: string }> {
    const row = (await this.db.query('SELECT platform_admin,message_quota,messages_used,quota_reset_at FROM identity.users WHERE id=$1', [actor])).rows[0];
    if (!row) throw new RepositoryError(401, '账号不存在');
    const now = new Date(), resetAt = new Date(row.quota_reset_at), decision = quotaDecision(row, now);
    return { used: quotaPeriodUsed(row, now), limit: Number(row.message_quota), remaining: decision.remaining, resetsAt: (resetAt <= now ? nextQuotaReset(now) : resetAt).toISOString() };
  }

  async registerFirst(username: string, password: string): Promise<{ token: string; user: DatabaseUser }> {
    const name = usernameValid(username); passwordValid(password);
    // 首启不再校验初始化凭据：第一个注册的账户就是管理员。
    const hash = await bcrypt.hash(password, 10);
    return transaction(this.db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(937032)');
      if ((await client.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount) throw new RepositoryError(409, '已有用户，注册已关闭');
      const id = randomUUID();
      await client.query(`INSERT INTO identity.users(
        id,username,username_key,role,platform_admin,message_quota,token_quota,
        upload_quota_bytes,concurrent_task_limit,provisioning_source
      ) VALUES($1,$2,$3,'admin',true,0,0,0,0,'first_admin')`, [id, name, name.toLowerCase()]);
      await client.query('INSERT INTO identity.credentials(user_id,password_hash) VALUES($1,$2)', [id, hash]);
      await audit(client, id, id, 'first_admin_created');
      const token = await issue(client, id, 1);
      return { token, user: await loadUser(client, id) };
    });
  }
  async login(username: string, password: string): Promise<{ token: string; user: DatabaseUser }> {
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(password) > 72) throw new RepositoryError(401, '用户名或密码错误');
    const row = (await this.db.query(`SELECT ${userColumns},c.password_hash,c.auth_version FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id WHERE u.username_key=$1 AND NOT u.disabled`, [username.trim().normalize('NFKC').toLowerCase()])).rows[0];
    // 未知用户名也通过固定占位哈希执行 bcrypt 校验。
    const valid = await bcrypt.compare(password, row?.password_hash ?? '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!row || !valid) {
      await this.db.query("INSERT INTO identity.audit_events(actor_id,target_id,action) VALUES(NULL,NULL,'login_failed')").catch(() => undefined);
      throw new RepositoryError(401, '用户名或密码错误');
    }
    return transaction(this.db, async client => {
      const current = (await client.query(`SELECT ${userColumns},c.password_hash,c.auth_version FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id WHERE u.id=$1 AND NOT u.disabled FOR UPDATE OF c`, [row.id])).rows[0];
      if (!current || current.password_hash !== row.password_hash || current.auth_version !== row.auth_version) throw new RepositoryError(401, '凭据已更新，请重新登录');
      const token = await issue(client, current.id, current.auth_version);
      await client.query('UPDATE identity.users SET last_login_at=now() WHERE id=$1', [current.id]);
      await audit(client, current.id, current.id, 'login_succeeded');
      return { token, user: await loadUser(client, current.id) };
    });
  }
  async resolve(token: string): Promise<DatabaseUser | null> { return transaction(this.db, client => resolve(client, token)); }
  async logout(token: string): Promise<void> { await this.db.query('UPDATE identity.sessions SET revoked_at=now() WHERE token_digest=$1', [digest(token)]); }
  async sessions(token: string): Promise<Array<{ id: string; createdAt: string; expiresAt: string; current: boolean }>> {
    return transaction(this.db, async client => {
      const user = await resolve(client, token);
      if (!user) throw new RepositoryError(401, '登录已失效');
      // 仅返回独立的管理标识，不能暴露登录令牌及其摘要。
      return (await client.query(`SELECT s.id,s.created_at AS "createdAt",s.expires_at AS "expiresAt",s.token_digest=$2 AS current
        FROM identity.sessions s JOIN identity.credentials c ON c.user_id=s.user_id
        WHERE s.user_id=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND s.auth_version=c.auth_version
        ORDER BY s.created_at DESC,s.id`, [user.id, digest(token)])).rows;
    });
  }
  async revokeSession(token: string, id: string): Promise<void> {
    uuid(id);
    await transaction(this.db, async client => {
      const user = await resolve(client, token);
      if (!user) throw new RepositoryError(401, '登录已失效');
      const result = await client.query(`UPDATE identity.sessions SET revoked_at=now()
        WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()
        RETURNING id`, [id, user.id]);
      if (!result.rowCount) throw new RepositoryError(404, '会话不存在或已失效');
      await audit(client, user.id, user.id, 'session_revoked');
    });
  }
  async listUsers(token: string): Promise<DatabaseUser[]> {
    return transaction(this.db, async client => { await administrator(client, token); return (await client.query<DatabaseUser>(`SELECT ${userColumns} FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id ORDER BY u.created_at,u.id`)).rows; });
  }
  async createUser(token: string, username: string, password: string, role: 'admin' | 'member', emailInput?: unknown): Promise<DatabaseUser> {
    const name = usernameValid(username); passwordValid(password);
    if (!['admin', 'member'].includes(role)) throw new RepositoryError(400, '角色无效');
    const email = emailValid(emailInput);
    const hash = await bcrypt.hash(password, 10);
    return transaction(this.db, async client => {
      const actor = await administrator(client, token), id = randomUUID();
      const exists = await client.query('SELECT 1 FROM identity.users WHERE username_key=$1', [name.toLowerCase()]);
      if (exists.rowCount) throw new RepositoryError(409, '用户名已存在');
      if (email && (await client.query('SELECT 1 FROM identity.users WHERE lower(email)=$1', [email])).rowCount) throw new RepositoryError(409, '邮箱已被使用');
      // 管理员创建的账户默认不设限；后续可在独立“限额管理”中按用户开启。
      await client.query(`INSERT INTO identity.users(
        id,username,username_key,role,email,message_quota,token_quota,
        upload_quota_bytes,concurrent_task_limit,provisioning_source
      ) VALUES($1,$2,$3,$4,$5,0,0,0,0,'admin')`, [id, name, name.toLowerCase(), role, email]);
      await client.query('INSERT INTO identity.credentials(user_id,password_hash,must_change) VALUES($1,$2,true)', [id, hash]);
      await audit(client, actor.id, id, 'user_created');
      return loadUser(client, id);
    });
  }
  async updateUser(token: string, targetId: string, input: Record<string, unknown>): Promise<DatabaseUser> {
    uuid(targetId);
    return transaction(this.db, async client => {
      const actor = await administrator(client, token);
      const target = (await client.query(`SELECT id,username,role,platform_admin,disabled,email,message_quota
        FROM identity.users WHERE id=$1 FOR UPDATE`, [targetId])).rows[0];
      if (!target) throw new RepositoryError(404, '用户不存在');
      if (target.platform_admin) throw new RepositoryError(400, '平台管理员的角色、状态和额度受保护');
      const role = input.role === undefined ? target.role : input.role;
      if (role !== 'admin' && role !== 'member') throw new RepositoryError(400, '角色无效');
      const disabled = input.disabled === undefined ? target.disabled : input.disabled;
      if (typeof disabled !== 'boolean') throw new RepositoryError(400, '账户状态无效');
      const messageQuota = input.messageQuota === undefined ? Number(target.message_quota) : quotaValid(input.messageQuota);
      const email = input.email === undefined ? target.email : emailValid(input.email);
      if (actor.id === targetId && (role !== target.role || disabled !== target.disabled)) throw new RepositoryError(400, '不能修改自己的角色或停用自己');
      if (target.role === 'admin' && (role !== 'admin' || disabled)) {
        const activeAdmins = Number((await client.query("SELECT count(*)::int AS n FROM identity.users WHERE role='admin' AND NOT disabled")).rows[0].n);
        if (activeAdmins <= 1) throw new RepositoryError(409, '不能停用或降级最后一个有效管理员');
      }
      if (email && email !== target.email && (await client.query('SELECT 1 FROM identity.users WHERE lower(email)=$1 AND id<>$2', [email, targetId])).rowCount) throw new RepositoryError(409, '邮箱已被使用');
      await client.query(`UPDATE identity.users SET role=$2,disabled=$3,message_quota=$4,email=$5,updated_at=now()
        WHERE id=$1`, [targetId, role, disabled, messageQuota, email]);
      if (disabled && !target.disabled) {
        await client.query('UPDATE identity.credentials SET auth_version=auth_version+1 WHERE user_id=$1', [targetId]);
        await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [targetId]);
      }
      await audit(client, actor.id, targetId, disabled !== target.disabled ? (disabled ? 'user_disabled' : 'user_enabled') : 'user_updated');
      return loadUser(client, targetId);
    });
  }
  async revokeUserSessions(token: string, targetId: string): Promise<void> {
    uuid(targetId);
    await transaction(this.db, async client => {
      const actor = await administrator(client, token);
      if (actor.id === targetId) throw new RepositoryError(400, '请在个人设置中撤销自己的其他会话');
      const target = (await client.query('SELECT platform_admin FROM identity.users WHERE id=$1', [targetId])).rows[0];
      if (!target) throw new RepositoryError(404, '用户不存在');
      if (target.platform_admin) throw new RepositoryError(400, '平台管理员会话受保护');
      await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [targetId]);
      await audit(client, actor.id, targetId, 'user_sessions_revoked');
    });
  }
  async resetUserQuota(token: string, targetId: string): Promise<void> {
    uuid(targetId);
    await transaction(this.db, async client => {
      const actor = await administrator(client, token);
      const target = (await client.query('SELECT platform_admin FROM identity.users WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
      if (!target) throw new RepositoryError(404, '用户不存在');
      if (target.platform_admin) throw new RepositoryError(400, '平台管理员不限额度');
      await client.query(`UPDATE identity.users SET messages_used=0,tokens_used=0,upload_bytes_used=0,quota_reset_at=$2,
        usage_period_started_at=now(),limits_revision=limits_revision+1,updated_at=now() WHERE id=$1`, [targetId, nextQuotaReset()]);
      await audit(client, actor.id, targetId, 'user_quota_reset');
    });
  }
  async resetPassword(token: string, targetId: string): Promise<{ temporaryPassword: string }> {
    uuid(targetId);
    const temporaryPassword = 'Wp!' + randomBytes(18).toString('base64url');
    const hash = await bcrypt.hash(temporaryPassword, 10);
    return transaction(this.db, async client => {
      const actor = await administrator(client, token);
      const target = (await client.query('SELECT u.platform_admin FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id WHERE u.id=$1 FOR UPDATE OF c', [targetId])).rows[0];
      if (!target) throw new RepositoryError(404, '用户不存在');
      if (actor.id === targetId || target.platform_admin) throw new RepositoryError(400, '自己的密码请通过修改密码设置，平台管理员不能被重置');
      await client.query('UPDATE identity.credentials SET password_hash=$2,must_change=true,auth_version=auth_version+1 WHERE user_id=$1', [targetId, hash]);
      await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [targetId]);
      await audit(client, actor.id, targetId, 'password_reset');
      return { temporaryPassword };
    });
  }
  async changePassword(token: string, current: string, next: string): Promise<void> {
    passwordValid(current); passwordValid(next);
    const session = await this.resolve(token);
    if (!session) throw new RepositoryError(401, '登录已失效');
    const snapshot = (await this.db.query('SELECT password_hash,auth_version FROM identity.credentials WHERE user_id=$1', [session.id])).rows[0];
    if (!snapshot || !await bcrypt.compare(current, snapshot.password_hash)) throw new RepositoryError(400, '当前密码不正确');
    if (await bcrypt.compare(next, snapshot.password_hash)) throw new RepositoryError(400, '新密码不能相同');
    const hash = await bcrypt.hash(next, 10);
    await transaction(this.db, async client => {
      await client.query('SELECT 1 FROM identity.credentials WHERE user_id=$1 FOR UPDATE', [session.id]);
      if (!await resolve(client, token)) throw new RepositoryError(401, '登录已失效');
      const result = await client.query('UPDATE identity.credentials SET password_hash=$2,must_change=false,auth_version=auth_version+1 WHERE user_id=$1 AND auth_version=$3', [session.id, hash, snapshot.auth_version]);
      if (result.rowCount !== 1) throw new RepositoryError(409, '密码已被其他操作更新');
      await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [session.id]);
      await audit(client, session.id, session.id, 'password_changed');
    });
  }
}
