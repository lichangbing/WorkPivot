import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Pool, PoolClient } from 'pg';
import { RepositoryError, transaction, uuid } from './connection.js';

export interface DatabaseUser { id: string; username: string; role: 'admin' | 'member'; platformAdmin: boolean; mustChangePassword: boolean }
const userColumns = 'u.id,u.username,u.role,u.platform_admin AS "platformAdmin",c.must_change AS "mustChangePassword"';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
function passwordValid(password: string): void {
  if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 72) throw new RepositoryError(400, '密码需至少6位，且不超过72字节');
}
function usernameValid(value: string): string {
  if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 80) throw new RepositoryError(400, '用户名需为2至80个字符');
  return value.trim().normalize('NFKC');
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
  const token = randomBytes(32).toString('base64url');
  await client.query("INSERT INTO identity.sessions(token_digest,user_id,auth_version,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [digest(token), id, version]);
  return token;
}
async function audit(client: PoolClient, actor: string, target: string, action: string): Promise<void> {
  await client.query('INSERT INTO identity.audit_events(actor_id,target_id,action) VALUES($1,$2,$3)', [actor, target, action]);
}

export class AccountRepository {
  constructor(private readonly db: Pool) {}
  async needsSetup(): Promise<boolean> { return !(await this.db.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount; }
  async registerFirst(username: string, password: string, supplied: string, expected: string): Promise<{ token: string; user: DatabaseUser }> {
    const name = usernameValid(username); passwordValid(password);
    const left = Buffer.from(supplied), right = Buffer.from(expected);
    if (right.length < 24 || left.length !== right.length || !timingSafeEqual(left, right)) throw new RepositoryError(403, '初始化凭据无效');
    const hash = await bcrypt.hash(password, 10);
    return transaction(this.db, async client => {
      await client.query('SELECT pg_advisory_xact_lock(937032)');
      if ((await client.query('SELECT 1 FROM identity.users LIMIT 1')).rowCount) throw new RepositoryError(409, '已有用户，注册已关闭');
      const id = randomUUID();
      await client.query("INSERT INTO identity.users(id,username,username_key,role,platform_admin) VALUES($1,$2,$3,'admin',true)", [id, name, name.toLowerCase()]);
      await client.query('INSERT INTO identity.credentials(user_id,password_hash) VALUES($1,$2)', [id, hash]);
      await audit(client, id, id, 'first_admin_created');
      return { token: await issue(client, id, 1), user: { id, username: name, role: 'admin', platformAdmin: true, mustChangePassword: false } };
    });
  }
  async login(username: string, password: string): Promise<{ token: string; user: DatabaseUser }> {
    if (typeof username !== 'string' || typeof password !== 'string' || Buffer.byteLength(password) > 72) throw new RepositoryError(401, '用户名或密码错误');
    const row = (await this.db.query(`SELECT ${userColumns},c.password_hash,c.auth_version FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id WHERE u.username_key=$1 AND NOT u.disabled`, [username.trim().normalize('NFKC').toLowerCase()])).rows[0];
    // 未知用户名也通过固定占位哈希执行 bcrypt 校验。
    const valid = await bcrypt.compare(password, row?.password_hash ?? '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
    if (!row || !valid) throw new RepositoryError(401, '用户名或密码错误');
    return transaction(this.db, async client => {
      const current = (await client.query(`SELECT ${userColumns},c.password_hash,c.auth_version FROM identity.users u JOIN identity.credentials c ON c.user_id=u.id WHERE u.id=$1 AND NOT u.disabled FOR UPDATE OF c`, [row.id])).rows[0];
      if (!current || current.password_hash !== row.password_hash || current.auth_version !== row.auth_version) throw new RepositoryError(401, '凭据已更新，请重新登录');
      const user: DatabaseUser = { id: current.id, username: current.username, role: current.role, platformAdmin: current.platformAdmin, mustChangePassword: current.mustChangePassword };
      return { token: await issue(client, user.id, current.auth_version), user };
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
  async createUser(token: string, username: string, password: string, role: 'admin' | 'member'): Promise<DatabaseUser> {
    const name = usernameValid(username); passwordValid(password);
    if (!['admin', 'member'].includes(role)) throw new RepositoryError(400, '角色无效');
    const hash = await bcrypt.hash(password, 10);
    return transaction(this.db, async client => {
      const actor = await administrator(client, token), id = randomUUID();
      const exists = await client.query('SELECT 1 FROM identity.users WHERE username_key=$1', [name.toLowerCase()]);
      if (exists.rowCount) throw new RepositoryError(409, '用户名已存在');
      await client.query('INSERT INTO identity.users(id,username,username_key,role) VALUES($1,$2,$3,$4)', [id, name, name.toLowerCase(), role]);
      await client.query('INSERT INTO identity.credentials(user_id,password_hash,must_change) VALUES($1,$2,true)', [id, hash]);
      await audit(client, actor.id, id, 'user_created');
      return { id, username: name, role, platformAdmin: false, mustChangePassword: true };
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
