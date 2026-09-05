/**
 * 服务层（形态 A：与 Electron 主进程同进程挂载，T1-02 接入）。
 * 对前端只暴露 localhost HTTP/SSE；前端禁 import 本包（A01.3 拆分边界纪律）。
 */
import type { Server } from 'node:http';
import type { Express } from 'express';
import { createApp, type AppOptions } from './app.js';

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
export async function startServer(opts: AppOptions & { port?: number } = {}): Promise<ServerHandle> {
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

export { createApp, type AppOptions };
