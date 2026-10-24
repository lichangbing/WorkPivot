import { RepositoryError, uuid } from './connection.js';

/** 沙箱产物声明：只允许文件名，不允许目录；更新已有成果时绑定 documentId 与 revision。 */
export interface SandboxOutput { name: string; documentId?: string; revision?: number }

/**
 * 校验 1~10 个产物声明。规则由技能执行与通用代码执行共用，避免两套发布契约漂移。
 * 命令必须把文件写到 /workspace/<name>；这里不接受 /workspace/ 前缀或任何目录成分。
 */
export function parseSandboxOutputs(requested: unknown): SandboxOutput[] {
  if (!Array.isArray(requested) || !requested.length || requested.length > 10) throw new RepositoryError(400, '需要1至10个产物');
  const outputs = requested.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RepositoryError(400, '产物参数无效');
    const { name, documentId, revision } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f/\\:]/.test(name) || ['.', '..'].includes(name.trim())) throw new RepositoryError(400, '产物名称只填写文件名，例如 report.docx；不要填写 /workspace/ 路径。命令应将文件写入 /workspace/report.docx');
    if (documentId !== undefined) {
      if (typeof documentId !== 'string') throw new RepositoryError(400, '产物标识无效');
      uuid(documentId);
      if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new RepositoryError(400, '需要产物修订号');
    } else if (revision !== undefined) throw new RepositoryError(400, '缺少产物标识');
    return { name, documentId: documentId as string | undefined, revision: revision as number | undefined };
  });
  const ids = outputs.filter((output) => output.documentId).map((output) => output.documentId!.toLowerCase());
  if (new Set(outputs.map((output) => output.name)).size !== outputs.length || new Set(ids).size !== ids.length) throw new RepositoryError(400, '产物清单重复');
  return outputs;
}

/** 输入只接受当前运行已授权的文件版本 ID（list_uploaded_files 返回的 id，不是 documentId）。 */
export function parseSandboxInputs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10 || value.some((id) => typeof id !== 'string') || new Set(value).size !== value.length) throw new RepositoryError(400, '输入文件列表无效');
  for (const id of value) uuid(id);
  return value as string[];
}
