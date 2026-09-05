/**
 * Electron 主进程（形态 A）：窗口/托盘/更新 + 同进程挂载服务层。
 * 拆分边界纪律（A01.3）：渲染层只经 localhost HTTP/SSE 访问服务层。
 */
import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { createFileTagLogger } from '@workpivot/shared/node';
import { startServer } from '@workpivot/server';

const logger = createFileTagLogger('MAIN');
const SMOKE = process.env['WORKPIVOT_SMOKE'] === '1';
const bootAt = Date.now();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(boot).catch((err) => {
    logger.error('启动失败', err instanceof Error ? err.stack : String(err));
    app.quit();
  });
}

app.on('window-all-closed', () => app.quit());

async function boot(): Promise<void> {
  logger.info(`Electron 就绪（${Date.now() - bootAt}ms）`);

  // app.getAppPath() = 应用目录（dev 为 apps/desktop）→ 前端产物在 apps/web/dist
  const webDistDir = join(app.getAppPath(), '../web/dist');
  const server = await startServer({ webDistDir });
  logger.info(`服务层就绪 http://127.0.0.1:${server.port}（累计 ${Date.now() - bootAt}ms）`);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'WorkPivot',
    show: false,
  });
  await win.loadURL(`http://127.0.0.1:${server.port}`);
  win.show();
  logger.info(`页面加载完成（累计 ${Date.now() - bootAt}ms）——冷启动分段打点：Electron 就绪 / 服务层就绪 / 页面加载`);

  win.on('closed', () => {
    void server.close();
  });

  if (SMOKE) {
    logger.info('SMOKE OK——自动退出');
    setTimeout(() => app.quit(), 300);
  }
}
