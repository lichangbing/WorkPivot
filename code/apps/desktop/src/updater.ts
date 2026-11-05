import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  API_PROTOCOL,
  parseClientUpdateEnvelope,
  selectClientUpdate,
  type ClientUpdateManifest,
} from '@workpivot/shared';

const MAX_UPDATE_BYTES = 500 * 1024 * 1024;

export async function fetchDesktopUpdate(server: string, currentBuild: number): Promise<ClientUpdateManifest | null> {
  const response = await fetch(`${server}/api/client-updates`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('更新清单不可用');
  return selectClientUpdate(parseClientUpdateEnvelope(await response.json()), {
    platform: 'windows',
    channel: 'beta',
    build: currentBuild,
    apiProtocol: API_PROTOCOL,
  });
}

export async function downloadDesktopUpdate(manifest: ClientUpdateManifest, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  const remoteName = decodeURIComponent(new URL(manifest.downloadUrl).pathname.split('/').at(-1) ?? '');
  if (!/^[A-Za-z0-9._-]+\.(exe|zip)$/i.test(remoteName)) throw new Error('Windows 更新文件名无效');
  const target = join(directory, remoteName);
  if (await matches(target, manifest.sha256)) return target;
  const partial = `${target}.part`;
  await rm(partial, { force: true });
  const response = await fetch(manifest.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error(`更新下载失败（${response.status}）`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_UPDATE_BYTES) throw new Error('更新包超过大小限制');
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    async function* (source: AsyncIterable<Uint8Array>) {
      let total = 0;
      for await (const chunk of source) {
        total += chunk.byteLength;
        if (total > MAX_UPDATE_BYTES) throw new Error('更新包超过大小限制');
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(partial, { mode: 0o600 }),
  );
  if (hash.digest('hex') !== manifest.sha256) {
    await rm(partial, { force: true });
    throw new Error('更新包摘要校验失败');
  }
  await rename(partial, target);
  return target;
}

async function matches(path: string, sha256: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_UPDATE_BYTES) return false;
    return createHash('sha256').update(await readFile(path)).digest('hex') === sha256;
  } catch { return false; }
}
