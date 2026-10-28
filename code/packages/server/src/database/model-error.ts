import { RepositoryError } from './connection.js';

/** 只公开可操作的错误分类，不回显上游正文、地址或凭据。 */
export function safeModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  // 本地额度拒绝使用固定中文提示，可安全原样返回；上游 HTTP 429 仍走脱敏分类。
  if (error instanceof RepositoryError && error.status === 429) return message;
  const status = /HTTP\s+(\d{3})\b/i.exec(message)?.[1];
  if (status === '401' || status === '403') return `模型服务认证失败（HTTP ${status}），请联系管理员检查模型凭据或权限`;
  if (status === '429') return '模型服务请求受限（HTTP 429），请稍后重试或联系管理员检查配额';
  if (status && Number(status) >= 500) return `模型服务暂时不可用（HTTP ${status}），请稍后重试`;
  if (status) return `模型服务拒绝了请求（HTTP ${status}），请联系管理员检查模型兼容性和配置`;
  if (error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out|超时/i.test(message))) return '模型请求超时，请稍后重试';
  if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(message))) return '模型请求已中止';
  if (/fetch failed|ECONN|ENOTFOUND|socket|terminated/i.test(message)) return '无法连接模型服务，请检查网络或稍后重试';
  return '模型请求失败，请联系管理员检查服务配置后重试';
}

/** 诊断信息有界，不保留供应商原文或请求数据。 */
export function modelFailureDetails(error: unknown) {
  const e = error instanceof Error ? error : undefined;
  const cause = e?.cause as { code?: unknown } | undefined;
  const code = typeof cause?.code === 'string' && ['ECONNRESET','ECONNREFUSED','ENOTFOUND','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(cause.code) ? cause.code : undefined;
  return { name: e && ['Error','TypeError','SyntaxError','AbortError','TimeoutError'].includes(e.name) ? e.name : 'unknown', code, status: /HTTP\s+(\d{3})\b/i.exec(e?.message ?? '')?.[1], category: safeModelError(error) };
}
