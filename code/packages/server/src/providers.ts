/**
 * T1-06/C02/C03：模型供应商注册表。
 * M0 单机：管理员=本机用户；key 经 SecretBox 加密落盘（I04），接口返回永远打码。
 * M1-06：protocol 字段区分协议客户端（openai=兼容端点 / anthropic=Messages 协议）。
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { verifyAnthropicProvider, verifyProvider } from '@workpivot/core';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';
import { getSecretBox } from './secret.js';

export type ProviderProtocol = 'openai' | 'anthropic';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  protocol?: ProviderProtocol;
  apiKey?: { enc: 'safeStorage' | 'b64'; data: string };
  verified?: boolean;
  createdAt: string;
}

interface ProviderRegistry {
  version: 1;
  activeId?: string;
  providers: Provider[];
}

const EMPTY: ProviderRegistry = { version: 1, providers: [] };

function registryPath(): string {
  return join(ensureWorkpivotDir('config'), 'providers.json');
}

function load(): ProviderRegistry {
  return readJsonSafe<ProviderRegistry>(registryPath(), EMPTY).value;
}

function save(registry: ProviderRegistry): void {
  writeAtomicWithBackup(registryPath(), JSON.stringify(registry, null, 2));
}

export interface PublicProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  protocol: ProviderProtocol;
  verified?: boolean;
  hasApiKey: boolean;
  active: boolean;
}

function toPublic(p: Provider, activeId?: string): PublicProvider {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    modelId: p.modelId,
    protocol: p.protocol ?? 'openai',
    verified: p.verified,
    hasApiKey: Boolean(p.apiKey),
    active: p.id === activeId,
  };
}

export function listProviders(): { providers: PublicProvider[]; activeId?: string } {
  const registry = load();
  return {
    providers: registry.providers.map((p) => toPublic(p, registry.activeId)),
    activeId: registry.activeId,
  };
}

export interface SaveProviderInput {
  name: string;
  baseUrl: string;
  modelId: string;
  protocol?: string;
  apiKey?: string;
  verify?: boolean;
}

/** 协议字段规范化：只认 openai/anthropic，缺省 openai。 */
function normalizeProtocol(raw?: string): ProviderProtocol {
  return raw === 'anthropic' ? 'anthropic' : 'openai';
}

/** M1-06：按协议分流验活（openai→GET /models Bearer；anthropic→GET /v1/models x-api-key）。 */
async function verifyByProtocol(input: SaveProviderInput): Promise<void> {
  const protocol = normalizeProtocol(input.protocol);
  const result =
    protocol === 'anthropic'
      ? await verifyAnthropicProvider(input.baseUrl, input.apiKey)
      : await verifyProvider(input.baseUrl, input.apiKey);
  if (!result.ok) throw new Error(`验活失败：${result.detail}`);
}

export async function saveProvider(input: SaveProviderInput): Promise<{ provider: PublicProvider; verify?: { ok: boolean; detail: string } }> {
  if (input.verify) await verifyByProtocol(input);
  const registry = load();
  const existing = registry.providers.find((p) => p.name === input.name);
  const provider: Provider = {
    id: existing?.id ?? randomUUID(),
    name: input.name,
    baseUrl: input.baseUrl,
    modelId: input.modelId,
    protocol: normalizeProtocol(input.protocol),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    verified: true,
  };
  if (input.apiKey) provider.apiKey = getSecretBox().encrypt(input.apiKey);
  else if (existing?.apiKey) provider.apiKey = existing.apiKey;

  if (existing) {
    const idx = registry.providers.findIndex((p) => p.id === existing.id);
    registry.providers[idx] = provider;
  } else {
    registry.providers.push(provider);
  }
  if (!registry.activeId) registry.activeId = provider.id;
  save(registry);
  return { provider: toPublic(provider, registry.activeId) };
}

/** F3：按 id 更新供应商（编辑时 apiKey 留空 = 保留原 key）。 */
export async function updateProvider(id: string, input: SaveProviderInput): Promise<{ provider: PublicProvider; verify?: { ok: boolean; detail: string } }> {
  const registry = load();
  const existing = registry.providers.find((p) => p.id === id);
  if (!existing) throw new Error(`供应商不存在：${id}`);
  if (input.verify) await verifyByProtocol(input);
  existing.name = input.name;
  existing.baseUrl = input.baseUrl;
  existing.modelId = input.modelId;
  existing.protocol = normalizeProtocol(input.protocol);
  existing.verified = true;
  if (input.apiKey) existing.apiKey = getSecretBox().encrypt(input.apiKey);
  save(registry);
  return { provider: toPublic(existing, registry.activeId) };
}

/** F3：按 id 删除供应商；若删的是激活项则顺延到剩余第一个（没有则清空）。 */
export function deleteProvider(id: string): { ok: true } {
  const registry = load();
  const idx = registry.providers.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`供应商不存在：${id}`);
  registry.providers.splice(idx, 1);
  if (registry.activeId === id) registry.activeId = registry.providers[0]?.id;
  save(registry);
  return { ok: true };
}

export function setActiveProvider(id: string): PublicProvider {
  const registry = load();
  const provider = registry.providers.find((p) => p.id === id);
  if (!provider) throw new Error(`供应商不存在：${id}`);
  registry.activeId = id;
  save(registry);
  return toPublic(provider, registry.activeId);
}

export interface ActiveModelClientConfig {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  protocol: ProviderProtocol;
}

/** 取当前激活供应商并解密 key（服务层内部使用，永不外传）。 */
export function resolveActiveProvider(): ActiveModelClientConfig {
  const registry = load();
  const provider = registry.providers.find((p) => p.id === registry.activeId) ?? registry.providers[0];
  if (!provider) throw new Error('尚未配置模型供应商：请先在设置中添加（如 Ollama http://127.0.0.1:11434/v1）');
  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ? getSecretBox().decrypt(provider.apiKey) : undefined,
    model: provider.modelId,
    protocol: provider.protocol ?? 'openai',
  };
}
