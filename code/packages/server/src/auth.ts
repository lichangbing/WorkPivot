import { tenantId, tenantHome, listTenants, withTenant, DEFAULT_TENANT, markFreshAccount } from './tenants.js';
/**
 * T2-01/J01（单机形态）：本地账户体系。
 * 首个注册用户自动成为管理员，此后注册关闭、由管理员创建用户（A01 登录门）。
 * 会话令牌持久化（重启免重复登录）；密码 bcrypt 哈希。
 */
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { join } from 'node:path';
import { appendLine, ensureWorkpivotDir, readJsonSafe, writeAtomic, writeAtomicWithBackup } from './store.js';
import type { Tier } from './permissions.js';

export type Role = 'admin' | 'member';

export interface User {
  tenantId?: string;
  platformAdmin?: boolean;
  mustChangePassword?: boolean;
  id: string;
  username: string;
  email?: string;
  hash: string;
  role: Role;
  /** RL1-02：个人权限档位（未自选 = 使用全局默认档）。 */
  tier?: Tier;
  createdAt: string;
  lastLoginTime?: string;
}

interface UsersFile {
  version: 1;
  users: User[];
}

interface SessionsFile {
  version: 1;
  tokens: Array<{ token: string; userId: string; createdAt: string; expiresAt?: string }>;
}

const EMPTY_USERS: UsersFile = { version: 1, users: [] };
const EMPTY_SESSIONS: SessionsFile = { version: 1, tokens: [] };

function usersPath(): string {
  return join(tenantHome(), 'data', 'users.json');
}

function sessionsPath(): string {
  return join(tenantHome(), 'data', 'sessions.json');
}

function loadUsers(): UsersFile {
  return readJsonSafe<UsersFile>(usersPath(), EMPTY_USERS, (value) => {
    const data = value as Partial<UsersFile> | null;
    return Boolean(data && data.version === 1 && Array.isArray(data.users) && data.users.length > 0 && data.users.some((u) => u.role === 'admin') && data.users.every((u) => (!u.tenantId || u.tenantId === tenantId()) && typeof u.id === 'string' && typeof u.username === 'string' && typeof u.hash === 'string' && (u.role === 'admin' || u.role === 'member')));
  }).value;
}

function normalizeEmail(email: string | null | undefined, file: UsersFile, excludeUserId?: string): string | undefined {
  const value = email?.trim();
  if (!value) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error('邮箱格式不正确');
  if (file.users.some((u) => u.id !== excludeUserId && u.email === value)) throw new Error('邮箱已被其他用户使用');
  return value;
}

export function needsSetup(): boolean {
  return loadUsers().users.length === 0;
}

export function setupTokenRequired(): boolean { return !['127.0.0.1', 'localhost', '::1'].includes(process.env['WORKPIVOT_HOST'] ?? '127.0.0.1'); }
export function validateInitialization(): void {
  if (needsSetup() && setupTokenRequired() && (process.env['WORKPIVOT_ADMIN_INIT_TOKEN']?.length ?? 0) < 24) throw new Error('对外监听首启必须配置至少 24 字符的 WORKPIVOT_ADMIN_INIT_TOKEN');
}
export function registerFirstAdmin(username: string, password: string, initToken?: string): { token: string; user: PublicUser } {
  const file = loadUsers();
  if (file.users.length > 0) throw new Error('已有用户存在：注册已关闭，请联系管理员开通账户');
  if (setupTokenRequired()) {
    const expected = Buffer.from(process.env['WORKPIVOT_ADMIN_INIT_TOKEN'] ?? '');
    const supplied = Buffer.from(typeof initToken === 'string' ? initToken.trim() : '');
    if (expected.length < 24 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('初始化凭据无效，请联系部署管理员');
  }
  return createUserAndToken(file, username, password, 'admin');
}

export function createUser(username: string, password: string, role: Role, email?: string): PublicUser {
  const file = loadUsers();
  if (file.users.length === 0) throw new Error('尚无用户：请先通过注册创建管理员');
  if (listTenants().some((t) => withTenant(t.id, () => loadUsers().users.some((u) => u.username === username.trim())))) throw new Error('用户名已存在');
  const { user } = createUserAndToken(file, username, password, role, email);
  return { id: user.id, tenantId: user.tenantId ?? tenantId(), platformAdmin: user.platformAdmin === true, mustChangePassword: user.mustChangePassword === true, username: user.username, email: user.email, role: user.role, tier: user.tier };
}

function createUserAndToken(
  file: UsersFile,
  username: string,
  password: string,
  role: Role,
  email?: string,
): { token: string; user: PublicUser } {
  if (username.trim().length < 2) throw new Error('用户名至少 2 个字符');
  if (password.length < 6) throw new Error('密码至少 6 位');
  if (listTenants().some((t) => withTenant(t.id, () => loadUsers().users.some((u) => u.username === username.trim())))) throw new Error('用户名已存在');
  const normalizedEmail = normalizeEmail(email, file);
  const user: User = {
    id: randomUUID(),
    tenantId: tenantId(),
    platformAdmin: tenantId() === DEFAULT_TENANT && file.users.length === 0,
    username: username.trim(),
    email: normalizedEmail,
    hash: bcrypt.hashSync(password, 10),
    role,
    createdAt: new Date().toISOString(),
  };
  markFreshAccount(user);
  file.users.push(user);
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_created', user: user.username, role, email: normalizedEmail ?? null }));
  const token = issueToken(user.id);
  return { token, user: { id: user.id, tenantId: user.tenantId ?? tenantId(), platformAdmin: user.platformAdmin === true, mustChangePassword: user.mustChangePassword === true, username: user.username, email: user.email, role: user.role, tier: user.tier } };
}

export interface PublicUser {
  tenantId?: string;
  platformAdmin?: boolean;
  mustChangePassword?: boolean;
  id: string;
  username: string;
  email?: string;
  role: Role;
  /** RL1-02：个人档位（未自选时为空 = 全局默认档）。 */
  tier?: Tier;
  createdAt?: string;
  lastLoginTime?: string;
}

export function login(username: string, password: string): { token: string; user: PublicUser } {
  const file = loadUsers();
  const user = file.users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.hash)) throw new Error('用户名或密码错误');
  user.lastLoginTime = new Date().toISOString();
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  const token = issueToken(user.id);
  return { token, user: { id: user.id, tenantId: user.tenantId ?? tenantId(), platformAdmin: user.platformAdmin === true, mustChangePassword: user.mustChangePassword === true, username: user.username, email: user.email, role: user.role, tier: user.tier, lastLoginTime: user.lastLoginTime } };
}

/** 不允许用户选择命名空间；旧名称含糊时默认拒绝。 */
export function loginAccount(username: string, password: string): { token: string; user: PublicUser } {
  const matches = listTenants().filter((t) => withTenant(t.id, () => loadUsers().users.some((u) => u.username === username.trim())));
  if (matches.length !== 1) throw new Error('用户名或密码错误');
  return withTenant(matches[0]!.id, () => login(username.trim(), password));
}

function issueToken(userId: string): string {
  const token = tenantId() + '.' + randomUUID() + randomUUID().replaceAll('-', '');
  const file = loadSessions();
  const configured = Number(process.env['WORKPIVOT_SESSION_TTL_HOURS'] ?? '24');
  if (!Number.isFinite(configured) || configured <= 0 || configured > 720) throw new Error('会话有效期必须为 0~720 小时之间的正数');
  const now = Date.now();
  file.tokens.push({ token, userId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + configured * 3600000).toISOString() });
  if (file.tokens.length > 200) file.tokens = file.tokens.slice(-100); // 防无限膨胀
  writeAtomic(sessionsPath(), JSON.stringify(file, null, 2));
  return token;
}

/** M1-09：为指定用户签发令牌（定时任务内部自调用对话管线用；用户不存在返回 null）。 */
export function issueTokenForUser(userId: string): string | null {
  const user = loadUsers().users.find((u) => u.id === userId);
  return user ? issueToken(userId) : null;
}

function resolveScopedToken(token: string | undefined | null): PublicUser | null {
  if (!token) return null;
  const file = loadSessions();
  const entry = file.tokens.find((t) => t.token === token);
  if (!entry) return null;
  const user = loadUsers().users.find((u) => u.id === entry.userId);
  return user ? { id: user.id, tenantId: user.tenantId ?? tenantId(), platformAdmin: user.platformAdmin === true, mustChangePassword: user.mustChangePassword === true, username: user.username, email: user.email, role: user.role, tier: user.tier } : null;
}

function loadSessions(): SessionsFile {
  const file = readJsonSafe<SessionsFile>(sessionsPath(), EMPTY_SESSIONS, (value) => {
    const data = value as Partial<SessionsFile> | null;
    return Boolean(data && data.version === 1 && Array.isArray(data.tokens));
  }).value;
  const valid = file.tokens.filter((t) => t && typeof t.token === 'string' && typeof t.userId === 'string' && typeof t.expiresAt === 'string' && Date.parse(t.expiresAt) > Date.now());
  if (valid.length !== file.tokens.length) writeAtomic(sessionsPath(), JSON.stringify({ ...file, tokens: valid }, null, 2));
  return { ...file, tokens: valid };
}

export function cleanupSessions(): void { loadSessions(); }
export function revokeToken(token: string): void {
  const file = loadSessions();
  file.tokens = file.tokens.filter((t) => t.token !== token);
  writeAtomic(sessionsPath(), JSON.stringify(file, null, 2));
}
export function revokeUserSessions(userId: string): void {
  const file = loadSessions();
  file.tokens = file.tokens.filter((t) => t.userId !== userId);
  writeAtomic(sessionsPath(), JSON.stringify(file, null, 2));
}

export function deleteUser(userId: string, currentUserId: string): { ok: boolean; error?: string } {
  if (userId === currentUserId) return { ok: false, error: '不能删除自己的账户' };
  const file = loadUsers();
  const idx = file.users.findIndex((u) => u.id === userId);
  if (idx < 0) return { ok: false, error: '用户不存在' };
  const target = file.users[idx]!;
  if (target.platformAdmin) return { ok: false, error: '平台管理员不能在租户用户管理中删除' };
  if (target.role === 'admin' && file.users.filter((u) => u.role === 'admin').length <= 1) {
    return { ok: false, error: '至少保留一个管理员账户' };
  }
  const removed = file.users.splice(idx, 1)[0]!;
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_deleted', user: removed.username }));
  return { ok: true };
}

export function updateUserProfile(userId: string, email: string | null | undefined): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  try {
    user.email = normalizeEmail(email, file, userId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_updated', user: user.username, email: user.email ?? null }));
  return { ok: true };
}

export function updateUserRole(userId: string, role: Role): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  if (user.platformAdmin && role !== 'admin') return { ok: false, error: '平台管理员不能在租户用户管理中降级' };
  if (user.role === 'admin' && role === 'member' && file.users.filter((u) => u.role === 'admin').length <= 1) {
    return { ok: false, error: '至少保留一个管理员账户' };
  }
  user.role = role;
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_role_changed', user: user.username, role }));
  return { ok: true };
}

/** RL1-02：读个人档位（未自选返回 null = 使用全局默认档）。 */
export function getUserTier(userId: string): Tier | null {
  return loadUsers().users.find((u) => u.id === userId)?.tier ?? null;
}

/** RL1-02：设置个人档位；tier=null 表示清除自选、回落全局默认档。 */
export function setUserTier(userId: string, tier: Tier | null): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  if (tier === null) delete user.tier;
  else user.tier = tier;
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(
    join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`),
    JSON.stringify({ ts: new Date().toISOString(), event: 'user_tier_changed', user: user.username, tier: tier ?? '(回落全局默认)' }),
  );
  return { ok: true };
}

/** 重置凭据时不得暴露个人业务数据。 */
export function resetUserPassword(userId: string, actor: PublicUser): { temporaryPassword: string } {
  if (actor.role !== 'admin') throw new Error('仅管理员可重置密码');
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) throw new Error('用户不存在');
  if (user.id === actor.id) throw new Error('请使用修改密码功能修改自己的密码');
  if (user.platformAdmin) throw new Error('不能重置平台管理员密码');
  const temporaryPassword = 'Wp!' + randomBytes(18).toString('base64url');
  user.hash = bcrypt.hashSync(temporaryPassword, 10);
  user.mustChangePassword = true;
  revokeUserSessions(userId);
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'password_reset', user: actor.username, target: user.username }));
  return { temporaryPassword };
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.hash)) return { ok: false, error: '当前密码不正确' };
  if (newPassword.length < 6) return { ok: false, error: '新密码至少 6 位' };
  if (bcrypt.compareSync(newPassword, user.hash)) return { ok: false, error: '新密码不能与当前密码相同' };
  revokeUserSessions(userId);
  user.hash = bcrypt.hashSync(newPassword, 10);
  user.mustChangePassword = false;
  writeAtomicWithBackup(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'password_changed', user: user.username }));
  return { ok: true };
}

export function listUsers(): PublicUser[] {
  return loadUsers().users.map((u) => ({
    id: u.id,
    tenantId: u.tenantId ?? tenantId(),
    platformAdmin: u.platformAdmin === true,
    mustChangePassword: u.mustChangePassword === true,
    username: u.username,
    email: u.email,
    role: u.role,
    tier: u.tier,
    createdAt: u.createdAt,
    lastLoginTime: u.lastLoginTime,
  }));
}

function localDate(): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function resolveToken(token: string | undefined | null): PublicUser | null {
  if (!token || token.length > 256) return null;
  const id = token.includes('.') ? token.split('.')[0]! : DEFAULT_TENANT;
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) return null;
  try { return withTenant(id, () => resolveScopedToken(token)); } catch { return null; }
}
