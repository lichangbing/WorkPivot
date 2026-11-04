import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DocumentPreview, PreviewFailure } from '../packages/server/src/database/document-preview.js';
import type { FileRepository } from '../packages/server/src/database/files.js';

let calls = 0, requestBody: Record<string, unknown> | null = null, uploads = 0;
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
const fontPackHash = 'c'.repeat(64);
const worker = createServer((request, response) => {
  if (request.url !== '/v1/run') { response.writeHead(404); response.end(); return; }
  let raw = '';
  request.on('data', chunk => { raw += chunk.toString(); });
  request.on('end', () => {
    requestBody = JSON.parse(raw) as Record<string, unknown>;
    response.writeHead(200, { 'content-type': 'application/json' });
    if (String(requestBody?.['command']).includes('fc-list')) {
      response.end(JSON.stringify({ files: [], output: `${'c'.repeat(64)}  -\n` }));
      return;
    }
    calls += 1;
    response.end(JSON.stringify({
      files: [['preview.pdf', pdf.toString('base64')]],
      output: JSON.stringify({ fontPackHash, hasTextLayer: true }),
    }));
  });
});
await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
const address = worker.address();
if (!address || typeof address === 'string') throw Error('测试执行器没有监听端口');

let sourceSha = 'a'.repeat(64);
const files = {
  async download() {
    return {
      version: { id: 'version-1', documentId: 'document-1', revision: 1, name: '报告.docx', size: 10, sha256: sourceSha },
      data: Buffer.from('synthetic-docx'),
    };
  },
  async upload() {
    uploads += 1;
    throw Error('预览派生文件不得进入原件上传或读取链路');
  },
} as unknown as FileRepository;
const preview = new DocumentPreview(files, { url: `http://127.0.0.1:${address.port}`, token: 'test-token' });
try {
  const first = await preview.preview('owner', 'task', 'version-1');
  const second = await preview.preview('owner', 'task', 'version-1');
  assert.deepEqual(first.data, pdf);
  assert.deepEqual(second.data, pdf);
  assert.equal(first.derived, 'preview');
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(first.sourceSha256, 'a'.repeat(64));
  assert.equal(first.fontPackSha256, fontPackHash);
  assert.equal(first.hasTextLayer, true);
  assert.equal(first.stage, 'sandbox-libreoffice');
  assert.match(first.converterVersion, /^[a-f0-9]{64}$/);
  assert.match(first.pdfSha256, /^[a-f0-9]{64}$/);
  assert.ok(first.elapsedMs >= 0);
  assert.equal(calls, 1, '同一不可变版本应复用派生预览');
  assert.equal(uploads, 0, '派生预览不得被发布为原始文件');
  sourceSha = 'b'.repeat(64);
  const changedSource = await preview.preview('owner', 'task', 'version-1');
  assert.equal(changedSource.cached, false);
  assert.equal(changedSource.sourceSha256, sourceSha);
  assert.equal(calls, 2, '缓存 key 必须包含源文件哈希');
  assert.match(String(requestBody?.['command']), /--mode render/);
  const sentFiles = requestBody?.['files'] as Array<[string, string]>;
  const sentSkills = requestBody?.['skills'] as Array<[string, string]>;
  assert.equal(sentFiles[0]?.[0], 'source.docx');
  assert.equal(sentSkills[0]?.[0], 'office-preview/convert.py');
  const unavailable = new DocumentPreview(files);
  await assert.rejects(
    () => unavailable.preview('owner', 'task', 'version-1'),
    error => error instanceof PreviewFailure && error.code === 'PREVIEW_CAPABILITY_UNAVAILABLE' && error.status === 503,
  );
  console.log('文档预览检查通过：转换契约、源哈希缓存、派生隔离和能力错误分级。');
} finally {
  await new Promise<void>(resolve => worker.close(() => resolve()));
}
