import { RepositoryError } from '../database/connection.js';
import type { BrowserConfiguration } from './tools.js';
import type { PdfInput, PdfResult } from './browser-engine.js';

/** 浏览器渲染服务只接收受控HTML并返回PDF字节；业务归档仍由数据库文件仓库完成。 */
export class PdfWorkspace {
  constructor(private readonly config?: BrowserConfiguration) {}

  async render(input: PdfInput, signal?: AbortSignal): Promise<PdfResult> {
    if (!this.config) throw new RepositoryError(503, 'PDF生成需要浏览器服务');
    const response = await fetch(this.config.url + '/v1/pdf', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + this.config.token, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(40000), ...(signal ? [signal] : [])]),
    });
    if (!response.body) throw new RepositoryError(502, 'PDF服务响应为空');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 24 * 1024 * 1024) throw new RepositoryError(413, 'PDF服务返回内容过大');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { pdf?: unknown; pageCount?: unknown; error?: unknown };
    if (!response.ok) throw new RepositoryError(502, typeof result.error === 'string' ? result.error.slice(0, 300) : 'PDF生成失败');
    if (typeof result.pdf !== 'string' || typeof result.pageCount !== 'number' || !Number.isInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 100) throw new RepositoryError(502, 'PDF服务返回格式无效');
    const data = Buffer.from(result.pdf, 'base64');
    if (data.length < 8 || data.length > 16 * 1024 * 1024 || data.toString('base64') !== result.pdf || data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new RepositoryError(502, 'PDF服务返回文件无效');
    return { data, pageCount: result.pageCount };
  }
}
