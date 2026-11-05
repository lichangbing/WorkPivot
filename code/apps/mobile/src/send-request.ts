export interface PendingSend { content: string; id: string }

/**
 * 同一指纹必须复用请求标识；断线恢复后再次点击发送不会创建新的副作用。
 * 用户修改正文或资料范围后才获得新的请求标识。
 */
export function requestIdFor(
  pending: PendingSend | null,
  fingerprint: string,
  createId: () => string = () => crypto.randomUUID(),
): PendingSend {
  return pending?.content === fingerprint ? pending : { content: fingerprint, id: createId() };
}
