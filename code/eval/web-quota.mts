import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RequestQuota } from '../packages/server/src/web/request-quota.js';
import { SafeHttp, type WebResponse } from '../packages/server/src/web/safe-http.js';
import { BrowserEngine } from '../packages/server/src/web/browser-engine.js';
import { browserService } from '../packages/server/src/web/browser-service.js';
import { WebTools } from '../packages/server/src/web/tools.js';
let checks = 0;
async function check(name: string, run: () => Promise<void>) { await run(); console.log('PASS', name); checks++; }
const signal = new AbortController().signal;
await check('总并发与同站点串行，冷却站点不阻塞其他站点', async () => {
  const quota = new RequestQuota(2, 0);
  const a = await quota.acquire('a', signal), b = await quota.acquire('b', signal);
  let secondA = false, cStarted = false;
  const nextA = quota.acquire('a', signal).then(release => { secondA = true; return release; });
  const nextC = quota.acquire('c', signal).then(release => { cStarted = true; return release; });
  await delay(5); assert.equal(secondA, false); assert.equal(cStarted, false);
  b(); (await nextC)(); assert.equal(secondA, false);
  a(); (await nextA)(); a();
  const again = await quota.acquire('a', signal); again();
});
await check('生产默认同站点请求至少间隔两秒', async () => {
  const quota = new RequestQuota(); const boot = performance.now();
  (await quota.acquire('site', signal))();
  assert.ok(performance.now() - boot >= 1990);
  const start = performance.now();
  (await quota.acquire('site', signal))();
  assert.ok(performance.now() - start >= 1990);
});
await check('等待取消不占用槽且队列有上限', async () => {
  const quota = new RequestQuota(1, 0, 1), release = await quota.acquire('a', signal);
  const controller = new AbortController();
  const pending = quota.acquire('b', controller.signal); const cancelled = assert.rejects(pending, /取消/);
  await assert.rejects(quota.acquire('c', signal), /已满/);
  controller.abort(); await cancelled; release(); (await quota.acquire('c', signal))();
  assert.throws(() => quota.acquire('a', AbortSignal.abort()));
});
const starts: { host: string; at: number }[] = [];
let active = 0, maximum = 0;
class FixtureHttp extends SafeHttp {
  override async once(url: URL, _address: unknown, signal: AbortSignal): Promise<WebResponse> {
    starts.push({ host: url.hostname, at: performance.now() }); active++; maximum = Math.max(maximum, active);
    try {
      await delay(url.pathname === '/slow' ? 10000 : 40, undefined, { signal });
      if(url.pathname==='/retry'&&starts.filter(item=>item.host===url.hostname).length===1)return {url:url.href,status:503,headers:{'retry-after':'0'},body:Buffer.alloc(0)};
      if(url.pathname==='/feed')return {url:url.href,status:200,headers:{'content-type':'application/atom+xml'},body:Buffer.from('<feed xmlns="http://www.w3.org/2005/Atom"><title>合成订阅</title><entry><id>urn:fixture</id><title>合成条目</title><link href="https://unapproved.example/article"/></entry></feed>')};
      if (url.pathname === '/failure') throw Error('合成连接失败');
      if (url.pathname === '/redirect') return { url: url.href, status: 302, headers: { location: 'https://other.example/result' }, body: Buffer.alloc(0) };
      return { url: url.href, status: 200, headers: { 'content-type': 'text/plain;charset=utf-8' }, body: Buffer.from('合成采集正文') };
    } finally { active--; }
  }
}
const http = new FixtureHttp(async () => [{ address: '8.8.8.8', family: 4 }], new RequestQuota(2, 70));
const engine = new BrowserEngine(http, { executablePath: process.env.WORKPIVOT_TEST_CHROME || '/usr/bin/google-chrome' });
const token = 'synthetic-quota-test-token-000000000000';
const service = browserService(token, engine), server = service.app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
const client = () => new WebTools({ url, token }).tools(async () => undefined)[0]!;
async function run(target: string, abort?: AbortSignal) { return JSON.parse(await client().run({ url: target }, { taskDir: '.', signal: abort })); }
try {
  await check('集中出口要求服务认证，拒绝旧域名权限和未授权完整地址', async () => {
    assert.equal((await fetch(url + '/v1/fetch', { method: 'POST' })).status, 401);
    for (const body of [{ url: 'https://a.example/', origins: [] }, { url: 'https://a.example/', urls: [] }]) {
      const response = await fetch(url + '/v1/fetch', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 422);
    }
    assert.equal(starts.length, 0);
  });
  await check('两个调用方与浏览器传输共享总并发和站点配额', async () => {
    const results = await Promise.all([run('https://a.example/1'), run('http://a.example/2'), run('https://b.example/1'), engine.fetch('https://c.example/', {})]);
    assert.equal(results[0].text, '合成采集正文'); assert.equal(maximum, 2);
    const a = starts.filter(item => item.host === 'a.example'); assert.equal(a.length, 2); assert.ok(a[1]!.at - a[0]!.at >= 65);
  });
  await check('普通跳转仅返回新地址；自动化逐跳核对完整地址', async () => {
    const before = starts.length;
    assert.equal((await run('https://redirect.example/redirect')).redirectUrl, 'https://other.example/result');
    assert.equal(starts.length, before + 1);
    const tool = new WebTools({ url, token }).tools(async () => undefined, ['https://redirect.example/redirect'])[0]!;
    await assert.rejects(tool.run({ url: 'https://redirect.example/redirect' }, { taskDir: '.' }), /未获授权/);
    assert.equal(starts.length, before + 2);
  });
  await check('上游失败释放资源，取消等待不会偷偷发出请求', async () => {
    await assert.rejects(run('https://failure.example/failure'), /合成连接失败/);
    const first = run('https://cancel.example/1');
    await delay(10);
    const controller = new AbortController(); const second = run('https://cancel.example/2', controller.signal);
    const cancelled = assert.rejects(second); await delay(10); controller.abort(); await cancelled; await first; await delay(100);
    assert.equal(starts.filter(item => item.host === 'cancel.example').length, 1);
    assert.equal((await run('https://cancel.example/3')).text, '合成采集正文');
  });
  await check('真实浏览器与HTTP共用配额，关闭页面取消传输', async () => {
    const results = await Promise.all([
      engine.browse({ url: 'https://browser.example/1', actions: [], screenshot: false }, { urls: ['https://browser.example/1'] }),
      run('https://browser.example/2'),
    ]);
    assert.match(results[0].text, /合成采集正文/);
    const site = starts.filter(item => item.host === 'browser.example');
    assert.equal(site.length, 2); assert.ok(site[1]!.at - site[0]!.at >= 65);
    const managed = await engine.openPage({ urls: ['https://closing.example/slow'] });
    const navigation = managed.page.goto('https://closing.example/slow');
    const rejected = assert.rejects(navigation);
    const deadline = Date.now() + 5000;
    while (!starts.some(item => item.host === 'closing.example') && Date.now() < deadline) await delay(10);
    assert.ok(starts.some(item => item.host === 'closing.example'));
    await managed.context.close(); await rejected;
    await delay(50); assert.equal(active, 0);
  });
  await check('集中自动化出口重试并返回次数，普通读取不重试',async()=>{
    const target='https://retry.example/retry';const tool=new WebTools({url,token}).tools(async()=>undefined,[target])[0]!;
    const result=JSON.parse(await tool.run({url:target},{taskDir:'.'}));assert.equal(result.retryCount,1);assert.equal(starts.filter(item=>item.host==='retry.example').length,2);
    await assert.rejects(run('https://no-retry.example/retry'),/HTTP 503/);assert.equal(starts.filter(item=>item.host==='no-retry.example').length,1);
  });
  await check('集中出口传递结构化订阅而不访问条目',async()=>{
    const before=starts.length,result=await run('https://feed.example/feed');assert.equal(result.feed.format,'atom');assert.equal(result.feed.entries[0].id,'urn:fixture');assert.equal(starts.length,before+1);
  });
  await check('集中出口原始存档仅显式请求时传回且不含响应头',async()=>{
    const target='https://original.example/feed',tool=new WebTools({url,token}).tools(async()=>undefined,[target],undefined,true)[0]!;
    const result=JSON.parse(await tool.run({url:target},{taskDir:'.'}));assert(Buffer.from(result.original.body,'base64').toString().includes('<feed'));assert.deepEqual(Object.keys(result.original).sort(),['body','mediaType']);
    assert.equal((await run(target)).original,undefined);
  });
  await check('关闭出口取消执行中和排队请求', async () => {
    const first = http.get('https://shutdown.example/1'), second = http.get('https://shutdown.example/2');
    const results = Promise.allSettled([first, second]); await delay(5); await service.close();
    assert.ok((await results).every(result => result.status === 'rejected'));
    await assert.rejects(http.get('https://shutdown.example/3'));
  });
} finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
await check('集中服务不可用时不回退本机直连', async () => {
  let direct = false;
  class ForbiddenHttp extends SafeHttp { override async get(): Promise<WebResponse> { direct = true; throw Error('不应调用'); } }
  const tool = new WebTools({ url, token }, new ForbiddenHttp()).tools(async () => undefined)[0]!;
  await assert.rejects(tool.run({ url: 'https://a.example/' }, { taskDir: '.' })); assert.equal(direct, false);
});
console.log(`网页配额 ${checks} 项通过`);
