import { getToken } from './api';
export type MemoryLayer = 'task' | 'project' | 'personal';
export interface RoleMemory { id: string; name: string; content: string; enabled: boolean }
export interface MemoryCatalog { revision: string; defaultId: string | null; templates: RoleMemory[] }
export interface MemorySelection { revision: string; autoLoad: boolean; roleId: string; effectiveRole: RoleMemory | null }
export interface MemoryLayers { layers: Array<{ id: MemoryLayer; content: string; revision: string; editable: boolean }>; entries: Array<{ id: string; content: string }>; selection: MemorySelection; catalog: MemoryCatalog }
export async function memoryRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch('/api/memory-layers' + path, { method, headers: { authorization: 'Bearer ' + getToken(), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const value = await response.json(); if (!response.ok) throw Error(value.error ?? '记忆操作失败'); return value as T;
}
