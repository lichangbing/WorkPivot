/** 前端 API 客户端：只允许经 HTTP/SSE 与服务层通信（A01.3 拆分边界纪律）。 */
import { readChatStream } from './chat-stream';
import type { SidebarData } from './TaskSidebar';

export interface Task {
  lastStopReason?: string;
  id: string;
  name: string;
  directory: string;
  status: 'queued' | 'waiting' | 'failed' | 'running' | 'idle' | 'interrupted' | 'stopped';
  createdAt: string;
  projectId?: string;
  temp?: boolean;
}

export interface Project {
  id: string;
  name: string;
  directory: string;
  createdAt: string;
  ownerUserId?: string;
  memberUserIds?: string[];
}

export interface PublicProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  protocol: 'openai' | 'anthropic';
  verified?: boolean;
  hasApiKey: boolean;
  active: boolean;
}

/** M1-06：供应商协议（openai=兼容端点，anthropic=Messages 协议）。 */
export type ProviderProtocol = 'openai' | 'anthropic';

export interface PublicUser {
  tenantId?: string;
  platformAdmin?: boolean;
  mustChangePassword?: boolean;
  id: string;
  username: string;
  email?: string;
  role: 'admin' | 'member';
  createdAt?: string;
  lastLoginTime?: string;
}

export type Tier = 'ask' | 'auto';

export type PlanStep = { step: string; status: 'pending' | 'in_progress' | 'completed' };

export type ChatEvent =
  | { type: 'permission_resolved'; id: string; decision: 'allow' | 'deny' | 'session' | 'forever'; reason: 'decision' | 'aborted' | 'timeout' }
  | { type: 'assistant_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_use' | 'tool_status'; toolName: string; args?: unknown; displayName?: string; callId?: string; status?: 'waiting' | 'running' }
  | { type: 'tool_result'; toolName: string; ok?: boolean; message?: string; displayName?: string; callId?: string; durationMs?: number; status?: 'ok' | 'error' | 'denied' | 'stopped' }
  | { type: 'permission_request'; id: string; tool: string; kind: 'read' | 'write' | 'bash'; paths: Array<{ path: string; mode: string }>; command?: string; reason: string; scope: string }
  | { type: 'ask_user'; questionId: string; question: string; options?: Array<{ label: string; description?: string }>; allowFreeText?: boolean }
  | { type: 'risk_analysis'; id: string; analysis: string }
  | { type: 'memory_confirm'; id: string; content: string; taskId: string }
  | { type: 'memory_resolved'; id: string }
  | { type: 'plan_update'; steps: PlanStep[] }
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
  attachments?: string[];
  role: 'user' | 'assistant';
  content: string;
}

// ---- 会话令牌（T2-01：记住登录态）----
const TOKEN_KEY = 'wp_token';
window.addEventListener('storage', (event) => {
  if ((event.key === TOKEN_KEY || event.key === null) && event.oldValue !== event.newValue) window.location.reload();
});
export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  void window.workpivotDesktop?.conversationCache?.lock().catch(() => {});
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function jsonFetch<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json', ...authHeaders() },
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
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
  getSidebar: (taskId?: string): Promise<SidebarData> => jsonFetch('/api/sidebar' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : '')),
  downloadArtifact: async (taskId: string, name: string, version?: string): Promise<void> => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifact?name=${encodeURIComponent(name)}${version ? '&version=' + encodeURIComponent(version) : ''}`, { headers: authHeaders(), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('产物下载失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = name.split('/').pop() ?? 'artifact'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  listTenants: (): Promise<{ tenants: Array<{ id: string; name: string }> }> => jsonFetch('/api/tenants'),
  createTenant: (input: { id: string; name: string; username: string; password: string }): Promise<unknown> => jsonFetch('/api/tenants', { method: 'POST', body: JSON.stringify(input) }),
  listPathGrants: (): Promise<{ grants: Array<{ id: string; userId: string; taskId: string; path: string; mode: 'read' | 'write'; subtree: boolean; createdAt: string }> }> => jsonFetch('/api/permissions/allowdirs'),
  revokePathGrant: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/permissions/allowdirs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  health: (): Promise<{ ok: boolean }> => jsonFetch('/api/health'),
  authState: (): Promise<{ needsSetup: boolean; setupTokenRequired: boolean; authenticated: boolean; user: PublicUser | null; quota?: { used: number; limit: number; remaining: number | null } | null }> =>
    jsonFetch('/api/auth/state'),
  register: (username: string, password: string): Promise<{ token: string; user: PublicUser }> =>
    jsonFetch('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username: string, password: string): Promise<{ token: string; user: PublicUser }> =>
    jsonFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: (): Promise<{ ok: boolean }> => jsonFetch('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: boolean }> =>
    jsonFetch('/api/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  listUsers: (): Promise<{ users: PublicUser[] }> => jsonFetch('/api/users'),
  createUser: (username: string, password: string, role: 'admin' | 'member', email?: string): Promise<{ user: PublicUser }> =>
    jsonFetch('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role, email: email?.trim() || undefined }) }),
  resetUserPassword: (id: string): Promise<{ temporaryPassword: string }> => jsonFetch(`/api/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' }),
  deleteUser: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/users/${id}`, { method: 'DELETE' }),
  revokeUserSessions: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/users/${id}/sessions`, { method: 'DELETE' }),
  updateUserRole: (id: string, role: 'admin' | 'member'): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/users/${id}/role`, { method: 'PUT', body: JSON.stringify({ role }) }),
  updateUserEmail: (id: string, email?: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ email: email?.trim() || null }) }),
  getSettings: (): Promise<{ permissionTier: Tier; tierLabels: Record<string, string>; allowDirs: string[] }> =>
    jsonFetch('/api/settings'),
  // RL1-02：个人档位（成员自选，改自己）；全局默认档仅 admin（setGlobalTier）
  getMyTier: (): Promise<{ tier: Tier; defaultTier: Tier; tierLabels: Record<string, string> }> => jsonFetch('/api/me/tier'),
  setMyTier: (tier: Tier | null): Promise<{ tier: Tier; defaultTier: Tier }> =>
    jsonFetch('/api/me/tier', { method: 'PUT', body: JSON.stringify({ tier }) }),
  setGlobalTier: (tier: Tier): Promise<{ permissionTier: Tier }> =>
    jsonFetch('/api/settings/tier', { method: 'PUT', body: JSON.stringify({ tier }) }),
  listTasks: (): Promise<{ tasks: Task[] }> => jsonFetch('/api/tasks'),
  deleteProject: (id: string): Promise<{ ok: boolean; taskIds: string[] }> => jsonFetch(`/api/projects/${id}`, { method: 'DELETE' }),
  createTask: (input: { name: string; directory?: string; projectId?: string; temp?: boolean }): Promise<{ task: Task }> =>
    jsonFetch('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  deleteTempTask: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}`, { method: 'DELETE' }),
  deleteTask: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}`, { method: 'DELETE' }),
  listProjects: (): Promise<{ projects: Project[]; defaultProjectId: string }> => jsonFetch('/api/projects'),
  updateProjectAccess: (id: string, ownerUserId: string, memberUserIds: string[]): Promise<{ project: Project }> =>
    jsonFetch(`/api/projects/${encodeURIComponent(id)}/access`, { method: 'PUT', body: JSON.stringify({ ownerUserId, memberUserIds }) }),
  editProjectMemory: (id: string, content: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/projects/${encodeURIComponent(id)}/memory`, { method: 'PUT', body: JSON.stringify({ content }) }),
  clearProjectMemory: (id: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/projects/${encodeURIComponent(id)}/memory`, { method: 'DELETE' }),
  createProject: (name: string, directory?: string, localDirectory?: boolean): Promise<{ project: Project }> =>
    jsonFetch('/api/projects', { method: 'POST', body: JSON.stringify({ name, directory, directorySource: localDirectory ? 'client' : 'server' }) }),
  listSkillsAdmin: (): Promise<{ skills: Array<{ name: string; description: string; source: string; disabled: boolean }> }> =>
    jsonFetch('/api/skills'),
  getSkill: (name: string): Promise<{ name: string; content: string; revision: string }> => jsonFetch(`/api/skills/${encodeURIComponent(name)}`),
  saveSkill: (name: string, content: string, revision: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content, revision }) }),
  toggleSkill: (name: string, disabled: boolean): Promise<{ ok: boolean }> =>
    jsonFetch('/api/skills/toggle', { method: 'POST', body: JSON.stringify({ name, disabled }) }),
  getTask: (id: string): Promise<{ task: Task; history: HistoryMessage[]; pendingMemory?: Array<{ id: string; content: string }>; pending?: Array<{ id: string; tool: string; reason: string; paths: Array<{ path: string; mode: string }>; scope: string; command?: string }> }> => jsonFetch(`/api/tasks/${id}`),
  getTranscript: (id: string): Promise<{ rows: TranscriptRow[] }> => jsonFetch(`/api/tasks/${id}/transcript`),
  getPlan: (id: string): Promise<{ steps: PlanStep[] }> => jsonFetch(`/api/tasks/${id}/plan`),
  getFiles: (id: string): Promise<{ directory: string; files: string[] }> => jsonFetch(`/api/tasks/${id}/files`),
  stop: (id: string): Promise<{ ok: boolean }> => jsonFetch(`/api/tasks/${id}/stop`, { method: 'POST' }),
  decidePermission: (taskId: string, id: string, decision: 'allow' | 'deny' | 'session' | 'forever'): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/tasks/${taskId}/permission`, { method: 'POST', body: JSON.stringify({ id, decision }) }),
  confirmMemory: (taskId: string, id: string, approve: boolean): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/tasks/${taskId}/memory/confirm`, { method: 'POST', body: JSON.stringify({ id, approve }) }),
  memoryView: (taskId?: string): Promise<{ handbook: string; entries: Array<{ id: string; content: string; createdAt?: string }>; project: string; enabled: boolean; projectId: string | null; canEditProject: boolean }> =>
    jsonFetch(`/api/memory${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`),
  memoryToggle: (enabled: boolean): Promise<{ enabled: boolean }> =>
    jsonFetch('/api/memory/toggle', { method: 'POST', body: JSON.stringify({ enabled }) }),
  memoryEditHandbook: (content: string): Promise<{ ok: boolean }> =>
    jsonFetch('/api/memory/handbook', { method: 'PUT', body: JSON.stringify({ content }) }),
  memoryDeleteEntry: (id: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/memory/entries/${id}`, { method: 'DELETE' }),
  memoryState: (): Promise<{ enabled: boolean }> =>
    jsonFetch<{ enabled: boolean }>('/api/memory').then((v) => ({ enabled: v.enabled })),
  listProviders: (): Promise<{ providers: PublicProvider[]; activeId?: string }> => jsonFetch('/api/providers'),
  saveProvider: (input: { name: string; baseUrl: string; modelId: string; apiKey?: string; verify?: boolean; protocol?: ProviderProtocol }): Promise<{ provider: PublicProvider }> =>
    jsonFetch('/api/providers', { method: 'POST', body: JSON.stringify(input) }),
  updateProvider: (id: string, input: { name: string; baseUrl: string; modelId: string; apiKey?: string; verify?: boolean; protocol?: ProviderProtocol }): Promise<{ provider: PublicProvider }> =>
    jsonFetch(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteProvider: (id: string): Promise<{ ok: boolean }> =>
    jsonFetch(`/api/providers/${id}`, { method: 'DELETE' }),
  verifyProvider: (input: { baseUrl: string; apiKey?: string; protocol?: ProviderProtocol }): Promise<{ ok: boolean; detail: string }> =>
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
    xhr.timeout = 120000;
    xhr.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'));
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
  onAccepted?: () => void,
): Promise<void> {
  const payload: Record<string, unknown> =
    attachments && attachments.length > 0 ? { content, attachments } : { content };
  const handshake = new AbortController();
  const timer = setTimeout(() => handshake.abort(new Error('连接后台超时，请确认网络和任务状态后重试')), 15000);
  const response = await fetch(`/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload),
    signal: signal ? AbortSignal.any([signal, handshake.signal]) : handshake.signal,
  }).finally(() => clearTimeout(timer));
  if (response.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent('wp:unauthorized'));
  }
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  onAccepted?.();
  await readChatStream(response.body, onEvent, signal);
}
