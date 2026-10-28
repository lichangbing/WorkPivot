import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { PoolClient } from 'pg';
import type { Tool } from '@workpivot/core';
import { RepositoryError } from './connection.js';
import type { FileRepository } from './files.js';
import { pdfInput } from '../web/browser-engine.js';
import type { PdfWorkspace } from '../web/pdf-workspace.js';

/** 从受控HTML直接生成PDF成果；正文不联网、不执行脚本，归档复用版本化文件链路。 */
export class PdfArtifactTools {
  constructor(
    private readonly files: FileRepository,
    private readonly pdf: PdfWorkspace,
    private readonly guard?: (c: PoolClient, args: Record<string, unknown>, taskId?: string) => Promise<void>,
  ) {}

  tools(actor: string, taskId: string): Tool[] {
    return [{
      name: 'create_pdf',
      kind: 'write',
      description: '从安全的HTML正文直接生成PDF成果并提供下载。适合报告、方案、分析等从零创建；不支持把上传的Word/Excel/PPT保留原版式转换，后一类应使用对应Office技能。bodyHtml使用h1-h3、p、ul/ol、table、blockquote、pre等语义标签，可用内联style和page-break/avoid-break类；禁止脚本、表单、iframe、外部资源与完整HTML文档标签。浏览器会关闭JavaScript并阻断所有网络请求。生成成功仅证明PDF结构有效，视觉版式仍须实际查看。修改已有PDF成果需传documentId和当前revision。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '不含目录的.pdf文件名' },
          title: { type: 'string', description: 'PDF文档标题，最多200字符' },
          bodyHtml: { type: 'string', description: '安全HTML正文片段，最大256KiB' },
          pageSize: { type: 'string', enum: ['A4', 'Letter', 'Legal'] },
          landscape: { type: 'boolean' },
          marginMm: { type: 'integer', minimum: 5, maximum: 40 },
          pageNumbers: { type: 'boolean' },
          documentId: { type: 'string', description: '更新已有PDF成果时提供' },
          revision: { type: 'integer', minimum: 1, description: '更新已有PDF成果时的当前版本号' },
        },
        required: ['name', 'title', 'bodyHtml'],
        additionalProperties: false,
      },
      run: async (args, ctx) => {
        ctx.signal?.throwIfAborted();
        const name = args.name;
        if (typeof name !== 'string' || !/^[^/\\\x00-\x1f]{1,180}\.pdf$/i.test(name) || extname(name).toLowerCase() !== '.pdf') throw new RepositoryError(400, 'PDF文件名必须为不含目录的.pdf文件');
        if (args.documentId !== undefined && typeof args.documentId !== 'string') throw new RepositoryError(400, 'PDF成果标识无效');
        if (args.documentId === undefined && args.revision !== undefined) throw new RepositoryError(400, '缺少PDF成果标识');
        const input = pdfInput(args);
        const rendered = await this.pdf.render(input, ctx.signal);
        ctx.signal?.throwIfAborted();
        const version = await this.files.upload(
          actor,
          taskId,
          name,
          rendered.data,
          randomUUID(),
          args.documentId as string | undefined,
          args.revision as number | undefined,
          'artifact',
          ctx.signal,
          this.guard ? c => this.guard!(c, args, taskId) : undefined,
        );
        return JSON.stringify({ ...version, pageCount: rendered.pageCount, render: 'passed', structure: 'passed', externalResources: 'blocked', visual: 'not-performed' });
      },
    }];
  }
}
