import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Pool } from 'pg';
import { RepositoryError, transaction } from './connection.js';
import type { FileRepository } from './files.js';
import { runSandbox } from './sandbox.js';
import type { WorkerConfiguration } from './skill-execution.js';

const OFFICE_EXTENSIONS = new Set(['.docx', '.xlsx', '.pptx']);
const CACHE_ITEMS = 12;
const CACHE_BYTES = 64 * 1024 * 1024;
const converterUrl = new URL('../../skills/docx-report/scripts/convert.py', import.meta.url);

export type PreviewErrorCode =
  | 'PREVIEW_UNSUPPORTED'
  | 'PREVIEW_CAPABILITY_UNAVAILABLE'
  | 'PREVIEW_BUSY'
  | 'PREVIEW_TIMEOUT'
  | 'PREVIEW_SYSTEM_FAILURE';

export class PreviewFailure extends RepositoryError {
  constructor(status: number, message: string, code: PreviewErrorCode) {
    super(status, message, code);
  }
}

/** 派生 PDF 只用于界面展示；不写入文件卷，也不进入解析、读取或知识入库链路。 */
export interface PreviewMetadata {
  sourceSha256: string;
  pdfSha256: string;
  converterVersion: string;
  stage: 'sandbox-libreoffice';
  elapsedMs: number;
  generatedAt: string;
  fontPackSha256: string;
  hasTextLayer: boolean;
}

export interface PreviewArtifact extends PreviewMetadata {
  derived: 'preview';
  cached: boolean;
  cacheKey: string;
  data: Buffer;
}

interface ConverterContract {
  fontPackHash?: unknown;
  hasTextLayer?: unknown;
}

function converterContract(output: string): ConverterContract {
  for (const line of output.split(/\r?\n/).reverse()) {
    const value = line.trim();
    if (!value.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as ConverterContract;
    } catch {
      // 继续查找最后一行结构化契约，忽略 LibreOffice 的普通诊断输出。
    }
  }
  return {};
}

/**
 * Office 只读预览使用既有隔离执行器和 LibreOffice 转 PDF。
 * 内存缓存 key 绑定不可变版本、源文件哈希和转换器版本；数据库中只记录派生元数据。
 */
export class DocumentPreview {
  private converter: Promise<{ program: string; version: string }> | null = null;
  private fontPack: Promise<string> | null = null;
  private readonly cache = new Map<string, PreviewArtifact>();
  private cachedBytes = 0;

  constructor(
    private readonly files: FileRepository,
    private readonly worker?: WorkerConfiguration,
    private readonly db?: Pool,
  ) {}

  private async converterArtifact(): Promise<{ program: string; version: string }> {
    this.converter ??= readFile(converterUrl, 'utf8').then(program => ({
      program,
      version: createHash('sha256').update('office-preview-v2-sandbox-libreoffice\n').update(program).digest('hex'),
    }));
    return this.converter;
  }

  private async fontPackHash(): Promise<string> {
    if (!this.worker) throw new PreviewFailure(503, 'Office 预览转换服务尚未启用，可先下载文件', 'PREVIEW_CAPABILITY_UNAVAILABLE');
    this.fontPack ??= runSandbox(this.worker, {
      command: `python3 -c "import hashlib,subprocess; print(hashlib.sha256(subprocess.run(['fc-list',':','family'],capture_output=True,text=True,check=True).stdout.casefold().encode('utf-8')).hexdigest())"`,
      files: [],
      skills: [],
    }).then(result => {
      const match = result.output.match(/\b[a-f0-9]{64}\b/);
      if (!match) throw new PreviewFailure(502, '无法读取预览执行器字体包指纹', 'PREVIEW_SYSTEM_FAILURE');
      return match[0]!;
    }).catch(error => {
      this.fontPack = null;
      if (error instanceof PreviewFailure) throw error;
      if (error instanceof RepositoryError && error.status === 429) throw new PreviewFailure(429, error.message, 'PREVIEW_BUSY');
      throw new PreviewFailure(502, '无法读取预览执行器字体包指纹', 'PREVIEW_SYSTEM_FAILURE');
    });
    return this.fontPack;
  }

  private remember(key: string, artifact: PreviewArtifact): void {
    const previous = this.cache.get(key);
    if (previous) this.cachedBytes -= previous.data.length;
    this.cache.delete(key);
    this.cache.set(key, artifact);
    this.cachedBytes += artifact.data.length;
    while (this.cache.size > CACHE_ITEMS || this.cachedBytes > CACHE_BYTES) {
      const oldest = this.cache.entries().next().value as [string, PreviewArtifact] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cachedBytes -= oldest[1].data.length;
    }
  }

  private async persist(actor: string, versionId: string, metadata: PreviewMetadata): Promise<void> {
    if (!this.db) return;
    await transaction(this.db, async c => {
      const updated = await c.query(`UPDATE workpivot.document_versions
        SET preview_sha256=$3,preview_converter_version=$4,preview_generated_at=$5,
            preview_font_sha256=$6,preview_has_text_layer=$7
        WHERE id=$1 AND owner_user_id=$2`, [
        versionId, actor, metadata.pdfSha256, metadata.converterVersion,
        metadata.generatedAt, metadata.fontPackSha256, metadata.hasTextLayer,
      ]);
      if (!updated.rowCount) throw new PreviewFailure(404, '文件版本不存在或无权记录预览元数据', 'PREVIEW_SYSTEM_FAILURE');
    }, actor);
  }

  async preview(
    actor: string,
    taskId: string,
    versionId: string,
    signal?: AbortSignal,
    downloaded?: { version: { name: string; sha256: string }; data: Buffer },
  ): Promise<PreviewArtifact> {
    const source = downloaded ?? await this.files.download(actor, taskId, versionId);
    const extension = extname(source.version.name).toLowerCase();
    if (!OFFICE_EXTENSIONS.has(extension)) throw new PreviewFailure(415, '此文件不需要 Office 转换', 'PREVIEW_UNSUPPORTED');
    if (!this.worker) throw new PreviewFailure(503, 'Office 预览转换服务尚未启用，可先下载文件', 'PREVIEW_CAPABILITY_UNAVAILABLE');
    const [converter, fontPackSha256] = await Promise.all([this.converterArtifact(), this.fontPackHash()]);
    const sourceSha256 = source.version.sha256 || createHash('sha256').update(source.data).digest('hex');
    const cacheKey = `${versionId}:${sourceSha256}:${converter.version}:${fontPackSha256}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.remember(cacheKey, cached);
      return { ...cached, cached: true };
    }

    const started = performance.now();
    let result: Awaited<ReturnType<typeof runSandbox>>;
    try {
      result = await runSandbox(this.worker, {
        command: `python3 /skills/office-preview/convert.py --source /workspace/source${extension} --output /workspace/preview.pdf --mode render`,
        files: [[`source${extension}`, source.data.toString('base64')]],
        skills: [['office-preview/convert.py', Buffer.from(converter.program).toString('base64')]],
      }, signal);
    } catch (error) {
      if (error instanceof RepositoryError) {
        if (error.status === 429) throw new PreviewFailure(429, error.message, 'PREVIEW_BUSY');
        if (error.status === 408) throw new PreviewFailure(408, 'Office 预览转换超时，请稍后重试', 'PREVIEW_TIMEOUT');
      }
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new PreviewFailure(408, 'Office 预览转换超时，请稍后重试', 'PREVIEW_TIMEOUT');
      }
      throw new PreviewFailure(502, error instanceof RepositoryError ? error.message : 'Office 预览转换失败，请稍后重试', 'PREVIEW_SYSTEM_FAILURE');
    }
    const output = result.files.find(([name]) => name === 'preview.pdf');
    if (!output) throw new PreviewFailure(502, 'Office 预览没有生成 PDF', 'PREVIEW_SYSTEM_FAILURE');
    const data = Buffer.from(output[1], 'base64');
    if (data.toString('base64') !== output[1] || data.length < 8 || data.length > 16 * 1024 * 1024 || data.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new PreviewFailure(502, 'Office 预览返回的 PDF 无效', 'PREVIEW_SYSTEM_FAILURE');
    }
    const contract = converterContract(result.output);
    if (typeof contract.fontPackHash !== 'string' || !/^[a-f0-9]{64}$/.test(contract.fontPackHash) || typeof contract.hasTextLayer !== 'boolean') {
      throw new PreviewFailure(502, 'Office 预览缺少字体包或文本层契约，请升级执行器', 'PREVIEW_SYSTEM_FAILURE');
    }
    if (contract.fontPackHash !== fontPackSha256) {
      throw new PreviewFailure(502, '预览执行器字体包在转换期间发生变化，请重试', 'PREVIEW_SYSTEM_FAILURE');
    }
    const elapsedMs = Math.max(0, Math.round(performance.now() - started));
    const artifact: PreviewArtifact = {
      derived: 'preview',
      cached: false,
      cacheKey,
      data,
      sourceSha256,
      pdfSha256: createHash('sha256').update(data).digest('hex'),
      converterVersion: converter.version,
      stage: 'sandbox-libreoffice',
      elapsedMs,
      generatedAt: new Date().toISOString(),
      fontPackSha256,
      hasTextLayer: contract.hasTextLayer,
    };
    this.remember(cacheKey, artifact);
    await this.persist(actor, versionId, artifact);
    return artifact;
  }
}
