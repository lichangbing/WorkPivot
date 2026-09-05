/** 复现「直接保存没反应」：模拟前端完全相同的请求。运行：pnpm tsx scripts/repro-provider.mts */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['WORKPIVOT_HOME'] = mkdtempSync(join(tmpdir(), 'wp-repro-'));
const { startServer } = await import('../packages/server/src/index.js');

const server = await startServer({ port: 39880 });
const base = `http://127.0.0.1:${server.port}`;

// 与前端 api.saveProvider 完全一致的请求
const response = await fetch(`${base}/api/providers`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-v4-flash',
    apiKey: 'sk-test-fake-key-123',
    verify: false,
  }),
});
console.log('POST /api/providers →', response.status, response.headers.get('content-type'));
console.log('响应体:', await response.text());

const list = await fetch(`${base}/api/providers`);
console.log('GET /api/providers →', list.status);
console.log('列表:', await list.text());

await server.close();
process.exit(0);
