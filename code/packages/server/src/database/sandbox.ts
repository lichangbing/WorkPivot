/**
 * 隔离执行服务（宿主 worker）的唯一客户端。
 *
 * 边界由 worker 侧强制：固定镜像、无网络、只读根文件系统、非 root、tmpfs /workspace、
 * 120 秒上限、2 并发、输入与产物合计 16MiB。这里只负责把命令和文件送进去、把结果取回来，
 * 不信任返回内容——调用方仍须按自己的产物契约逐项校验。
 */
import { RepositoryError } from './connection.js';

export interface SandboxRequest {
  command: string;
  /** 复制到 /workspace 的任务文件：[相对路径, base64] */
  files: Array<[string, string]>;
  /** 只读挂载到 /skills 的技能资源：[相对路径, base64] */
  skills: Array<[string, string]>;
}

export interface SandboxResult {
  /** worker 回传的 /workspace 全部文件：[相对路径, base64] */
  files: Array<[string, string]>;
  /** stdout + stderr，已在 worker 侧按 64KB 截断 */
  output: string;
}

/** 与 worker 的响应上限一致，避免不可信服务把结果读爆内存。 */
const RESPONSE_LIMIT = 24 * 1024 * 1024;

export async function runSandbox(config: { url: string; token: string }, request: SandboxRequest, signal?: AbortSignal): Promise<SandboxResult> {
  const response = await fetch(`${config.url.replace(/\/$/, '')}/v1/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(140000)]),
  });
  if (!response.body) throw new RepositoryError(502, '执行器未返回结果');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > RESPONSE_LIMIT) throw new RepositoryError(413, '执行输出过大');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { files?: unknown; output?: unknown; error?: unknown };
  if (!response.ok) {
    if (response.status === 429) throw new RepositoryError(429, '执行服务繁忙，请稍后重试；本次未发布产物');
    const detail = typeof result.error === 'string' ? result.error.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 3000) : '';
    throw new RepositoryError(502, `隔离执行失败，未发布产物${detail ? '：' + detail : ''}`);
  }
  if (!Array.isArray(result.files) || result.files.length > 4000) throw new RepositoryError(502, '执行输出格式无效');
  for (const entry of result.files) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') throw new RepositoryError(502, '执行输出格式无效');
  }
  return { files: result.files as Array<[string, string]>, output: typeof result.output === 'string' ? result.output : '' };
}
