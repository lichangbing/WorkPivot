import {lookup} from 'node:dns/promises';
import {networkTargets,type NetworkTarget} from './network-target.js';
import {setTimeout as wait} from 'node:timers/promises';
import {retryAfter} from './retry.js';
import { requestQuota, type RequestQuota } from './request-quota.js';
import { webResolver } from './resolver.js';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export interface BrowserRequest {method:'GET'|'POST'|'OPTIONS';headers:Record<string,string>;body?:Buffer}
export interface WebResponse {setCookies?:string[];  url: string; status: number; headers: Record<string, string>; body: Buffer; retryCount?:number }
export interface WebPolicy { browserRequest?:BrowserRequest; targets?:NetworkTarget[]; urls?:string[]; origins?: string[]; signal?: AbortSignal; maxBytes?: number; followRedirects?: boolean; retryTransient?:boolean }

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

export function webUrl(value: unknown, origins?: string[], urls?:string[], targets?:NetworkTarget[]): URL {
  if (typeof value !== 'string' || value.length > 4096) throw Error('网页地址无效');
  let url: URL;
  try { url = new URL(value); } catch { throw Error('网页地址无效'); }
  url.hash='';
  const target=networkTargets(targets).find(item=>item.url===url.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (!target&&url.port)) throw Error('只支持无凭据的公网 HTTP/HTTPS 标准端口地址');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!target&&(host === 'localhost' || /\.(localhost|local|internal|test|invalid|onion)\.?$/i.test(host) || !host.includes('.') && !isIP(host))) throw Error('不能访问本机或内部域名');
  if (!target&&isIP(host) && !publicAddress(host)) throw Error('不能访问非公网地址');
  if (origins && !origins.includes(url.origin)) throw Error('网页来源未获授权，请在计划中添加来源并重新确认');
  url.hash = '';
  if(urls!==undefined&&!urls.includes(url.href))throw Error('完整网页地址未获授权');
  return url;
}

/** DNS 校验后将同一个地址交给 socket，避免校验与连接之间再次解析。 */
export class SafeHttp {
  private readonly lifecycle = new AbortController();
  constructor(private readonly resolve: Resolver = webResolver(), private readonly quota: RequestQuota = requestQuota, private readonly resolveInternal:Resolver=host=>lookup(host,{all:true})) {}
  close() { this.lifecycle.abort(); }
  async get(value: string, policy: WebPolicy = {}): Promise<WebResponse> {
    if(policy.browserRequest&&policy.followRedirects!==false)throw Error('带登录态的请求禁止自动跟随跳转');
    const signal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(20000), ...(policy.signal ? [policy.signal] : [])]);
    let url = webUrl(value, policy.origins,policy.urls,policy.targets);
    const deadline=performance.now()+20000;let retries=0;
    for (let redirects = 0; redirects <= 5;) {
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const target=networkTargets(policy.targets).find(item=>item.url===url.href);
      let abort: (() => void) | undefined;
      let addresses: { address: string; family: number }[];
      try {
        addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
          (target?this.resolveInternal:this.resolve)(host), new Promise<never>((_, reject) => {
            abort = () => reject(Error('网页请求已取消或超时'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          }),
        ]);
      } finally { if (abort) signal.removeEventListener('abort', abort); }
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(a => target?ipaddr.process(a.address).toNormalizedString()!==ipaddr.process(target.address).toNormalizedString():!publicAddress(a.address))) throw Error('域名解析到非公网地址，已拒绝访问');
      const address = addresses[0]!;
      const release = await this.quota.acquire(host.toLowerCase().replace(/\.$/, ''), signal);
      let result: WebResponse,retryDelay:number|undefined;
      try {
        signal.throwIfAborted();
        result = await this.once(url, address, signal, policy.maxBytes ?? 2 * 1024 * 1024,policy.browserRequest);
        if(policy.retryTransient&&!policy.browserRequest&&[429,502,503,504].includes(result.status)){
          retryDelay=Math.max(retryAfter(result.headers['retry-after'])??0,500*2**retries+Math.floor(Math.random()*250));
          // 释放槽之前发布冷却，防止已排队的同站点请求抢先发出。
          this.quota.defer(host.toLowerCase().replace(/\.$/,''),retryDelay);
        }
      } finally { release(); }
      if(retryDelay!==undefined){
        const backoff=retryDelay;
        // 同站点的其他调用也需遵守服务端冷却；等待不占用执行槽。
        if(retries<2&&backoff<deadline-performance.now()){
          await wait(backoff,undefined,{signal});retries++;continue;
        }
      }
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location || redirects === 5) throw Error('网页重定向无效或次数过多');
        url = webUrl(new URL(result.headers.location, url).href, policy.origins,policy.followRedirects===false?undefined:policy.urls,policy.targets);
        if (policy.followRedirects === false) return { ...result, retryCount:retries, headers: { ...result.headers, location: url.href } };
        redirects++;continue;
      }
      return {...result,retryCount:retries};
    }
    throw Error('网页重定向次数过多');
  }
  protected once(url: URL, address: { address: string; family: number }, signal: AbortSignal, maximum: number, browserRequest?:BrowserRequest): Promise<WebResponse> {
    if(browserRequest){
      const allowed=['cookie','content-type','origin','referer','authorization','accept','x-requested-with','x-csrf-token','x-xsrf-token'];
      if(!['GET','POST','OPTIONS'].includes(browserRequest.method)||browserRequest.body&&browserRequest.body.length>65536||JSON.stringify(browserRequest.headers).length>65536||Object.entries(browserRequest.headers).some(([name,value])=>!allowed.includes(name)||/[\r\n]/.test(value)))throw Error('登录请求超出允许范围');
    }
    return new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: browserRequest?.method??'GET', agent: false, signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; Workpivot/1.0)', accept: '*/*', 'accept-encoding': 'identity',...browserRequest?.headers },
        lookup: (_host, options, callback) => {
          if (typeof options === 'object' && options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, response => {
        void (async () => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers[key] = Array.isArray(value) ? value.join(', ') : value;
          const status = response.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) { response.destroy(); resolve({ url: url.href, status, headers, setCookies:response.headers['set-cookie'], body: Buffer.alloc(0) }); return; }
          const encoding = headers['content-encoding']?.toLowerCase();
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          if (encoding && encoding !== 'identity' && !decoder) throw Error('不支持网页压缩格式');
          const stream = decoder ? response.pipe(decoder) : response;
          if (decoder) response.on('error', error => decoder.destroy(error));
          const chunks: Buffer[] = []; let size = 0;
          try {
            for await (const chunk of stream) { size += chunk.length; if (size > maximum) throw Error('网页响应超过大小限制'); chunks.push(Buffer.from(chunk)); }
            resolve({ url: url.href, status, headers, setCookies:response.headers['set-cookie'], body: Buffer.concat(chunks) });
          } finally { stream.destroy(); response.destroy(); }
        })().catch(error => { response.destroy(); reject(error); });
      });
      request.on('error', () => reject(Error(signal.aborted ? '网页请求已取消或超时' : '网页连接失败')));
      request.end(browserRequest?.body);
    });
  }
}
