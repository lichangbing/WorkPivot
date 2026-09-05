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
  hash: string;
  role: Role;
  createdAt: string;
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

export function needsSetup(): boolean {
  return loadUsers().users.length === 0;
}

export function registerFirstAdmin(username: string, password: string): { token: string; user: PublicUser } {
  const file = loadUsers();
  if (file.users.length > 0) throw new Error('已有用户存在：注册已关闭，请联系管理员开通账户');
  return createUserAndToken(file, username, password, 'admin');
}

export function createUser(username: string, password: string, role: Role): PublicUser {
  const file = loadUsers();
  if (file.users.length === 0) throw new Error('尚无用户：请先通过注册创建管理员');
  if (file.users.some((u) => u.username === username)) throw new Error(`用户名已存在：${username}`);
  const { user } = createUserAndToken(file, username, password, role);
  return { id: user.id, username: user.username, role: user.role };
}

function createUserAndToken(file: UsersFile, username: string, password: string, role: Role): { token: string; user: PublicUser } {
  if (username.trim().length < 2) throw new Error('用户名至少 2 个字符');
  if (password.length < 6) throw new Error('密码至少 6 位');
  if (file.users.some((u) => u.username === username)) throw new Error(`用户名已存在：${username}`);
  const user: User = {
    id: randomUUID(),
    username: username.trim(),
    hash: bcrypt.hashSync(password, 10),
    role,
    createdAt: new Date().toISOString(),
  };
  file.users.push(user);
  writeAtomic(usersPath(), JSON.stringify(file, null, 2));
  appendLine(join(ensureWorkpivotDir('audit'), `audit-${localDate()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), event: 'user_created', user: user.username, role }));
  const token = issueToken(user.id);
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
}

export function login(username: string, password: string): { token: string; user: PublicUser } {
  const user = loadUsers().users.find((u) => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.hash)) throw new Error('用户名或密码错误');
  const token = issueToken(user.id);
  return { token, user: { id: user.id, username: user.username, role: user.role } };
}

function issueToken(userId: string): string {
  const token = randomUUID() + randomUUID().replaceAll('-', '');
  const file = readJsonSafe<SessionsFile>(sessionsPath(), EMPTY_SESSIONS).value;
  file.tokens.push({ token, userId, createdAt: new Date().toISOString() });
  if (file.tokens.length > 200) file.tokens = file.tokens.slice(-100); // 防无限膨胀
  writeAtomic(sessionsPath(), JSON.stringify(file, null, 2));
  return token;
}

export function resolveToken(token: string | undefined | null): PublicUser | null {
  if (!token) return null;
  const file = readJsonSafe<SessionsFile>(sessionsPath(), EMPTY_SESSIONS).value;
  const entry = file.tokens.find((t) => t.token === token);
  if (!entry) return null;
  const user = loadUsers().users.find((u) => u.id === entry.userId);
  return user ? { id: user.id, username: user.username, role: user.role } : null;
}

export function listUsers(): PublicUser[] {
  return loadUsers().users.map((u) => ({ id: u.id, username: u.username, role: u.role }));
}

function localDate(): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
