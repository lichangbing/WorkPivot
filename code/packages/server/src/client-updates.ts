import { readFile } from 'node:fs/promises';
import { parseClientUpdateEnvelope, type ClientUpdateEnvelope } from '@workpivot/shared';

const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * 更新清单由部署配置提供，可替换文件或关闭开关而不重新构建镜像。
 * 清单不包含凭据，下载地址和摘要仍会经过共享严格校验。
 */
export async function loadClientUpdates(now = new Date()): Promise<ClientUpdateEnvelope> {
  if (process.env['WORKPIVOT_UPDATE_ENABLED'] === '0') return { generatedAt: now.toISOString(), updates: [] };
  const configured = process.env['WORKPIVOT_UPDATE_MANIFEST']?.trim();
  if (!configured) return { generatedAt: now.toISOString(), updates: [] };
  let raw = configured;
  if (!configured.startsWith('{')) {
    const data = await readFile(configured);
    if (data.length > MAX_MANIFEST_BYTES) throw new Error('更新清单超过大小限制');
    raw = data.toString('utf8');
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('更新清单超过大小限制');
  const envelope = parseClientUpdateEnvelope(JSON.parse(raw) as unknown);
  return {
    generatedAt: envelope.generatedAt,
    updates: envelope.updates.filter(update => Date.parse(update.publishedAt) <= now.getTime()),
  };
}
