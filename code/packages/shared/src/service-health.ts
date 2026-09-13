export const SERVICE_VERSION = '0.3.0-preview.33';
export const API_PROTOCOL = 1;

export class CompatibilityError extends Error {}
export function checkServiceHealth(value: unknown): { version: string; legacy: boolean } {
  if (!value || typeof value !== 'object' || !('ok' in value) || value.ok !== true || !('name' in value) || value.name !== 'workpivot') throw new CompatibilityError('该地址未提供可用的 WorkPivot 服务');
  const data = value as Record<string, unknown>;
  if (data['apiProtocol'] !== undefined && data['apiProtocol'] !== API_PROTOCOL) throw new CompatibilityError('客户端与后台版本不兼容，请更新客户端或联系管理员');
  return { version: typeof data['version'] === 'string' ? data['version'] : '旧版后台', legacy: data['apiProtocol'] === undefined };
}
