import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { BrowserEngine, browseInput } from './browser-engine.js';
import { webUrl } from './safe-http.js';
import { BrowserSessions } from './browser-sessions.js';

export function browserService(token: string, engine = new BrowserEngine()) {
  if (token.length < 32 || /\s/.test(token)) throw Error('浏览器服务令牌至少32位且不能含空白');
  const app = express();
  const sessions = new BrowserSessions(engine);
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => { response.json({ ok: true }); });
  app.use((request, response, next) => {
    const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.status(401).json({ error: '浏览器服务未授权' }); return; }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.post('/v1/browse', async (request, response) => {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', cancel);
    try {
      const body = request.body;
      if (!body || typeof body !== 'object') throw Error('浏览器参数无效');
      const input = browseInput({ ...body, url: body.url ?? (body.sessionId ? 'https://placeholder.example' : undefined) });
      const origins = body.origins;
      if (origins !== undefined && (!Array.isArray(origins) || origins.length > 20 || origins.some(origin => typeof origin !== 'string' || webUrl(origin).origin !== origin))) throw Error('网页来源配置无效');
      if (body.sessionId) {
        if (typeof body.sessionId !== 'string' || origins !== undefined) throw Error('共享浏览器参数无效');
        response.json(await sessions.browse(body.sessionId, input, body.url !== undefined, controller.signal));
      } else response.json(await engine.browse(input, { origins, signal: controller.signal }));
    } catch (error) {
      if (!controller.signal.aborted) response.status(422).json({ error: error instanceof Error ? error.message.slice(0, 300) : '浏览器操作失败' });
    } finally { response.removeListener('close', cancel); }
  });
  app.get('/v1/sessions/:id', async (request, response) => {
    try { response.json(await sessions.snapshot(String(request.params.id))); }
    catch { response.status(422).json({ error: '浏览器画面暂不可用，请重新打开页面' }); }
  });
  app.post('/v1/sessions/:id', async (request, response) => {
    const controller = new AbortController(); const cancel = () => { if (!response.writableEnded) controller.abort(); }; response.on('close', cancel);
    try { response.json(await sessions.command(String(request.params.id), request.body ?? {}, controller.signal)); }
    catch (error) { if (!controller.signal.aborted) response.status(422).json({ error: error instanceof Error && !error.message.includes('\n') ? error.message.slice(0, 300) : '浏览器操作失败，请检查页面或服务状态' }); }
    finally { response.removeListener('close', cancel); }
  });
  app.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => { void _next; response.status(400).json({ error: '浏览器请求格式或大小无效' }); });
  return { app, close: async () => { await sessions.close(); await engine.close(); } };
}
