import {BrowserLogin} from './browser-login.js';
import {networkTargets} from './network-target.js';
import {originalResponse} from './original.js';
import express from 'express';
import { responseContent } from './content.js';
import { timingSafeEqual } from 'node:crypto';
import { BrowserEngine, browseInput } from './browser-engine.js';
import { webUrl } from './safe-http.js';
import { BrowserSessions } from './browser-sessions.js';

export function browserService(token: string, engine = new BrowserEngine()) {
  if (token.length < 32 || /\s/.test(token)) throw Error('浏览器服务令牌至少32位且不能含空白');
  const app = express();
  const sessions = new BrowserSessions(engine);
  const logins = new BrowserLogin(engine);
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => { response.json({ ok: true }); });
  app.use((request, response, next) => {
    const actual = Buffer.from(request.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { response.status(401).json({ error: '浏览器服务未授权' }); return; }
    next();
  });
  app.use(express.json({ limit: '512kb' }));
  app.post('/v1/logins/:id',async(request,response)=>{
    const id=String(request.params.id),body=request.body??{};
    try{
      if(body.kind==='start'){
        const targets=networkTargets(body.targets),urls=body.urls;
        if(!Array.isArray(urls)||urls.length>20||urls.some(url=>typeof url!=='string'||webUrl(url,undefined,undefined,targets).href!==url))throw Error('登录地址范围无效');
        response.json(await logins.start(id,webUrl(body.url,undefined,urls,targets).href,{urls,targets},body.state));
      }else if(body.kind==='heartbeat')response.json(await logins.heartbeat(id));
      else if(body.kind==='frame')response.json(await logins.frame(id));
      else if(body.kind==='state')response.json({state:await logins.state(id)});
      else if(body.kind==='close'){await logins.close(id);response.json({ok:true});}
      else response.json(await logins.command(id,body));
    }catch{response.status(422).json({error:'登录窗口操作失败、地址未授权或会话已过期，请核对后重试'});}
  });
  app.post('/v1/fetch', async (request, response) => {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', cancel);
    try {
      const body = request.body;
      if (!body || typeof body !== 'object' || body.origins !== undefined) throw Error('采集参数无效');
      const urls = body.urls;
      const targets=networkTargets(body.targets);
      if(targets.length&&urls===undefined)throw Error('内网规则需要完整地址范围');
      if(body.includeOriginal!==undefined&&typeof body.includeOriginal!=='boolean')throw Error('存档参数无效');
      if(body.includeOriginal&&urls===undefined)throw Error('原始存档需要已确认地址范围');
      if (urls !== undefined && (!Array.isArray(urls) || urls.length > 20 || urls.some(url => typeof url !== 'string' || webUrl(url,undefined,undefined,targets).href !== url))) throw Error('完整地址配置无效');
      const url = webUrl(body.url, undefined, urls,targets).href;
      const result = await engine.fetch(url, { urls,targets, signal: controller.signal, retryTransient:urls!==undefined, followRedirects: urls !== undefined });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        response.json({ url: result.url, status: result.status, redirectUrl: result.headers.location, notice: '目标发生跳转，尚未访问新地址；需要对新地址另行确认。' });
      } else response.json({...responseContent(result,body.includeOriginal===true),...(body.includeOriginal?{original:originalResponse(result)}:{})});
    } catch (error) {
      if (!controller.signal.aborted) response.status(422).json({ error: error instanceof Error ? error.message.slice(0, 300) : '网页采集失败' });
    } finally { response.removeListener('close', cancel); }
  });
  app.post('/v1/browse', async (request, response) => {
    const controller = new AbortController();
    const cancel = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', cancel);
    try {
      const body = request.body;
      if (!body || typeof body !== 'object') throw Error('浏览器参数无效');
      const targets=networkTargets(body.targets);
      if(targets.length&&(body.sessionId||body.urls===undefined))throw Error('内网规则仅支持独立自动化浏览器');
      const input = browseInput({ ...body, url: body.url ?? (body.sessionId ? 'https://placeholder.example' : undefined) },targets);
      const resourceUrls=body.resourceUrls??[];
      if(!Array.isArray(resourceUrls)||resourceUrls.length>20||resourceUrls.some(url=>typeof url!=='string'))throw Error('追加地址列表无效');
      const allowedUrls=resourceUrls.map(url=>webUrl(url,undefined,undefined,targets).href);
      if(body.origins!==undefined)throw Error('旧来源授权已停用，请使用完整 URL 授权');
      const urls=body.urls;
      if(urls!==undefined&&(!Array.isArray(urls)||urls.length>20||urls.some(url=>typeof url!=='string'||webUrl(url,undefined,undefined,targets).href!==url)))throw Error('完整地址配置无效');
      if(body.includeOriginal!==undefined&&typeof body.includeOriginal!=='boolean')throw Error('存档参数无效');
      if(body.includeOriginal&&(body.sessionId||urls===undefined))throw Error('DOM存档仅支持已确认地址的独立自动化浏览器');
      if(body.profileState&&(body.sessionId||urls===undefined||Buffer.byteLength(JSON.stringify(body.profileState))>256*1024))throw Error('私人登录状态只能用于独立且有界的自动化');
      if (body.sessionId) {
        if (typeof body.sessionId !== 'string' || urls !== undefined) throw Error('共享浏览器参数无效');
        response.json(await sessions.browse(body.sessionId, input, body.url !== undefined, controller.signal,body.expectedRevision,allowedUrls));
      } else {
        // 自动化白名单来自服务端计划，模型提供的附加地址不能扩大它。
        if(urls!==undefined){webUrl(input.url,undefined,urls,targets);for(const url of allowedUrls)webUrl(url,undefined,urls,targets);}
        response.json(await engine.browse(input, { targets,urls:urls??[input.url,...allowedUrls],signal: controller.signal },body.includeOriginal===true,body.profileState?{state:body.profileState}:undefined));
      }
    } catch (error) {
      if (!controller.signal.aborted) response.status(422).json({ error: error instanceof Error ? error.message.slice(0, 300) : '浏览器操作失败' });
    } finally { response.removeListener('close', cancel); }
  });
  app.get('/v1/sessions/:id/authorization', async (request,response)=>{
    try {response.json(await sessions.authorization(String(request.params.id)));}
    catch {response.status(422).json({error:'页面正在变化或被占用，请稍后重新申请授权'});}
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
  return { app, close: async () => { await logins.close(); await sessions.close(); await engine.close(); } };
}
