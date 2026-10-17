import type { RequestHandler } from 'express';
import { audit } from './audit.js';

/** 只做短期请求限流，不持久锁定账号；仅信任 Express 配置的对端地址。 */
export function authThrottle(onThrottled: (ip: string) => void = (ip) => { audit({ event: 'auth_throttled', detail: ip }); }): RequestHandler {
  const counters = new Map<string, { count: number; expires: number }>();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of counters) if (value.expires <= now) counters.delete(key);
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase().slice(0, 200) : '';
    const keys: Array<[string, number]> = [[JSON.stringify([ip]), 60], [JSON.stringify([ip, username]), 10]];
    for (const [key, limit] of keys) {
      const bucket = counters.get(key);
      if (bucket && bucket.count >= limit) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.expires - now) / 1000))));
        onThrottled(ip);
        res.status(429).json({ error: '尝试次数过多，请一分钟后重试' });
        return;
      }
    }
    // 限流器满额时拒绝新身份直至现有桶过期，禁止通过淘汰记录绕过限制。
    if (counters.size >= 10000 && keys.some(([key]) => !counters.has(key))) { res.status(429).json({ error: '登录请求繁忙，请稍后重试' }); return; }
    for (const [key] of keys) {
      const bucket = counters.get(key) ?? { count: 0, expires: now + 60000 };
      bucket.count++; counters.set(key, bucket);
    }
    next();
  };
}
