import { tenantId } from './tenants.js';
import { statSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { canonicalPath, pathWithin } from '@workpivot/shared/node';

/** Explicit deployment mappings only; never interpret a Windows path as a Linux relative path. */
export function resolveClientDirectory(directory: string, workspace: string, configuration = tenantId() === 'default' ? process.env['WORKPIVOT_CLIENT_DIRECTORIES'] : process.env['WORKPIVOT_CLIENT_DIRECTORIES_' + tenantId().toUpperCase().replaceAll('-', '_')]): string {
  if (!configuration) throw new Error('所选本机目录尚未连接到后台，请联系部署管理员配置目录挂载。');
  if (!/^[a-zA-Z]:[\\/]/.test(directory) || directory.includes('\0') || directory.slice(2).includes(':')) throw new Error('请选择本机磁盘上的文件夹。');
  const mappings: unknown = JSON.parse(configuration);
  if (!Array.isArray(mappings)) throw new Error('后台目录映射配置无效。');
  const local = win32.normalize(directory);
  for (const entry of mappings) {
    if (!entry || typeof entry !== 'object') continue;
    const { client, server } = entry as Record<string, unknown>;
    if (typeof client !== 'string' || typeof server !== 'string' || !win32.isAbsolute(client) || !posix.isAbsolute(server)) continue;
    const relative = win32.relative(client, local);
    if (relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) continue;
    const root = canonicalPath(server);
    const selected = canonicalPath(posix.join(root, ...relative.split('\\')));
    if (!pathWithin(root, workspace) || !pathWithin(selected, root)) throw new Error('所选目录超出了已连接的工作目录范围。');
    if (!statSync(selected).isDirectory()) throw new Error('所选目录在后台不可用。');
    return selected;
  }
  throw new Error('所选本机目录尚未连接到后台，请选择已配置的目录或联系部署管理员。');
}
