import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';

const DOCUMENT_TYPES = new Set(['.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.webp']);
export function artifactRequest(origin: string, taskId: string, name: string, token: string, version?: string): { url: string; filename: string } {
  if (version !== undefined && !/^[a-f0-9-]{36}$/.test(version)) throw new Error('产物版本无效');
  if (!/^https?:$/.test(new URL(origin).protocol) || !/^[a-zA-Z0-9_-]+$/.test(taskId) || typeof name !== 'string' || name.length > 1024 ||
      name.split(/[\\/]/).some((p) => !p || p === '.' || p === '..') || /[\x00-\x1f:]/.test(name) || typeof token !== 'string' || !/^[a-zA-Z0-9_.-]{1,256}$/.test(token)) throw new Error('产物请求无效');
  const filename = basename(name.replaceAll('\\', '/')).replace(/[<>"|?*]/g, '_');
  if (!DOCUMENT_TYPES.has(extname(filename).toLowerCase())) throw new Error('此文件类型不支持直接打开，请在浏览器中下载。');
  if (filename.length > 180 || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(filename)) throw new Error('文件名不支持在本机打开');
  return { url: new URL(`/api/tasks/${encodeURIComponent(taskId)}/artifact?name=${encodeURIComponent(name)}${version ? '&version=' + encodeURIComponent(version) : ''}`, origin).href, filename };
}
export async function downloadArtifact(origin: string, taskId: string, name: string, token: string, cache: string, version?: string): Promise<string> {
  const { url, filename } = artifactRequest(origin, taskId, name, token, version);
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error('产物下载失败，请检查登录和服务连接');
  const limit = 50 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('文件超过 50MB，请通过浏览器下载'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new Error('文件超过 50MB，请通过浏览器下载'); }
    chunks.push(value);
  }
  const scope = join(cache, createHash('sha256').update(origin + '\0' + token).digest('hex').slice(0, 24));
  mkdirSync(scope, { recursive: true });
  const path = join(mkdtempSync(join(scope, 'open-')), filename);
  writeFileSync(path, Buffer.concat(chunks), { flag: 'wx' });
  return path;
}
