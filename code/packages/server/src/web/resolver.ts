import { lookup } from 'node:dns/promises';
import type { Resolver } from './safe-http.js';

/** 仅接受管理员环境配置；DoH只发送域名，不发送页面路径、正文或凭据。 */
export function webResolver(endpoint = process.env['WORKPIVOT_WEB_DOH_URL']): Resolver {
  if (!endpoint) return host => lookup(host, { all: true, verbatim: true });
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('网页DoH须配置无凭据、查询和片段的HTTPS端点');
  const cache = new Map<string, { expires: number; addresses: { address: string; family: number }[] }>();
  return async host => {
    const cached = cache.get(host);
    if (cached && cached.expires > Date.now()) return cached.addresses.map(a => ({ ...a }));
    const responses = await Promise.all([1, 28].map(async type => {
      const query = new URL(url); query.searchParams.set('name', host); query.searchParams.set('type', String(type));
      const response = await fetch(query, { headers: { accept: 'application/dns-json' }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || !response.body) throw Error('网页DoH解析失败');
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 65536) throw Error('网页DoH响应过大'); chunks.push(result.value); } }
      finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { Status?: number; Answer?: { type: number; data: string }[] };
      if (result.Status !== 0 || result.Answer !== undefined && !Array.isArray(result.Answer)) throw Error('网页DoH解析结果无效');
      return (result.Answer ?? []).filter(a => a.type === type && typeof a.data === 'string').map(a => ({ address: a.data, family: type === 1 ? 4 : 6 }));
    }));
    const addresses = responses.flat();
    if (!addresses.length) throw Error('网页域名没有可用地址');
    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    cache.set(host, { addresses, expires: Date.now() + 30000 });
    // SafeHttp随后对每个结果检查公网范围，并固定socket连接地址，不因DoH而豁免。
    return addresses.map(a => ({ ...a }));
  };
}
