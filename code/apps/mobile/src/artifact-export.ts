import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileViewer } from '@capacitor/file-viewer';
import { Share } from '@capacitor/share';
import { artifactBytes, safeArtifactName, type Artifact } from './artifact-data';
import type { MobileClient } from './client';

const cacheRoot = 'workpivot-exports';
let startup: Promise<void> | undefined;
export async function clearArtifactCache(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const directory = await Filesystem.readdir({ directory: Directory.Cache, path: '' });
  if (directory.files.some(file => file.name === cacheRoot)) await Filesystem.rmdir({ directory: Directory.Cache, path: cacheRoot, recursive: true });
}
export function initializeArtifactCache(): Promise<void> { return startup ??= clearArtifactCache(); }

export async function exportArtifact(client: MobileClient, taskId: string, artifact: Artifact, action: 'open' | 'share', signal: AbortSignal): Promise<void> {
  const combined = AbortSignal.any([signal, client.signal, AbortSignal.timeout(120000)]);
  const response = await client.response(`/api/tasks/${taskId}/file-versions/${artifact.id}`, { signal: combined }, 120000);
  const bytes = await artifactBytes(response, artifact, combined), name = safeArtifactName(artifact.name);
  combined.throwIfAborted();
  if (!Capacitor.isNativePlatform()) {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return;
  }
  // 随机目录隔离同名文件；只将本地文件 URI 交给系统，不传服务器地址或凭据。
  const directory = `${cacheRoot}/${crypto.randomUUID()}`, path = `${directory}/${name}`;
  let data = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) data += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  try {
    combined.throwIfAborted();
    const result = await Filesystem.writeFile({ directory: Directory.Cache, path, data: btoa(data), recursive: true });
    combined.throwIfAborted();
    if (action === 'share') await Share.share({ title: name, files: [result.uri], dialogTitle: '保存或分享产物' });
    else await FileViewer.openDocumentFromLocalPath({ path: result.uri });
    // 接收应用可能稍后才读文件，因此成功后不立即删除；下次启动或退出时清理。
  } catch (reason) {
    await Filesystem.rmdir({ directory: Directory.Cache, path: directory, recursive: true }).catch(() => undefined);
    if (combined.aborted) throw reason;
    throw new Error(action === 'open' ? '无法打开产物，请安装支持此格式的软件，或尝试保存/分享' : '未完成保存或分享，可重新尝试');
  }
}
