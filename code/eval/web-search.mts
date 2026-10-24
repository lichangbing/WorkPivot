/**
 * web_search 离线检查：配置校验、请求拼装、结果归一化、错误映射。
 * 不联网：fetch 由测试注入。
 */
import assert from 'node:assert/strict';
import { createSearchTool, normalizeHits, searchConfiguration, type FetchLike } from '../packages/server/src/web/search.js';

let checks = 0;
async function check(label: string, run: () => Promise<void>): Promise<void> {
  try { await run(); checks += 1; console.log('ok', label); }
  catch (error) { console.error('FAIL', label, error instanceof Error ? error.message : error); throw error; }
}

type Call = { url: string; headers: Record<string, string> };
function fakeFetch(payload: unknown, status = 200) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return { ok: status >= 200 && status < 300, status, text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload) };
  };
  return { impl, calls };
}

const ctx = { taskDir: process.cwd() } as never;

await check('未配置时不存在搜索工具', async () => {
  const saved = { ...process.env };
  delete process.env['WORKPIVOT_SEARCH_PROVIDER'];
  delete process.env['WORKPIVOT_SEARCH_URL'];
  try {
    assert.equal(searchConfiguration(), undefined);
  } finally { process.env = saved; }
});

await check('配置缺失或非法时明确报错', async () => {
  const saved = { ...process.env };
  try {
    process.env['WORKPIVOT_SEARCH_PROVIDER'] = 'google';
    process.env['WORKPIVOT_SEARCH_URL'] = 'https://example.com';
    assert.throws(() => searchConfiguration(), /brave 或 searxng/);
    process.env['WORKPIVOT_SEARCH_PROVIDER'] = 'brave';
    delete process.env['WORKPIVOT_SEARCH_KEY'];
    assert.throws(() => searchConfiguration(), /WORKPIVOT_SEARCH_KEY/);
    process.env['WORKPIVOT_SEARCH_PROVIDER'] = 'searxng';
    process.env['WORKPIVOT_SEARCH_URL'] = 'https://user:pass@example.com';
    assert.throws(() => searchConfiguration(), /无凭据/);
  } finally { process.env = saved; }
});

await check('brave 请求带查询词、条数与令牌', async () => {
  const { impl, calls } = fakeFetch({ web: { results: [{ title: 'A', url: 'https://a.example/1', description: '摘要 A' }] } });
  const tool = createSearchTool({ provider: 'brave', url: 'https://api.search.brave.com', key: 'secret-token' }, impl);
  const result = JSON.parse(await tool.run({ query: '季度 报告 模板', count: 3 }, ctx));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].snippet, '摘要 A');
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), '季度 报告 模板');
  assert.equal(url.searchParams.get('count'), '3');
  assert.equal(calls[0]!.headers['x-subscription-token'], 'secret-token');
});

await check('searxng 使用 format=json 且不带令牌', async () => {
  const { impl, calls } = fakeFetch({ results: [{ title: 'B', url: 'https://b.example/2', content: '正文 B' }] });
  const tool = createSearchTool({ provider: 'searxng', url: 'http://searx.local:8080' }, impl);
  const result = JSON.parse(await tool.run({ query: 'test' }, ctx));
  assert.equal(result.results[0].snippet, '正文 B');
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(calls[0]!.headers['x-subscription-token'], undefined);
});

await check('结果归一化：丢弃非法链接、去重、按上限截断', async () => {
  const hits = normalizeHits('brave', {
    web: { results: [
      { title: 'ok', url: 'https://a.example/x', description: 'a' },
      { title: 'dup', url: 'https://a.example/x', description: 'a2' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { title: 'local', url: 'http://127.0.0.1/admin' },
      { title: '', url: 'https://b.example/y', description: 'b' },
    ] },
  }, 10);
  assert.equal(hits.length, 2);
  assert.equal(hits[1]!.title, 'https://b.example/y', '缺标题时用链接兜底');
  assert.ok(hits.every((hit) => hit.url.startsWith('https://')));
});

await check('条数越界时收敛到 1–10', async () => {
  const { impl, calls } = fakeFetch({ results: [] });
  const tool = createSearchTool({ provider: 'searxng', url: 'https://s.example' }, impl);
  await tool.run({ query: 'x', count: 99 }, ctx);
  assert.equal(new URL(calls[0]!.url).searchParams.get('count'), '10');
  await tool.run({ query: 'x', count: 0 }, ctx);
  assert.equal(new URL(calls[1]!.url).searchParams.get('count'), '1');
});

await check('空结果给出换词提示，错误状态可读', async () => {
  const empty = createSearchTool({ provider: 'searxng', url: 'https://s.example' }, fakeFetch({ results: [] }).impl);
  const payload = JSON.parse(await empty.run({ query: 'x' }, ctx));
  assert.equal(payload.results.length, 0);
  assert.match(payload.note, /换个说法/);
  const failing = createSearchTool({ provider: 'searxng', url: 'https://s.example' }, fakeFetch({ error: 'boom' }, 503).impl);
  await assert.rejects(() => failing.run({ query: 'x' }, ctx), /返回 503/);
});

await check('空查询与超长查询被拒绝', async () => {
  const tool = createSearchTool({ provider: 'searxng', url: 'https://s.example' }, fakeFetch({ results: [] }).impl);
  await assert.rejects(() => tool.run({ query: '   ' }, ctx), /查询词不能为空/);
  const json = JSON.parse(await tool.run({ query: 'x'.repeat(500) }, ctx));
  assert.equal(json.query.length, 200);
});

console.log(`web_search checks passed: ${checks}`);
