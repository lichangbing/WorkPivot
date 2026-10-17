import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SafeHttp, publicAddress, webUrl, type WebPolicy, type WebResponse } from '../packages/server/src/web/safe-http.js';
import { htmlContent, responseContent } from '../packages/server/src/web/content.js';
import { BrowserEngine, browseInput } from '../packages/server/src/web/browser-engine.js';
import { browserService } from '../packages/server/src/web/browser-service.js';
import { WebTools } from '../packages/server/src/web/tools.js';
import { webResolver } from '../packages/server/src/web/resolver.js';
import { automationConfig } from '../packages/server/src/database/automation-time.js';
import { newAutomationConfig } from '../packages/shared/src/automation.js';
import { runAgentLoop, type ModelClient } from '../packages/core/src/index.js';

let count = 0;
const check = async (name: string, run: () => unknown | Promise<unknown>) => { await run(); console.log('PASS', name); count++; };
for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','192.0.2.1','198.18.0.1','224.0.0.1','::1','::','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
await check('公网IP与私网/保留IP分类', () => undefined);
await check('URL拒绝非HTTP、凭据、内网及非标准端口', () => {
  for (const url of ['file:///etc/passwd','ftp://example.com','https://a:b@example.com','http://localhost','http://2130706433','http://[::1]','https://example.com:8443','https://foo.local/']) assert.throws(() => webUrl(url));
  assert.throws(() => webUrl('https://example.com', []));
});
await check('拒绝混合公网/私网DNS解析及已取消请求', async () => {
  await assert.rejects(new SafeHttp(async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]).get('https://example.com'), /非公网/);
  await assert.rejects(new SafeHttp().get('https://example.com', { signal: AbortSignal.abort() }));
  const controller = new AbortController(); const pending = new SafeHttp(() => new Promise(() => undefined)).get('https://example.com', { signal: controller.signal }); controller.abort(); await assert.rejects(pending);
});
await check('管理员DoH配置、缓存和解析后私网校验', async () => {
  assert.throws(() => webResolver('http://example.com/dns-query'));
  assert.throws(() => webResolver('https://a:b@example.com/dns-query'));
  const original = globalThis.fetch; let queries = 0;
  try {
    globalThis.fetch = async input => { queries++; const url = new URL(String(input)); assert.equal(url.searchParams.get('name'), 'fixture.example'); return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }), { headers: { 'content-type': 'application/dns-json' } }); };
    const resolve = webResolver('https://resolver.example/dns-query');
    await assert.rejects(new SafeHttp(resolve).get('https://fixture.example'), /非公网/);
    await resolve('fixture.example'); assert.equal(queries, 2);
  } finally { globalThis.fetch = original; }
});
await check('重定向逐跳校验，连接沿用已验证的DNS地址', async () => {
  const connections: string[] = [];
  let next = 'http://127.0.0.1/private';
  class RedirectHttp extends SafeHttp {
    protected override async once(url: URL, address: { address: string; family: number }): Promise<WebResponse> {
      connections.push(address.address);
      return { url: url.href, status: 302, headers: { location: next }, body: Buffer.alloc(0) };
    }
  }
  const http = new RedirectHttp(async () => [{ address: '8.8.8.8', family: 4 }]);
  await assert.rejects(http.get('https://example.com'), /非公网/); assert.deepEqual(connections, ['8.8.8.8']);
  next = 'https://other.example/next';
  await assert.rejects(http.get('https://example.com', { origins: ['https://example.com'] }), /未获授权/);
  next = 'https://example.com/loop'; await assert.rejects(http.get('https://example.com'), /次数过多/);
});
await check('HTML正文、来源与相对链接，不执行脚本', () => {
  const result = htmlContent('<html><head><title>公告</title></head><body><p>测试公告正文</p><a href="/detail">详情</a><script>秘密脚本指令</script></body></html>', 'https://example.com/list');
  assert.equal(result.title, '公告'); assert.match(result.text, /测试公告正文/); assert.doesNotMatch(result.text, /秘密脚本指令/); assert.equal(result.links[0]?.url, 'https://example.com/detail');
});
await check('编码、JSON、截断、HTTP错误与二进制拒绝', () => {
  const source = { url: 'https://example.com', status: 200, headers: { 'content-type': 'text/plain;charset=gbk' }, body: Buffer.from([0xd6,0xd0,0xce,0xc4]) };
  assert.equal(responseContent(source).text, '中文');
  assert.equal(responseContent({ ...source, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"a":1}') }).text, '{"a":1}');
  assert.equal(responseContent({ ...source, body: Buffer.alloc(25000, 'a') }).truncated, true);
  assert.throws(() => responseContent({ ...source, status: 403 }), /403/);
  assert.throws(() => responseContent({ ...source, headers: { 'content-type': 'application/pdf' } }), /专用文件/);
});
await check('旧自动化默认无网页权限；新来源必须明确且有效', () => {
  const config = { ...newAutomationConfig(), name: '采集', requirements: '读取公告', skill: 'sample', releaseId: randomUUID() };
  assert.deepEqual(automationConfig(config).webOrigins, []);
  assert.deepEqual(automationConfig({ ...config, webOrigins: ['https://example.com'] }).webOrigins, ['https://example.com']);
  for (const origin of ['http://127.0.0.1','https://example.com/path']) assert.throws(() => automationConfig({ ...config, webOrigins: [origin] }));
});
await check('浏览器输入边界', () => {
  assert.throws(() => browseInput({ url: 'https://example.com', actions: [{ kind: 'evaluate', script: 'alert(1)' }] }));
  assert.throws(() => browseInput({ url: 'https://example.com', actions: [{ kind: 'wait', milliseconds: 99999 }] }));
});
let reads = 0;
class FixtureHttp extends SafeHttp {
  override async get(url: string, policy: WebPolicy = {}): Promise<WebResponse> {
    const parsed = webUrl(url, policy.origins); policy.signal?.throwIfAborted(); reads++;
    if (parsed.pathname === '/slow') { await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, 10000); policy.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Error('cancelled')); }, { once: true }); }); }
    if (parsed.pathname === '/jump') return { url, status: 302, headers: { 'content-type': 'text/html', location: 'https://other.example/destination' }, body: Buffer.alloc(0) };
    const html = `<html><head><title>动态测试</title></head><body><h1>公开公告</h1><button id="expand" onclick="document.querySelector('#details').textContent='已展开动态正文'">展开</button><p id="details">等待展开</p><input id="field" style="position:absolute;left:20px;top:100px"><button id="show" onclick="document.querySelector('#details').textContent=document.querySelector('#field').value">显示输入</button><form><button id="submit">提交</button></form><a href="https://other.example/next">下一页</a><div style="height:1800px">长页面</div><script>document.body.dataset.previous=localStorage.getItem('fixture')||'空';localStorage.setItem('fixture','已保存');document.body.append('上次状态：'+document.body.dataset.previous);setTimeout(()=>document.body.append('异步正文'),30);fetch('http://127.0.0.1/private').catch(()=>{});fetch('/write',{method:'POST',body:'x'}).catch(()=>{});</script></body></html>`;
    return { url, status: 200, headers: { 'content-type': 'text/html;charset=utf-8' }, body: Buffer.from(html) };
  }
}
const web = new WebTools(undefined, new FixtureHttp());
await check('网页工具必须经过外部授权；拒绝后不发请求', async () => {
  const before = reads;
  const model: ModelClient = { providerId: 'fixture', model: 'fixture', async *streamChat() { yield { type: 'tool_calls', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://fixture.example"}' } }] }; } };
  const result = await runAgentLoop({ client: model, tools: web.tools(async () => undefined), system: '', messages: [{ role: 'user', content: '读取网页' }], taskDir: '.', maxSteps: 1, requestAccess: async request => { assert.equal(request.external, true); assert.equal(request.tool, 'web_fetch'); return false; } });
  assert.equal(reads, before); assert.match(JSON.stringify(result.messages), /未获授权/);
});
if (process.argv.includes('--browser')) {
  const engine = new BrowserEngine(new FixtureHttp(), { executablePath: process.env.WORKPIVOT_TEST_CHROME || '/usr/bin/google-chrome' });
  const token = randomUUID(), service = browserService(token, engine);
  const server = service.app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await check('浏览器服务鉴权与输入边界', async () => {
      assert.equal((await fetch(base + '/v1/browse', { method: 'POST' })).status, 401);
      assert.equal((await fetch(base + '/v1/browse', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: '{"url":"http://127.0.0.1"}' })).status, 422);
    });
    await check('真实Chromium动态渲染、点击、滚动、截图及请求拦截', async () => {
      const result = await engine.browse(browseInput({ url: 'https://fixture.example', actions: [{ kind: 'click', selector: '#expand' }, { kind: 'scroll', pixels: 600 }, { kind: 'wait', milliseconds: 100 }], screenshot: true }));
      assert.match(result.text, /已展开动态正文/); assert.match(result.text, /异步正文/); assert(result.blockedRequests >= 2); assert.equal(Buffer.from(result.screenshot!, 'base64').subarray(0,8).toString('hex'), '89504e470d0a1a0a');
    });
    await check('上下文隔离及表单操作禁止', async () => {
      const input = browseInput({ url: 'https://fixture.example' });
      assert.match((await engine.browse(input)).text, /上次状态：空/); assert.match((await engine.browse(input)).text, /上次状态：空/);
      await assert.rejects(engine.browse(browseInput({ url: input.url, actions: [{ kind: 'click', selector: '#submit' }] })), /表单/);
    });
    await check('导航及子资源遵守来源白名单', async () => {
      await assert.rejects(engine.browse(browseInput({ url: 'https://fixture.example', actions: [{ kind: 'click', selector: 'a' }] }), { origins: ['https://fixture.example'] }));
    });
    await check('取消后释放浏览器资源，后续请求仍可执行', async () => {
      const controller = new AbortController(); const pending = engine.browse(browseInput({ url: 'https://fixture.example/slow' }), { signal: controller.signal }); setTimeout(() => controller.abort(), 100); await assert.rejects(pending, /取消/);
      assert.match((await engine.browse(browseInput({ url: 'https://fixture.example' }))).text, /公开公告/);
    });
    await check('用户输入与AI共享同页，前后导航及任务隔离', async () => {
      const id = 'a'.repeat(64), second = 'b'.repeat(64);
      const rpc = async (key: string, action?: Record<string, unknown>) => {const response=await fetch(base+'/v1/sessions/'+key,{method:action?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:action?JSON.stringify(action):undefined});const value=await response.json();assert(response.ok,JSON.stringify(value));return value;};
      await rpc(id,{kind:'navigate',url:'https://fixture.example'});
      await rpc(id,{kind:'click',x:50,y:110}); await rpc(id,{kind:'text',text:'用户接手内容'});
      const shared=new WebTools({url:base,token}).tools(async()=>undefined,undefined,id)[1]!;
      const result=JSON.parse(await shared.run({actions:[{kind:'click',selector:'#show'}]},{taskDir:'.'}));assert.match(result.text,/用户接手内容/);assert(result.fields.some((f:{value:string})=>f.value==='用户接手内容'));
      assert.equal((await rpc(second)).open,false);
      await rpc(id,{kind:'navigate',url:'https://other.example/next'});assert.equal((await rpc(id,{kind:'back'})).url,'https://fixture.example/');assert.equal((await rpc(id,{kind:'forward'})).url,'https://other.example/next');
      await rpc(id,{kind:'resize',width:600,height:700});assert.equal((await rpc(id)).width,600);
      await Promise.all([rpc(id),rpc(id,{kind:'scroll',pixels:10})]);
      await rpc(id,{kind:'close'});assert.equal((await rpc(id)).open,false);
    });
    await check('工具通过HTTP服务保存截图，结果不含base64', async () => {
      let saved = false;
      const tool = new WebTools({ url: base, token }).tools(async (name, data) => { assert.equal(name, '页面.png'); assert(data.length > 100); saved = true; return { name }; })[1]!;
      const result = await tool.run({ url: 'https://fixture.example', screenshotName: '页面.png' }, { taskDir: '.' });
      assert(saved); assert.doesNotMatch(result, /iVBOR/); assert.match(result, /页面.png/);
    });
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
if (process.argv.includes('--live')) {
  await check('真实公网WebFetch', async () => {
    // Fake-IP 网络下可仅在测试中用独立 DoH 解析；仍经过全部公网校验及固定地址连接。
    const http = process.env.WORKPIVOT_TEST_DOH === '1' ? new SafeHttp(async host => {
      const response = await fetch('https://cloudflare-dns.com/dns-query?type=A&name=' + encodeURIComponent(host), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('测试DoH解析失败');
      const result = await response.json() as { Answer?: { type: number; data: string }[] };
      return (result.Answer ?? []).filter(a => a.type === 1).map(a => ({ address: a.data, family: 4 }));
    }) : new SafeHttp();
    const result = responseContent(await http.get('https://example.com')); assert.match(result.title, /Example Domain/);
    await assert.rejects(http.get('https://example.com', { maxBytes: 10 }), /大小限制/);
  });
}
console.log(`Web tools: ${count} checks passed`);
