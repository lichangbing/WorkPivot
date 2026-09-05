/** 前端 API 客户端：只允许经 HTTP/SSE 与服务层通信（A01.3 拆分边界纪律）。 */

export interface Task {
  id: string;
  name: string;
  directory: string;
  status: 'running' | 'idle' | 'interrupted' | 'stopped';
  createdAt: string;
}

export interface PublicProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  verified?: boolean;
  hasApiKey: boolean;
  active: boolean;
}

export interface PublicUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
}

export type Tier = 'readonly' | 'ask' | 'workdir' | 'auto';

export type ChatEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_use'; toolName: string; args?: unknown }
  | { type: 'tool_result'; toolName: string; ok?: boolean; message?: string }
  | { type: 'permission_request'; id: string; tool: string; kind: 'read' | 'write' | 'bash'; paths: Array<{ path: string; mode: string }>; command?: string; reason: string; scope: string }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string; steps: number };

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ---- 会话令牌（T2-01：记住登录态）----
const TOKEN_KEY = 'wp_token';
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...authHeaders() },
    ...init,
  });
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('wp:unauthorized'));
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  health: (): Promise<{ ok: boolean }> => jsonFetch('/api/health'),
  authState: (): Promise<{ needsSetup: boolean; authenticated: boolean; user: PublicUser | null }> =>
    jsonFetch('/api/auth/state'),
  register: (username: string, password: string): Promise<{ token: string; user: PublicUser }> =>
    jsonFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<{ token: string; user: PublicUser }> =>
    jsonFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: (): Promise<{ ok: boolean }> => jsonFetch('/api/auth/logout', { method: 'POST' }),
  listUsers: (): Promise<{ users: PublicUser[] }> => jsonFetch('/api/users'),
  createUser: (username: string, password: string, role: 'admin' | 'member'): Promise<{ user: PublicUser }> =>
    jsonFetch('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role }) }),
  getSettings: (): Promise<{ permissionTier: Tier; tierLabels: Record<string, string>; allowDirs: string[] }> =>
    jsonFetch('/api/settings'),
  setTier: (tier: Tier): Promise<{ permissionTier: Tier }> =>
    jsonFetch('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier }) }),
  listTasks: (): Promise<{ tasks: Task[] }> => jsonFetch('/api/tasks'),
  createTask: (name: string, directory?: string): Promise<{ task: Task }> =>
    jsonFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ name, directory }) }),
  getTask: (id: string): Promise<{ task: Task; history: HistoryMessage[] }> => jsonFetch(`/api/tasks/${id}`),
  getFiles: (id: string): Promise<{ directory: string; files: string[] }> => jsonFetch(`/api/tasks/${id}/files`),
  stop: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}/stop`, { method: 'POST' }),
  decidePermission: (taskId: string, id: string, decision: 'allow' | 'deny' | 'session' | 'forever'): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id, decision }) }),
  listProviders: (): Promise<{ providers: PublicProvider[]; activeId?: string }> => jsonFetch('/api/providers'),
  saveProvider: (input: { name: string; baseUrl: string; modelId: string; apiKey?: string; verify?: boolean }): Promise<{ provider: PublicProvider }> =>
    jsonFetch('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  verifyProvider: (input: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; detail: string }> =>
    jsonFetch('/api/providers/verify', { method: 'POST', body: JSON.stringify(input) }),
  setActiveProvider: (id: string): Promise<{ provider: PublicProvider }> =>
    jsonFetch('/api/providers/active', { method: 'POST', body: JSON.stringify({ id }) }),
};

/** POST + SSE 流式读取（EventSource 不支持 POST，手写解析）。 */
export async function streamChat(
  taskId: string,
  content: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ content }),
    signal,
  });
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('wp:unauthorized'));
  }
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (line) onEvent(JSON.parse(line.slice(5).trim()) as ChatEvent);
    }
  }
}
