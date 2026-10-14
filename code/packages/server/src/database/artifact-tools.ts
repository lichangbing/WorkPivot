import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import type { Tool } from '@workpivot/core';
import { RepositoryError } from './connection.js';
import { FileRepository } from './files.js';

/** Text deliverables use the same immutable original/version/deletion pipeline as uploads. */
export class DatabaseArtifactTools {
  constructor(private readonly files: FileRepository) {}
  async save(actor: string, taskId: string, args: Record<string, unknown>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { name, content, documentId, revision } = args;
    if (typeof name !== 'string' || !['.txt', '.md', '.csv', '.tsv', '.json'].includes(extname(name).toLowerCase()) || typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) throw new RepositoryError(400, '目前可保存1MB以内的TXT、Markdown、CSV、TSV或JSON成果');
    if (documentId !== undefined && typeof documentId !== 'string') throw new RepositoryError(400, '产物标识无效');
    if (documentId === undefined && revision !== undefined) throw new RepositoryError(400, '缺少产物标识');
    if (extname(name).toLowerCase() === '.json') { try { JSON.parse(content); } catch { throw new RepositoryError(400, 'JSON内容格式无效'); } }
    return this.files.upload(actor, taskId, name, Buffer.from(content), randomUUID(), documentId as string | undefined, revision as number | undefined, 'artifact', signal);
  }
  tools(actor: string, taskId: string): Tool[] {
    return [{ name: 'list_artifacts', kind: 'read', description: '列出当前任务成果及其最新版本，修改已有成果前先读取版本。', parameters: { type: 'object', properties: {}, additionalProperties: false }, run: async (_args, ctx) => { ctx.signal?.throwIfAborted(); return JSON.stringify(await this.files.list(actor, taskId, 'artifact')); } }, {
      name: 'save_artifact', kind: 'write', description: '将最终交付内容保存为TXT、Markdown、CSV、TSV或JSON文件，出现在产物清单。修改已有产物必须传documentId和revision；不能将文本伪装成Word/PDF/Excel。仅保存结果，不执行计算。',
      parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, documentId: { type: 'string' }, revision: { type: 'integer', minimum: 1 } }, required: ['name','content'], additionalProperties: false },
      run: async (args, ctx) => JSON.stringify(await this.save(actor, taskId, args, ctx.signal)),
    }];
  }
}
