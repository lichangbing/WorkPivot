import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { FileRepository } from '../packages/server/src/database/files.js';
import { WorkspaceRepository } from '../packages/server/src/database/workspace.js';
import { DocumentPreview, PreviewFailure } from '../packages/server/src/database/document-preview.js';
import { transaction } from '../packages/server/src/database/connection.js';

export async function testDocumentPreviewMetadata(db: Pool, owner: string, check: (ok: unknown, name: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'workpivot-preview-'));
  const files = new FileRepository(db, root);
  const workspace = new WorkspaceRepository(db);
  const task = await workspace.createTask(owner, '文档预览元数据');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF', 'ascii');
  const fontPackHash = 'f'.repeat(64);
  let calls = 0;
  const worker = createServer((request, response) => {
    if (request.url !== '/v1/run') { response.writeHead(404); response.end(); return; }
    let raw = '';
    request.on('data', chunk => { raw += chunk.toString(); });
    request.on('end', () => {
      const payload = JSON.parse(raw) as { command?: string };
      if (payload.command?.includes('fc-list')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ files: [], output: `${fontPackHash}  -\n` }));
        return;
      }
      calls++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        files: [['preview.pdf', pdf.toString('base64')]],
        output: JSON.stringify({ fontPackHash, hasTextLayer: true }),
      }));
    });
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address();
  if (!address || typeof address === 'string') throw Error('测试执行器没有监听端口');
  try {
    const version = await files.upload(owner, task.id, '报告.docx', Buffer.from('synthetic-docx'), randomUUID());
    const preview = new DocumentPreview(files, { url: `http://127.0.0.1:${address.port}`, token: 'test-token' }, db);
    const first = await preview.preview(owner, task.id, version.id);
    const second = await preview.preview(owner, task.id, version.id);
    check(first.derived === 'preview' && !first.cached && second.cached && calls === 1, '预览契约标记来源并使用复合缓存');
    check(first.sourceSha256 === version.sha256 && first.fontPackSha256 === fontPackHash && first.hasTextLayer === true, '预览返回源哈希、字体包和文本层契约');
    const metadata = await transaction(db, c => c.query(`SELECT preview_sha256,preview_converter_version,preview_generated_at,
      preview_font_sha256,preview_has_text_layer FROM workpivot.document_versions WHERE id=$1`, [version.id]), owner);
    const row = metadata.rows[0];
    check(row.preview_sha256 === first.pdfSha256 && row.preview_converter_version === first.converterVersion &&
      row.preview_font_sha256 === fontPackHash && row.preview_has_text_layer === true && row.preview_generated_at,
    '派生预览元数据持久化到不可变文件版本');
    const count = await transaction(db, c => c.query('SELECT count(*)::int AS n FROM workpivot.document_versions WHERE document_id=$1', [version.documentId]), owner);
    check(count.rows[0].n === 1, '预览派生 PDF 不发布为新的原始文件版本');

    const zip = await files.upload(owner, task.id, '归档.zip', Buffer.from('zip'), randomUUID());
    await assert.rejects(
      () => preview.preview(owner, task.id, zip.id),
      error => error instanceof PreviewFailure && error.status === 415 && error.code === 'PREVIEW_UNSUPPORTED',
    );
    check(true, '不支持预览的格式返回稳定能力错误码');
  } finally {
    worker.closeAllConnections();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await workspace.deleteTask(owner, task.id, (await workspace.listTasks(owner)).find(item => item.id === task.id)!.revision);
    await files.collect(owner);
    await rm(root, { recursive: true, force: true });
  }
}
