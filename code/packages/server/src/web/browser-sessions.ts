import { BrowserEngine, type BrowseInput, type BrowseResult } from './browser-engine.js';
import { htmlContent } from './content.js';
import { webUrl } from './safe-http.js';

type Managed = Awaited<ReturnType<BrowserEngine['openPage']>>;
export interface BrowserFrame { open: boolean; busy: boolean; url: string; title: string; image?: string; width: number; height: number; blockedRequests: number }
interface Session { managed: Managed; controller: AbortController; touched: number; busy: boolean; frame?: BrowserFrame; capture?:Promise<BrowserFrame> }
/** 会话键由可信后端按账号和任务派生；只保留临时上下文，不落盘登录状态。 */
export class BrowserSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly creating = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly engine: BrowserEngine) {
    this.timer = setInterval(() => { for (const [id, s] of this.sessions) if (Date.now() - s.touched > 10 * 60000) void this.close(id); }, 30000); this.timer.unref();
  }
  private key(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw Error('浏览器会话标识无效'); }
  private async get(id: string): Promise<Session> {
    this.key(id);
    const old = this.sessions.get(id);
    if (old && !old.managed.page.isClosed()) return old;
    if (old) this.sessions.delete(id);
    if (this.creating.has(id)) throw Error('浏览器会话正在创建，请稍后重试');
    if (this.sessions.size + this.creating.size >= 4) throw Error('浏览器会话已满，请关闭其他页面');
    this.creating.add(id); const controller = new AbortController();
    try {
      const managed = await this.engine.openPage({}, controller.signal);
      const session: Session = { managed, controller, touched: Date.now(), busy: false };
      this.sessions.set(id, session); return session;
    } finally { this.creating.delete(id); }
  }
  async close(id?: string) {
    if (id) this.key(id); else clearInterval(this.timer);
    for (const [key, session] of this.sessions) if (!id || id === key) { this.sessions.delete(key); session.controller.abort(); await session.managed.context.close().catch(() => undefined); }
  }
  private async frame(session: Session): Promise<BrowserFrame> {
    const page = session.managed.page, url = page.url();
    if (url !== 'about:blank') webUrl(url);
    const size = page.viewportSize() ?? { width: 1280, height: 800 };
    const result: BrowserFrame = { open: true, busy: false, url: url === 'about:blank' ? '' : url, title: (await page.title()).slice(0, 500), image: (await page.screenshot({ type: 'jpeg', quality: 65, timeout: 5000 })).toString('base64'), ...size, blockedRequests: session.managed.blocked() };
    session.frame = result; return result;
  }
  async snapshot(id: string): Promise<BrowserFrame> {
    this.key(id); const session = this.sessions.get(id);
    if (!session || session.managed.page.isClosed()) return { open: false, busy: false, url: '', title: '', width: 1280, height: 800, blockedRequests: 0 };
    if (session.busy) return { ...(session.frame ?? { open: true, url: '', title: '', width: 1280, height: 800, blockedRequests: 0 }), busy: true };
    session.capture ??= this.frame(session).finally(()=>{session.capture=undefined;});
    return session.capture;
  }
  private async exclusive<T>(id: string, operation: (session: Session) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const session = await this.get(id);
    if(session.capture)await session.capture.catch(()=>undefined);
    if (session.busy) throw Error('浏览器正由AI或其他操作占用，请稍后重试');
    session.busy = true; session.touched = Date.now(); session.managed.reset();
    const timeout = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    const cancel = () => { void this.close(id); };
    timeout.addEventListener('abort', cancel, { once: true });
    try { timeout.throwIfAborted(); const result = await operation(session); timeout.throwIfAborted(); return result; }
    finally { timeout.removeEventListener('abort', cancel); session.busy = false; }
  }
  async command(id: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<BrowserFrame> {
    if (input.kind === 'close') { await this.close(id); return this.snapshot(id); }
    return this.exclusive(id, async session => {
      const page = session.managed.page;
      switch (input.kind) {
        case 'navigate': { const response = await page.goto(webUrl(input.url).href, { waitUntil: 'domcontentloaded', timeout: 20000 }); if (!response?.ok()) throw Error('网页加载失败'); break; }
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }); break;
        case 'forward': await page.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }); break;
        case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); break;
        case 'click': {
          const { x, y } = input, size = page.viewportSize()!;
          if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height) throw Error('点击坐标无效');
          await page.mouse.click(x, y); break;
        }
        case 'scroll': if (!Number.isInteger(input.pixels) || Math.abs(Number(input.pixels)) > 5000) throw Error('滚动距离无效'); else await page.mouse.wheel(0, Number(input.pixels)); break;
        case 'text': if (typeof input.text !== 'string' || input.text.length > 4000) throw Error('输入文本过长'); else await page.keyboard.insertText(input.text); break;
        case 'key': if (typeof input.key !== 'string' || !['Enter','Backspace','Delete','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Escape','Control+A','Meta+A'].includes(input.key)) throw Error('按键不受支持'); else await page.keyboard.press(input.key); break;
        case 'resize': {
          const { width, height } = input;
          if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 320 || Number(width) > 1920 || Number(height) < 240 || Number(height) > 1200) throw Error('视口尺寸无效');
          await page.setViewportSize({ width: Number(width), height: Number(height) }); break;
        }
        default: throw Error('浏览器操作无效');
      }
      return this.frame(session);
    }, signal);
  }
  async browse(id: string, input: BrowseInput, navigate: boolean, signal?: AbortSignal): Promise<BrowseResult> {
    return this.exclusive(id, async session => {
      const page = session.managed.page;
      if (navigate && page.url() !== input.url) { const response = await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); if (!response?.ok()) throw Error('网页加载失败'); }
      if (page.url() === 'about:blank') throw Error('请先打开一个网页');
      for (const action of input.actions) {
        if (action.kind === 'click') await page.locator(action.selector).click();
        else if (action.kind === 'scroll') await page.mouse.wheel(0, action.pixels);
        else if(action.kind==='wait') await page.waitForTimeout(action.milliseconds);
        else if(action.kind==='fill'){const target=page.locator(action.selector);if(await target.getAttribute('type')==='password')throw Error('密码请由用户手动输入');await target.fill(action.text);}
        else await page.keyboard.press(action.key);
        webUrl(page.url());
      }
      const html = await page.content(); if (Buffer.byteLength(html) > 4 * 1024 * 1024) throw Error('渲染内容过大');
      const result: BrowseResult = { ...htmlContent(html, webUrl(page.url()).href), blockedRequests: session.managed.blocked() };
      result.fields = await page.locator('input,textarea,select').evaluateAll(elements=>elements.slice(0,30).map((element,index)=>{const field=element as typeof element & {value?:string;type?:string};const sensitive=['password','hidden'].includes(field.type??'');return {selector:'input,textarea,select >> nth='+index,type:field.type||element.tagName.toLowerCase(),value:sensitive?'[隐藏]':String(field.value??'').slice(0,1000)};}));
      if (input.screenshot) result.screenshot = (await page.screenshot({ type: 'png', timeout: 5000 })).toString('base64');
      await this.frame(session); return result;
    }, signal);
  }
}
