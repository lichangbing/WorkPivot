import {loginState} from './login-state.js';
import type {NetworkTarget} from './network-target.js';
import {ResourceArchive} from './resource-archive.js';
import type {Original} from './original.js';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { htmlContent, type WebContent } from './content.js';
import { SafeHttp, webUrl, type WebPolicy, type WebResponse } from './safe-http.js';

export type LoginState=Awaited<ReturnType<BrowserContext['storageState']>>;
export interface BrowserIdentity {state?:LoginState;manual?:boolean}
export type BrowserAction = { kind: 'click'; selector: string } | { kind: 'scroll'; pixels: number } | { kind: 'wait'; milliseconds: number } | { kind: 'fill'; selector: string; text: string } | { kind: 'press'; key: string } | {kind:'reload'};
export interface BrowseInput { url: string; actions: BrowserAction[]; screenshot: boolean }
export interface BrowseResult extends WebContent { screenshot?: string; original?:Original; blockedRequests: number; blockedUrls?:string[]; fields?: {selector:string;type:string;value:string}[] }
export function browseInput(value: Record<string, unknown>,targets?:NetworkTarget[]): BrowseInput {
  const url = webUrl(value.url,undefined,undefined,targets).href;
  if (value.screenshot !== undefined && typeof value.screenshot !== 'boolean') throw Error('截图参数无效');
  const actions = value.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 10) throw Error('浏览器最多执行10步操作');
  const parsed: BrowserAction[] = actions.map(action => {
    if (!action || typeof action !== 'object') throw Error('浏览器操作无效');
    if(action.kind==='reload')return {kind:'reload'};
    if (action.kind === 'click' && typeof action.selector === 'string' && action.selector.trim() && action.selector.length <= 300) return { kind: 'click', selector: action.selector };
    if (action.kind === 'scroll' && Number.isInteger(action.pixels) && Math.abs(action.pixels) <= 5000) return { kind: 'scroll', pixels: action.pixels };
    if (action.kind === 'wait' && Number.isInteger(action.milliseconds) && action.milliseconds >= 0 && action.milliseconds <= 3000) return { kind: 'wait', milliseconds: action.milliseconds };
    if (action.kind === 'fill' && typeof action.selector === 'string' && action.selector.length <= 300 && typeof action.text === 'string' && action.text.length <= 4000) return {kind:'fill',selector:action.selector,text:action.text};
    if (action.kind === 'press' && typeof action.key === 'string' && ['Enter','Tab','Escape','ArrowDown','ArrowUp'].includes(action.key)) return {kind:'press',key:action.key};
    throw Error('浏览器操作参数无效');
  });
  return { url, actions: parsed, screenshot: value.screenshot === true };
}

/** 单次浏览即单个隔离上下文；浏览器无文件卷和数据库权限。 */
export class BrowserEngine {
  private browser?: Browser;
  private starting?: Promise<Browser>;
  private busy = 0;
  constructor(private readonly http = new SafeHttp(), private readonly launchOptions: Parameters<typeof chromium.launch>[0] = {}) {}
  private async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    // Chromium 自身没有直连出口；只有被拦截并由 SafeHttp 完成的请求能取得资源。
    this.starting ??= chromium.launch({ ...this.launchOptions, headless: true, chromiumSandbox: true,
      proxy: { server: 'http://127.0.0.1:9' },
      args: [...(this.launchOptions?.args ?? []), '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic'],
    }).then(browser => this.browser = browser).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  async openPage(policy: WebPolicy = {}, signal?: AbortSignal, archive?: (response:WebResponse)=>void, identity?:BrowserIdentity): Promise<{ context: BrowserContext; page: Page; blocked: () => number; blockedUrls:()=>string[]; reset: () => void }> {
    const context = await (await this.getBrowser()).newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 },...(identity?.state?{storageState:loginState(identity.state)}:{}) });
    const lifetime = new AbortController();
    context.once('close', () => lifetime.abort());
    signal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : []), ...(policy.signal ? [policy.signal] : [])]);
    try {
    signal.throwIfAborted();
      let requests = 0, bytes = 0, blockedRequests = 0;
      let activeRequests = 0;const blockedUrls=new Set<string>();
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', route => {
        const operation = (async () => {
          let counted = false;
          try {
            const request = route.request();
            if (++requests > 100 || !(identity?.manual?['GET','POST','OPTIONS']:['GET']).includes(request.method()) || bytes > 16 * 1024 * 1024 || activeRequests >= 8) throw Error('请求超出浏览器读取范围');
            webUrl(request.url(),policy.origins,policy.urls,policy.targets);
            activeRequests++; counted = true;
            const allHeaders=identity?await request.allHeaders():{};
            const headersToSend=Object.fromEntries(Object.entries(allHeaders).filter(([name])=>['cookie','content-type','origin','referer','authorization','accept','x-requested-with','x-csrf-token','x-xsrf-token'].includes(name)));
            const postData=request.postDataBuffer()??undefined;
            if(identity&&postData&&postData.length>65536)throw Error('登录请求体过大');
            const response = await this.http.get(request.url(), { ...policy, signal, maxBytes: 2 * 1024 * 1024, followRedirects: false,...(identity?{browserRequest:{method:request.method() as 'GET'|'POST'|'OPTIONS',headers:headersToSend,body:postData}}:{}) });
            archive?.(response);
            bytes += response.body.length;
            if (bytes > 16 * 1024 * 1024 || /attachment/i.test(response.headers['content-disposition'] ?? '')) throw Error('页面资源超限或尝试下载');
            // 普通浏览仅转交展示响应头；私人登录模式另行保留站点Cookie。
            const headers: Record<string, string> = { 'content-type': response.headers['content-type'] ?? 'application/octet-stream' };
            for (const key of ['location', 'access-control-allow-origin', 'content-security-policy', 'x-content-type-options']) if (response.headers[key]) headers[key] = response.headers[key];
            if(identity&&response.setCookies?.length)headers['set-cookie']=response.setCookies.join('\n');
            if(identity)for(const key of ['access-control-allow-credentials','access-control-allow-headers','access-control-allow-methods'])if(response.headers[key])headers[key]=response.headers[key];
            if(identity?.manual&&[301,302,303,307,308].includes(response.status)){
              // Playwright不保证重新拦截3xx目标；只把顶层GET跳转变成新的导航，保留逐URL出口校验。
              // 307/308必须保留POST，不能擅自重放登录凭据或改成GET。
              if(!request.isNavigationRequest()||request.frame()!==context.pages()[0]?.mainFrame()||!response.headers.location)throw Error('此登录重定向暂不支持，请人工核对');
              if([307,308].includes(response.status)&&request.method()!=='GET'){
                await route.fulfill({status:200,headers:{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'"},body:'<!doctype html><title>登录跳转已阻止</title><p>该站点要求通过307/308重发登录表单，当前接管不支持此流程，未重发凭据。请关闭窗口，不要保存未完成的登录状态。</p>'});return;
              }
              const destination=new URL(response.headers.location,request.url()).href;
              try{webUrl(destination,policy.origins,policy.urls,policy.targets);}catch{if(destination.length<=4096&&blockedUrls.size<50)blockedUrls.add(destination);throw Error('登录跳转地址未授权');}
              const escaped=destination.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
              const navigationHeaders:Record<string,string>={'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; base-uri 'none'"};
              if(headers['set-cookie'])navigationHeaders['set-cookie']=headers['set-cookie'];
              await route.fulfill({status:200,headers:navigationHeaders,body:'<!doctype html><meta http-equiv="refresh" content="0;url='+escaped+'"><title>正在跳转</title><a href="'+escaped+'">继续访问已授权页面</a>'});
            }else await route.fulfill({ status: response.status, headers, body: response.body });
          } catch { blockedRequests++;const url=route.request().url();if(url.length<=4096&&blockedUrls.size<50)blockedUrls.add(url);await route.abort('blockedbyclient').catch(() => undefined); }
          finally { if (counted) activeRequests--; }
        })();
        return operation;
      });
      const page = await context.newPage();
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      page.on('dialog', dialog => { void dialog.dismiss(); });
      page.setDefaultTimeout(5000);
    return { context, page, blocked: () => blockedRequests, blockedUrls:()=>[...blockedUrls], reset: () => { requests = 0; bytes = 0; } };
    } catch (error) { await context.close().catch(() => undefined); throw error; }
  }
  fetch(url: string, policy: WebPolicy) { return this.http.get(url, policy); }
  async close() { this.http.close(); await this.starting?.catch(() => undefined); await this.browser?.close(); }
  async browse(input: BrowseInput, policy: WebPolicy = {}, includeOriginal=false,identity?:BrowserIdentity): Promise<BrowseResult> {
    webUrl(input.url, policy.origins,policy.urls,policy.targets);
    if (this.busy >= 2) throw Error('浏览器执行槽已满，请稍后重试');
    this.busy++;
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(45000), ...(policy.signal ? [policy.signal] : [])]);
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    const cancel = () => { void context?.close().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const archive=includeOriginal?new ResourceArchive():undefined;
      const session = await this.openPage(policy, signal,archive?response=>archive.add(response):undefined,identity?{state:identity.state}:undefined);
      context = session.context; const page = session.page;
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (!response || !response.ok()) throw Error(`浏览器页面加载失败${response ? '，HTTP ' + response.status() : ''}`);
      if(identity&&await page.locator('input[type=password]:visible').count())throw Error('登录状态失效，需要人工登录');
      for (const action of input.actions) {
        signal.throwIfAborted();
        if (action.kind === 'click') {
          const target = page.locator(action.selector);
          const tag = await target.evaluate(element => ({ tag: element.tagName, type: element.getAttribute('type'), form: !!element.closest('form') }));
          if (tag.form || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag.tag)) throw Error('浏览器首期不支持表单、登录或提交操作');
          await target.click();
          await page.waitForLoadState('domcontentloaded');
        } else if(action.kind==='reload')await page.reload({waitUntil:'domcontentloaded'});
        else if (action.kind === 'scroll') await page.mouse.wheel(0, action.pixels);
        else if(action.kind==='wait') await page.waitForTimeout(action.milliseconds);
        else throw Error('输入和按键操作仅支持对话共享浏览器');
        webUrl(page.url(), policy.origins,policy.urls,policy.targets);
      }
      signal.throwIfAborted();
      const url = webUrl(page.url(), policy.origins,policy.urls,policy.targets).href;
      const html = await page.content();
      if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw Error('渲染后的网页超过大小限制');
      const result: BrowseResult = { ...htmlContent(html, url), blockedRequests: session.blocked(),blockedUrls:session.blockedUrls() };
      if(archive)result.original=archive.finish(url,html,session.blockedUrls());
      if (input.screenshot) result.screenshot = (await page.screenshot({ type: 'png', fullPage: false, timeout: 5000 })).toString('base64');
      if (session.blocked()) result.warning += ' 部分请求被安全策略阻止，页面可能不完整。';
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw Error('浏览器操作已取消或超时');
      if (error instanceof Error && !/\n/.test(error.message) && !/browserType|Executable|Target|page\./.test(error.message)) throw error;
      throw Error('浏览器操作失败，请检查页面、选择器或浏览器服务运行环境');
    } finally { signal.removeEventListener('abort', cancel); lifecycle.abort(); await context?.close().catch(() => undefined); this.busy--; }
  }
}
