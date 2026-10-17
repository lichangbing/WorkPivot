import { webResolver } from './resolver.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export interface WebResponse { url: string; status: number; headers: Record<string, string>; body: Buffer }
export interface WebPolicy { origins?: string[]; signal?: AbortSignal; maxBytes?: number; followRedirects?: boolean }

export function publicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    if (ip.range() !== 'unicast') return false;
    if (ip.kind() === 'ipv6' && !ip.match(ipaddr.parse('2000::'), 3)) return false;
    // 文档、基准、协议专用网段同样不属于可抓取的公网目标。
    const denied = ip.kind() === 'ipv4'
      ? ['0.0.0.0/8', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '240.0.0.0/4']
      : ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'];
    return !denied.some(cidr => { const [network, bits] = ipaddr.parseCIDR(cidr); return ip.kind() === network.kind() && ip.match(network, bits); });
  } catch { return false; }
}

export function webUrl(value: unknown, origins?: string[]): URL {
  if (typeof value !== 'string' || value.length > 4096) throw Error('网页地址无效');
  let url: URL;
  try { url = new URL(value); } catch { throw Error('网页地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw Error('只支持无凭据的公网 HTTP/HTTPS 标准端口地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || /\.(localhost|local|internal|test|invalid|onion)\.?$/i.test(host) || !host.includes('.') && !isIP(host)) throw Error('不能访问本机或内部域名');
  if (isIP(host) && !publicAddress(host)) throw Error('不能访问非公网地址');
  if (origins && !origins.includes(url.origin)) throw Error('网页来源未获授权，请在计划中添加来源并重新确认');
  url.hash = '';
  return url;
}

/** DNS 校验后将同一个地址交给 socket，避免校验与连接之间再次解析。 */
export class SafeHttp {
  constructor(private readonly resolve: Resolver = webResolver()) {}
  async get(value: string, policy: WebPolicy = {}): Promise<WebResponse> {
    const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(policy.signal ? [policy.signal] : [])]);
    let url = webUrl(value, policy.origins);
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let abort: (() => void) | undefined;
      let addresses: { address: string; family: number }[];
      try {
        addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
          this.resolve(host), new Promise<never>((_, reject) => {
            abort = () => reject(Error('网页请求已取消或超时'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally { if (abort) signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw Error('域名解析到非公网地址，已拒绝访问');
      const address = addresses[0]!;
      const result = await this.once(url, address, signal, policy.maxBytes ?? 2 * 1024 * 1024);
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location || redirects === 5) throw Error('网页重定向无效或次数过多');
        url = webUrl(new URL(result.headers.location, url).href, policy.origins);
        if (policy.followRedirects === false) return { ...result, headers: { ...result.headers, location: url.href } };
        continue;
      }
      return result;
    }
    throw Error('网页重定向次数过多');
  }
  protected once(url: URL, address: { address: string; family: number }, signal: AbortSignal, maximum: number): Promise<WebResponse> {
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', agent: false, signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Workpivot/1.0)', accept: '*/*', 'accept-encoding': 'identity' },
        lookup: (_host, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, response => {
        void (async () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          const status = response.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) { response.destroy(); resolve({ url: url.href, status, headers, body: Buffer.alloc(0) }); return; }
          const encoding = headers['content-encoding']?.toLowerCase();
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          if (encoding && encoding !== 'identity' && !decoder) throw Error('不支持网页压缩格式');
          const stream = decoder ? response.pipe(decoder) : response;
          if (decoder) response.on('error', error => decoder.destroy(error));
          const chunks: Buffer[] = []; let size = 0;
          try {
            for await (const chunk of stream) { size += chunk.length; if (size > maximum) throw Error('网页响应超过大小限制'); chunks.push(Buffer.from(chunk)); }
            resolve({ url: url.href, status, headers, body: Buffer.concat(chunks) });
          } finally { stream.destroy(); response.destroy(); }
        })().catch(error => { response.destroy(); reject(error); });
      });
      request.on('error', () => reject(Error(signal.aborted ? '网页请求已取消或超时' : '网页连接失败')));
      request.end();
    });
  }
}
