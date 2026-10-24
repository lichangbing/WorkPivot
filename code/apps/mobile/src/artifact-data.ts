export const maximumArtifactBytes = 10 * 1024 * 1024;
export interface Artifact { id: string; name: string; size: number; sha256: string }
export function safeArtifactName(name: string): string {
  const normalized = name.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_').replace(/[. ]+$/g, '');
  const suffix = /\.[a-z0-9]{1,12}$/i.exec(normalized)?.[0] ?? '';
  // 手机文件系统通常限制单段名称字节数；中文也按 UTF-8 字节计算，保留格式后缀。
  let stem = suffix ? normalized.slice(0, -suffix.length) : normalized;
  const encoder = new TextEncoder();
  while (encoder.encode(stem + suffix).length > 220) stem = Array.from(stem).slice(0, -1).join('');
  const clean = stem + suffix;
  if (!clean || clean === '.' || clean === '..') return '产物';
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? `_${clean}` : clean;
}
/** 即便后台未提供长度或连接中断，也不接受无限响应或不完整文件。 */
export async function artifactBytes(response: Response, artifact: Artifact, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0 || artifact.size > maximumArtifactBytes) throw new Error('产物大小无效或超过 10MB');
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) throw new Error('产物校验信息无效，请刷新列表');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('没有收到产物内容');
  let length = 0;
  const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > maximumArtifactBytes || length > artifact.size) throw new Error('产物大小与后台记录不一致');
      chunks.push(chunk.value);
    }
  } finally { signal.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (length !== artifact.size) throw new Error('产物下载不完整，请重试');
  const bytes = new Uint8Array(length);
  let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  signal.throwIfAborted();
  if (digest !== artifact.sha256.toLowerCase()) throw new Error('产物校验失败，请重新下载');
  return bytes;
}
