/**
 * 服务层（形态 A：与 Electron 主进程同进程挂载，T1-02 接入）。
 * 对前端只暴露 localhost HTTP/SSE；前端禁 import 本包（A01.3 拆分边界纪律）。
 */
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Express } from 'express';
import { createApp } from './app.js';
import { markRunningTasksInterrupted } from './tasks.js';
import { audit } from './audit.js';

export const SERVER_PORT_DEFAULT = 39800;

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

function listenOn(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(server);
    });
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('error', onError);
      reject(err);
    };
    server.on('error', onError);
  });
}

/** 端口从 WORKPIVOT_PORT 或默认值起尝试，被占用则向后顺延（最多 10 个）。 */
export async function startServer(opts: Parameters<typeof createApp>[0] & { port?: number } = {}): Promise<ServerHandle> {
  // T3-02/F04：上次进程中断遗留的 running 任务标记为「已中断」（断点续跑前置）
  const interrupted = markRunningTasksInterrupted();
  if (interrupted > 0) audit({ event: 'boot_scan', decision: 'interrupted', detail: `${interrupted} 个任务` });

  const envPort = process.env['WORKPIVOT_PORT'];
  const base = opts.port ?? (envPort !== undefined && envPort !== '' ? Number(envPort) : SERVER_PORT_DEFAULT);
  const app = createApp(opts);

  let lastErr: unknown;
  for (let offset = 0; offset < 10; offset++) {
    const port = base + offset;
    let server: Server;
    try {
      server = await listenOn(app, port);
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      continue;
    }
    return {
      port,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  throw lastErr;
}

export { setSecretBox, type SecretBox, type SecretEnvelope } from './secret.js';
export { createApp, type AppOptions } from './app.js';

// 直接执行本文件时自启服务（供冷杀恢复评测/独立运行使用）
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer()
    .then((handle) => {
      console.log(`[NODE] WorkPivot 服务层已启动 http://127.0.0.1:${handle.port}`);
    })
    .catch((err: unknown) => {
      console.error('[NODE] 服务层启动失败', err);
      process.exit(1);
    });
}
