import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { htmlContent, type WebContent } from './content.js';
import { SafeHttp, webUrl, type WebPolicy } from './safe-http.js';

export type BrowserAction = { kind: 'click'; selector: string } | { kind: 'scroll'; pixels: number } | { kind: 'wait'; milliseconds: number } | { kind: 'fill'; selector: string; text: string } | { kind: 'press'; key: string } | {kind:'reload'};
export interface BrowseInput { url: string; actions: BrowserAction[]; screenshot: boolean }
export interface BrowseResult extends WebContent { screenshot?: string; blockedRequests: number; blockedUrls?:string[]; fields?: {selector:string;type:string;value:string}[] }
export function browseInput(value: Record<string, unknown>): BrowseInput {
  const url = webUrl(value.url).href;
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
  async openPage(policy: WebPolicy = {}, signal?: AbortSignal): Promise<{ context: BrowserContext; page: Page; blocked: () => number; blockedUrls:()=>string[]; reset: () => void }> {
    const context = await (await this.getBrowser()).newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 } });
    try {
    signal?.throwIfAborted();
      let requests = 0, bytes = 0, blockedRequests = 0;
      let activeRequests = 0;const blockedUrls=new Set<string>();
      await context.routeWebSocket('**/*', socket => socket.close());
      await context.route('**/*', route => {
        const operation = (async () => {
          let counted = false;
          try {
            const request = route.request();
            if (++requests > 100 || request.method() !== 'GET' || bytes > 16 * 1024 * 1024 || activeRequests >= 8) throw Error('请求超出浏览器读取范围');
            webUrl(request.url(),policy.origins,policy.urls);
            activeRequests++; counted = true;
            const response = await this.http.get(request.url(), { ...policy, signal, maxBytes: 2 * 1024 * 1024, followRedirects: false });
            bytes += response.body.length;
            if (bytes > 16 * 1024 * 1024 || /attachment/i.test(response.headers['content-disposition'] ?? '')) throw Error('页面资源超限或尝试下载');
            // 只转交展示所需响应头，不携带服务凭据或持久 Cookie。
            const headers: Record<string, string> = { 'content-type': response.headers['content-type'] ?? 'application/octet-stream' };
            for (const key of ['location', 'access-control-allow-origin', 'content-security-policy', 'x-content-type-options']) if (response.headers[key]) headers[key] = response.headers[key];
            await route.fulfill({ status: response.status, headers, body: response.body });
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
  async close() { await this.starting?.catch(() => undefined); await this.browser?.close(); }
  async browse(input: BrowseInput, policy: WebPolicy = {}): Promise<BrowseResult> {
    webUrl(input.url, policy.origins);
    if (this.busy >= 2) throw Error('浏览器执行槽已满，请稍后重试');
    this.busy++;
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(45000), ...(policy.signal ? [policy.signal] : [])]);
    let context: Awaited<ReturnType<Browser['newContext']>> | undefined;
    const cancel = () => { void context?.close().catch(() => undefined); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      const session = await this.openPage(policy, signal);
      context = session.context; const page = session.page;
      const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (!response || !response.ok()) throw Error(`浏览器页面加载失败${response ? '，HTTP ' + response.status() : ''}`);
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
        webUrl(page.url(), policy.origins);
      }
      signal.throwIfAborted();
      const url = webUrl(page.url(), policy.origins).href;
      const html = await page.content();
      if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw Error('渲染后的网页超过大小限制');
      const result: BrowseResult = { ...htmlContent(html, url), blockedRequests: session.blocked(),blockedUrls:session.blockedUrls() };
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
