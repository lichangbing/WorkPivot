import { StreamIdleError, StreamInterruptedError } from '@workpivot/shared';

export type TransportState = 'connecting' | 'connected' | 'reconnecting';

/** 保留网络故障类型，供全局恢复提示与局部业务错误分流。 */
export class NetworkError extends Error {
  constructor(message = '无法连接服务器，请检查网络、地址及服务器的手机端访问配置', options?: ErrorOptions) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

export function isAuthenticationError(error: unknown): boolean {
  return errorStatus(error) === 401;
}

export function isTransientConnectionError(error: unknown): boolean {
  const status = errorStatus(error);
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return error instanceof NetworkError
    || error instanceof StreamInterruptedError
    || error instanceof StreamIdleError
    || error instanceof TypeError
    || /network error|failed to fetch|net::err_|network is unreachable|internet connection|connection reset|timed? ?out/.test(message)
    || status === 408 || status === 425 || status === 429
    || status === 502 || status === 503 || status === 504;
}

/**
 * 服务端约每 5 分钟主动结束订阅。已经稳定运行的断流按正常轮换处理，
 * 快速断流仍显示恢复状态，避免把网络切换伪装成正常断线。
 */
export function isRoutineStreamRotation(error: unknown, openedAt: number, now = Date.now(), stableAfterMs = 30_000): boolean {
  return error instanceof StreamInterruptedError && now - openedAt >= stableAfterMs;
}

/** 指数退避并加入抖动，避免网络恢复时大量轮询同时冲击服务端。 */
export function reconnectDelay(attempt: number, random = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt, 4));
  const base = Math.min(1000 * 2 ** exponent, 10_000);
  return Math.round(base * (0.8 + random() * 0.4));
}
