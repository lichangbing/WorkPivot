import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { normalizeServerAddress } from './server-address';

export interface User { id: string; username: string; mustChangePassword?: boolean }
export interface Auth { authenticated: boolean; needsSetup: boolean; user: User | null }
export interface Project { id: string; name: string }
export interface Task { id: string; name: string; projectId: string | null; status: string }
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
const credentialKey = 'workpivot-session';
export async function savedSession(): Promise<{ server: string; token: string } | null> {
  if (!Capacitor.isNativePlatform()) return null;
  const value = await SecureStorage.get(credentialKey);
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) return null;
  if (typeof value.server !== 'string' || typeof value.token !== 'string') return null;
  return { server: normalizeServerAddress(value.server), token: value.token };
}
export async function saveSession(server: string, token: string | null): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    if (token) await SecureStorage.set(credentialKey, { server, token });
    else await SecureStorage.remove(credentialKey);
  }
}
export class MobileClient {
  readonly server: string;
  private readonly lifetime = new AbortController();
  get signal(): AbortSignal { return this.lifetime.signal; }
  dispose(): void { this.lifetime.abort(); this.token = null; }
  constructor(server: string, public token: string | null = null) {
    this.server = normalizeServerAddress(server, import.meta.env.DEV);
  }
  async response(path: string, init: RequestInit = {}, timeout = 15000): Promise<Response> {
    if (!path.startsWith('/api/')) throw new Error('无效的接口路径');
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(this.server + path, {
      ...init, headers, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([this.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeout)]),
    }).catch((error: unknown) => {
      if (init.signal?.aborted) throw error;
      throw new Error('无法连接服务器，请检查网络、地址及服务器的手机端访问配置');
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new ApiError(body.error ?? `请求失败（${response.status}）`, response.status);
    }
    return response;
  }
  async json<T>(path: string, init?: RequestInit): Promise<T> { return (await this.response(path, init)).json() as Promise<T>; }
  async health(): Promise<void> {
    const value = await this.json<{ name: string; storage: string; ok: boolean }>('/api/health');
    if (value.name !== 'workpivot' || value.storage !== 'postgresql' || !value.ok) throw new Error('目标不是可用的 WorkPivot PostgreSQL 后台');
  }
}
