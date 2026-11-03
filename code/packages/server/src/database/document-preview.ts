import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { RepositoryError } from './connection.js';
import type { FileRepository } from './files.js';
import { runSandbox } from './sandbox.js';
import type { WorkerConfiguration } from './skill-execution.js';

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const CACHE_ITEMS = 12;
const CACHE_BYTES = 64 * 1024 * 1024;
const converterUrl = new URL('../../skills/docx-report/scripts/convert.py', import.meta.url);

/**
 * Office 只读预览使用既有隔离执行器和 LibreOffice 转 PDF。
 * 预览缓存只保存派生 PDF，不改变不可变原件，也不参与知识入库。
 */
export class DocumentPreview {
  private converter: Promise<string> | null = null;
  private readonly cache = new Map<string, Buffer>();
  private cachedBytes = 0;

  constructor(
    private readonly files: FileRepository,
    private readonly worker?: WorkerConfiguration,
  ) {}

  private async converterProgram(): Promise<string> {
    this.converter ??= readFile(converterUrl, 'utf8');
    return this.converter;
  }

  private remember(versionId: string, data: Buffer): void {
    const previous = this.cache.get(versionId);
    if (previous) this.cachedBytes -= previous.length;
    this.cache.delete(versionId);
    this.cache.set(versionId, data);
    this.cachedBytes += data.length;
    while (this.cache.size > CACHE_ITEMS || this.cachedBytes > CACHE_BYTES) {
      const oldest = this.cache.entries().next().value as [string, Buffer] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cachedBytes -= oldest[1].length;
    }
  }

  async officePdf(actor: string, taskId: string, versionId: string, signal?: AbortSignal, downloaded?: { version: { name: string }; data: Buffer }): Promise<Buffer> {
    const cached = this.cache.get(versionId);
    if (cached) {
      this.remember(versionId, cached);
      return cached;
    }
    if (!this.worker) throw new RepositoryError(503, 'Office 预览转换服务尚未启用，可先下载文件');
    const source = downloaded ?? await this.files.download(actor, taskId, versionId);
    const extension = extname(source.version.name).toLowerCase();
    if (!OFFICE_EXTENSIONS.has(extension)) throw new RepositoryError(415, '此文件不需要 Office 转换');
    const result = await runSandbox(this.worker, {
      command: `python3 /skills/office-preview/convert.py --source /workspace/source${extension} --output /workspace/preview.pdf --mode render`,
      files: [[`source${extension}`, source.data.toString('base64')]],
      skills: [['office-preview/convert.py', Buffer.from(await this.converterProgram()).toString('base64')]],
    }, signal);
    const output = result.files.find(([name]) => name === 'preview.pdf');
    if (!output) throw new RepositoryError(502, 'Office 预览没有生成 PDF');
    const data = Buffer.from(output[1], 'base64');
    if (data.toString('base64') !== output[1] || data.length < 8 || data.length > 16 * 1024 * 1024 || data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new RepositoryError(502, 'Office 预览返回的 PDF 无效');
    }
    this.remember(versionId, data);
    return data;
  }
}
