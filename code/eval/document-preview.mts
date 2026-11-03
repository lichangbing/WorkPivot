import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DocumentPreview } from '../packages/server/src/database/document-preview.js';
import type { FileRepository } from '../packages/server/src/database/files.js';

let calls = 0, requestBody: Record<string, unknown> | null = null;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
const worker = createServer((request, response) => {
  if (request.url !== '/v1/run') { response.writeHead(404); response.end(); return; }
  let raw = '';
  request.on('data', chunk => { raw += chunk.toString(); });
  request.on('end', () => {
    calls += 1;
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ files: [['preview.pdf', pdf.toString('base64')]], output: '' }));
  });
});
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
const address = worker.address();
if (!address || typeof address === 'string') throw Error('测试执行器没有监听端口');

const files = {
  async download() {
    return {
      version: { id: 'version-1', documentId: 'document-1', revision: 1, name: '报告.docx', size: 10, sha256: '' },
      data: Buffer.from('synthetic-docx'),
    };
  },
} as unknown as FileRepository;
const preview = new DocumentPreview(files, { url: `http://127.0.0.1:${address.port}`, token: 'test-token' });
try {
  const first = await preview.officePdf('owner', 'task', 'version-1');
  const second = await preview.officePdf('owner', 'task', 'version-1');
  assert.deepEqual(first, pdf);
  assert.deepEqual(second, pdf);
  assert.equal(calls, 1, '同一不可变版本应复用派生预览');
  assert.match(String(requestBody?.['command']), /--mode render/);
  const sentFiles = requestBody?.['files'] as Array<[string, string]>;
  const sentSkills = requestBody?.['skills'] as Array<[string, string]>;
  assert.equal(sentFiles[0]?.[0], 'source.docx');
  assert.equal(sentSkills[0]?.[0], 'office-preview/convert.py');
  console.log('文档预览检查通过：Office 经隔离执行器转 PDF，并缓存不可变版本。');
} finally {
  await new Promise<void>(resolve => worker.close(() => resolve()));
}
