import type { RequestHandler } from 'express';

/** 手机内置页面与 API 分离；部署方显式指定来源，不开放任意网页读取账号数据。 */
export function mobileCors(config = ''): RequestHandler {
  const allowed = new Set(config.split(',').map(value => value.trim()).filter(Boolean));
  for (const origin of allowed) {
    const url = new URL(origin);
    if (!['https:', 'http:', 'capacitor:'].includes(url.protocol) || origin !== `${url.protocol}//${url.host}` || !url.host || url.username || url.password) {
      throw new Error('WORKPIVOT_MOBILE_ORIGINS 必须为逗号分隔的完整来源，不可使用通配符或路径');
    }
  }
  return (req, res, next) => {
    res.vary('Origin');
    const origin = req.headers.origin;
    if (!origin || !allowed.has(origin)) { next(); return; }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,Last-Event-ID');
    // 只使用显式 Bearer 身份；不启用跨域 Cookie。
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  };
}
