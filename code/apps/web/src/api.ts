/** 前端 API 客户端：只允许经 HTTP/SSE 与服务层通信（A01.3 拆分边界纪律）。 */

export interface Task {
  id: string;
  name: string;
  directory: string;
  status: 'running' | 'idle' | 'interrupted' | 'stopped';
  createdAt: string;
  projectId?: string;
  temp?: boolean;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
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
  | { type: 'memory_confirm'; id: string; content: string; taskId: string }
  | { type: 'gate_reject'; missing: string[]; final?: boolean }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: string; steps: number };

export interface TranscriptRow {
  ts: string;
  ordinal: number;
  kind: string;
  payload: Record<string, unknown>;
}

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
  createTask: (input: { name: string; directory?: string; projectId?: string; temp?: boolean }): Promise<{ task: Task }> =>
    jsonFetch('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  deleteTempTask: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}`, { method: 'DELETE' }),
  listProjects: (): Promise<{ projects: Project[]; defaultProjectId: string }> => jsonFetch('/api/projects'),
  createProject: (name: string, directory?: string): Promise<{ project: Project }> =>
    jsonFetch('/api/projects', { method: 'POST', body: JSON.stringify({ name, directory }) }),
  listSkillsAdmin: (): Promise<{ skills: Array<{ name: string; description: string; source: string; disabled: boolean }> }> =>
    jsonFetch('/api/skills'),
  toggleSkill: (name: string, disabled: boolean): Promise<{ ok: boolean }> =>
    jsonFetch('/api/skills/toggle', { method: 'POST', body: JSON.stringify({ name, disabled }) }),
  getTask: (id: string): Promise<{ task: Task; history: HistoryMessage[] }> => jsonFetch(`/api/tasks/${id}`),
  getTranscript: (id: string): Promise<{ rows: TranscriptRow[] }> => jsonFetch(`/api/tasks/${id}/transcript`),
  getFiles: (id: string): Promise<{ directory: string; files: string[] }> => jsonFetch(`/api/tasks/${id}/files`),
  stop: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}/stop`, { method: 'POST' }),
  decidePermission: (taskId: string, id: string, decision: 'allow' | 'deny' | 'session' | 'forever'): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id, decision }) }),
  confirmMemory: (taskId: string, id: string, approve: boolean): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/tasks/${taskId}/memory/confirm`, { method: 'POST', body: JSON.stringify({ id, approve }) }),
  memoryView: (taskId?: string): Promise<{ handbook: string; entries: Array<{ id: string; content: string }>; project: string; enabled: boolean }> =>
    jsonFetch(`/api/memory${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  memoryToggle: (enabled: boolean): Promise<{ enabled: boolean }> =>
    jsonFetch('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  memoryState: (): Promise<{ enabled: boolean }> =>
    jsonFetch<{ enabled: boolean }>('/api/memory').then((v) => ({ enabled: v.enabled })),
  listProviders: (): Promise<{ providers: PublicProvider[]; activeId?: string }> => jsonFetch('/api/providers'),
  saveProvider: (input: { name: string; baseUrl: string; modelId: string; apiKey?: string; verify?: boolean }): Promise<{ provider: PublicProvider }> =>
    jsonFetch('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  verifyProvider: (input: { baseUrl: string; apiKey?: string }): Promise<{ ok: boolean; detail: string }> =>
    jsonFetch('/api/providers/verify', { method: 'POST', body: JSON.stringify(input) }),
  setActiveProvider: (id: string): Promise<{ provider: PublicProvider }> =>
    jsonFetch('/api/providers/active', { method: 'POST', body: JSON.stringify({ id }) }),
};

/** U5 附件上传：XHR 以获取上传进度。 */
export function uploadAttachment(
  taskId: string,
  file: File,
  onProgress: (ratio: number) => void,
): Promise<{ name: string; size: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tasks/${taskId}/attachments?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    const token = getToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText) as { name: string; size: number });
        } catch {
          reject(new Error('响应解析失败'));
        }
      } else {
        reject(new Error(`上传失败 HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(file);
  });
}

/** POST + SSE 流式读取（EventSource 不支持 POST，手写解析）。 */
export async function streamChat(
  taskId: string,
  content: string,
  onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
  attachments?: string[],
): Promise<void> {
  const payload: Record<string, unknown> =
    attachments && attachments.length > 0 ? { content, attachments } : { content };
  const response = await fetch(`/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
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
