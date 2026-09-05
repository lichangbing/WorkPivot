import express from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface AppOptions {
  /** 前端构建产物目录（apps/web/dist）。存在则托管静态资源并提供 SPA 回退。 */
  webDistDir?: string;
}

export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'workpivot', ts: Date.now() });
  });

  if (opts.webDistDir && existsSync(join(opts.webDistDir, 'index.html'))) {
    app.use(express.static(opts.webDistDir));
    // SPA 回退：非 /api 的 GET 一律回 index.html（Express 5 不再支持 '*' 通配路由）
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(opts.webDistDir as string, 'index.html'));
    });
  }

  return app;
}
