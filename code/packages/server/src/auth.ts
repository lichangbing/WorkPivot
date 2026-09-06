/**
 * T2-01/J01（单机形态）：本地账户体系。
 * 首个注册用户自动成为管理员，此后注册关闭、由管理员创建用户（A01 登录门）。
 * 会话令牌持久化（重启免重复登录）；密码 bcrypt 哈希。
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { join } from 'node:path';
import { appendLine, ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';

export type Role = 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  email?: string;
  hash: string;
  role: Role;
  createdAt: string;
  lastLoginTime?: string;
}

interface UsersFile {
  version: 1;
  users: User[];
}

interface SessionsFile {
  version: 1;
  tokens: Array<{ token: string; userId: string; createdAt: string }>;
}

const EMPTY_USERS: UsersFile = { version: 1, users: [] };
const EMPTY_SESSIONS: SessionsFile = { version: 1, tokens: [] };

function usersPath(): string {
  return join(ensureWorkpivotDir('data'), 'users.json');
}

function sessionsPath(): string {
  return join(ensureWorkpivotDir('data'), 'sessions.json');
}

function loadUsers(): UsersFile {
  return readJsonSafe<UsersFile>(usersPath(), EMPTY_USERS).value;
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

export function registerFirstAdmin(username: string, password: string): { token: string; user: PublicUser } {
  const file = loadUsers();
  if (file.users.length > 0) throw new Error('已有用户存在：注册已关闭，请联系管理员开通账户');
  return createUserAndToken(file, username, password, 'admin');
}

export function createUser(username: string, password: string, role: Role, email?: string): PublicUser {
  const file = loadUsers();
  if (file.users.length === 0) throw new Error('尚无用户：请先通过注册创建管理员');
  if (file.users.some((u) => u.username === username)) throw new Error(`用户名已存在：${username}`);
  const { user } = createUserAndToken(file, username, password, role, email);
  return { id: user.id, username: user.username, email: user.email, role: user.role };
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
  if (file.users.some((u) => u.username === username)) throw new Error(`用户名已存在：${username}`);
  const normalizedEmail = normalizeEmail(email, file);
  const user: User = {
    id: randomUUID(),
    username: username.trim(),
    email: normalizedEmail,
    hash: bcrypt.hashSync(password, 10),
    role,
    createdAt: new Date().toISOString(),
  };
  file.users.push(user);
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_created', user: user.username, role, email: normalizedEmail ?? null }));
  const token = issueToken(user.id);
  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role } };
}

export interface PublicUser {
  id: string;
  username: string;
  email?: string;
  role: Role;
  createdAt?: string;
  lastLoginTime?: string;
}

export function login(username: string, password: string): { token: string; user: PublicUser } {
  const file = loadUsers();
  const user = file.users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.hash)) throw new Error('用户名或密码错误');
  user.lastLoginTime = new Date().toISOString();
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  const token = issueToken(user.id);
  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role, lastLoginTime: user.lastLoginTime } };
}

function issueToken(userId: string): string {
  const token = randomUUID() + randomUUID().replaceAll('-', '');
  const file = readJsonSafe<SessionsFile>(sessionsPath(), EMPTY_SESSIONS).value;
  file.tokens.push({ token, userId, createdAt: new Date().toISOString() });
  if (file.tokens.length > 200) file.tokens = file.tokens.slice(-100); // 防无限膨胀
  writeAtomic(sessionsPath(), JSON.stringify(file, null, 2));
  return token;
}

/** M1-09：为指定用户签发令牌（定时任务内部自调用对话管线用；用户不存在返回 null）。 */
export function issueTokenForUser(userId: string): string | null {
  const user = loadUsers().users.find((u) => u.id === userId);
  return user ? issueToken(userId) : null;
}

export function resolveToken(token: string | undefined | null): PublicUser | null {
  if (!token) return null;
  const file = readJsonSafe<SessionsFile>(sessionsPath(), EMPTY_SESSIONS).value;
  const entry = file.tokens.find((t) => t.token === token);
  if (!entry) return null;
  const user = loadUsers().users.find((u) => u.id === entry.userId);
  return user ? { id: user.id, username: user.username, email: user.email, role: user.role } : null;
}

export function deleteUser(userId: string, currentUserId: string): { ok: boolean; error?: string } {
  if (userId === currentUserId) return { ok: false, error: '不能删除自己的账户' };
  const file = loadUsers();
  const idx = file.users.findIndex((u) => u.id === userId);
  if (idx < 0) return { ok: false, error: '用户不存在' };
  const target = file.users[idx]!;
  if (target.role === 'admin' && file.users.filter((u) => u.role === 'admin').length <= 1) {
    return { ok: false, error: '至少保留一个管理员账户' };
  }
  const removed = file.users.splice(idx, 1)[0]!;
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
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
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_updated', user: user.username, email: user.email ?? null }));
  return { ok: true };
}

export function updateUserRole(userId: string, role: Role): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  if (user.role === 'admin' && role === 'member' && file.users.filter((u) => u.role === 'admin').length <= 1) {
    return { ok: false, error: '至少保留一个管理员账户' };
  }
  user.role = role;
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_role_changed', user: user.username, role }));
  return { ok: true };
}

export function changePassword(userId: string, currentPassword: string, newPassword: string): { ok: boolean; error?: string } {
  const file = loadUsers();
  const user = file.users.find((u) => u.id === userId);
  if (!user) return { ok: false, error: '用户不存在' };
  if (!currentPassword || !bcrypt.compareSync(currentPassword, user.hash)) return { ok: false, error: '当前密码不正确' };
  if (newPassword.length < 6) return { ok: false, error: '新密码至少 6 位' };
  user.hash = bcrypt.hashSync(newPassword, 10);
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'password_changed', user: user.username }));
  return { ok: true };
}

export function listUsers(): PublicUser[] {
  return loadUsers().users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    createdAt: u.createdAt,
    lastLoginTime: u.lastLoginTime,
  }));
}

function localDate(): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
