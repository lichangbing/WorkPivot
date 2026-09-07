/**
 * Electron 主进程（形态 A）：窗口/托盘/更新 + 同进程挂载服务层。
 * 拆分边界纪律（A01.3）：渲染层只经 localhost HTTP/SSE 访问服务层。
 */
import { app, BrowserWindow, Menu, nativeImage, safeStorage, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { createFileTagLogger } from '@workpivot/shared/node';
import { setSecretBox, startServer, type ServerHandle } from '@workpivot/server';

const logger = createFileTagLogger('MAIN');
const SMOKE = process.env['WORKPIVOT_SMOKE'] === '1';
const bootAt = Date.now();

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let server: ServerHandle | null = null;
let quitting = false;

/** T1-07/I04：密钥经 OS 级加密（Windows DPAPI / macOS Keychain）。 */
function injectSecretBox(): void {
  setSecretBox({
    encrypt: (plain: string) => {
      if (safeStorage.isEncryptionAvailable()) {
        return { enc: 'safeStorage' as const, data: safeStorage.encryptString(plain).toString('base64') };
      }
      logger.warn('safeStorage 不可用，密钥回退 base64（仅限开发态）');
      return { enc: 'b64' as const, data: Buffer.from(plain, 'utf8').toString('base64') };
    },
    decrypt: (envelope) => {
      if (envelope.enc === 'safeStorage') return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
      return Buffer.from(envelope.data, 'base64').toString('utf8');
    },
  });
}

/** 托盘图标：优先用品牌 icon.png（打包态在 resources，开发态在 build/）；缺失回退程序化位图。 */
function createTrayIcon(): Electron.NativeImage {
  const resources = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const pngPath = app.isPackaged ? join(resources, 'icon.png') : join(resources, 'build', 'icon.png');
  if (existsSync(pngPath)) {
    const icon = nativeImage.createFromPath(pngPath).resize({ width: 32, height: 32 });
    if (!icon.isEmpty()) return icon;
  }
  const size = 32;
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = 0xaf; // B
    buffer[i * 4 + 1] = 0x40; // G
    buffer[i * 4 + 2] = 0x1e; // R
    buffer[i * 4 + 3] = 0xff; // A
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('WorkPivot');
  const menu = Menu.buildFromTemplate([
    {
      label: '打开 WorkPivot',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.whenReady().then(boot).catch((err: unknown) => {
    logger.error('启动失败', err instanceof Error ? err.stack : String(err));
    app.quit();
  });
}

app.on('window-all-closed', () => {
  // 关闭到托盘（A01.4）：窗口全关不退出；从托盘菜单退出
  if (quitting) app.quit();
});

async function boot(): Promise<void> {
  logger.info(`Electron 就绪（${Date.now() - bootAt}ms）`);
  injectSecretBox();

  // 宿主注入：内置技能根 + bash 的 NODE_PATH。
  // 开发态：appRoot=apps/desktop → 反推 code/ 内的 packages/server；
  // 打包态（M4）：electron-builder extraResources 平铺在 process.resourcesPath 下。
  const resources = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const builtinSkills = app.isPackaged
    ? join(resources, 'skills')
    : join(resources, '..', '..', 'packages', 'server', 'skills');
  if (existsSync(builtinSkills)) process.env['WORKPIVOT_BUILTIN_SKILLS'] = builtinSkills;
  const nmDirs = app.isPackaged
    ? [join(resources, 'server-node_modules')]
    : [join(resources, '..', '..', 'packages', 'server', 'node_modules'), join(resources, '..', '..', 'node_modules')];
  const nodePath = nmDirs.filter(existsSync).join(delimiter);
  if (nodePath !== '') process.env['WORKPIVOT_NODE_PATH'] = nodePath;
  logger.info(`宿主注入:skills=${existsSync(builtinSkills) ? 'ok' : 'missing'},NODE_PATH=${nodePath !== '' ? 'ok' : 'empty'}`);

  const webDistDir = app.isPackaged
    ? join(process.resourcesPath, 'app-web-dist')
    : join(app.getAppPath(), '../web/dist');
  server = await startServer({ webDistDir });
  logger.info(`服务层就绪 http://127.0.0.1:${server.port}（累计 ${Date.now() - bootAt}ms）`);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'WorkPivot',
    show: false,
  });
  mainWindow = win;
  await win.loadURL(`http://127.0.0.1:${server.port}`);
  win.show();
  logger.info(`页面加载完成（累计 ${Date.now() - bootAt}ms）——冷启动分段打点：Electron 就绪 / 服务层就绪 / 页面加载`);

  // A01.4：关闭最小化到托盘（M0 默认开启；可配置项随后续设置页提供）
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    mainWindow = null;
    void server?.close();
  });

  // A01.4：托盘是装饰性能力，失败不阻塞启动
  try {
    createTray();
  } catch (err) {
    logger.error('托盘创建失败（不影响其他功能）', err instanceof Error ? err.message : String(err));
  }

  if (SMOKE) {
    logger.info('SMOKE OK——自动退出');
    setTimeout(() => {
      quitting = true;
      app.quit();
    }, 300);
  }
}
