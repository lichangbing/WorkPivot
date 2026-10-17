/** 仅提供桌面外壳；账号、模型调用和任务执行均位于远端服务器。 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray, shell } from 'electron';
import { downloadArtifact, artifactRequest } from './artifact.js';
import { ArtifactSync, fetchManifest } from './artifact-sync.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_SERVER_URL, normalizeServerUrl } from './server-address.js';
import { checkServiceHealth, CompatibilityError } from '@workpivot/shared';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let connectedOrigin: string | null = null;
let lastError = '';
let connecting = false;
const connectionPage = join(__dirname, 'connection.html');
const connectionPageUrl = pathToFileURL(connectionPage).href;
const smoke = process.env['WORKPIVOT_SMOKE'] === '1';

function log(message: string): void {
  const dir = app.getPath('userData'); mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'client.log'), `${new Date().toISOString()} ${message}\n`);
}
function configuredServer(): string {
  if (process.env['WORKPIVOT_SERVER_URL']) return normalizeServerUrl(process.env['WORKPIVOT_SERVER_URL']);
  try { return normalizeServerUrl(JSON.parse(readFileSync(join(app.getPath('userData'), 'connection.json'), 'utf8')).serverUrl); }
  catch { return DEFAULT_SERVER_URL; }
}
function saveServer(serverUrl: string): void {
  const path = join(app.getPath('userData'), 'connection.json');
  writeFileSync(path + '.tmp', JSON.stringify({ serverUrl }, null, 2)); renameSync(path + '.tmp', path);
}
async function showConnection(error = ''): Promise<void> {
  connectedOrigin = null; lastError = error;
  if (mainWindow && !mainWindow.isDestroyed()) { await mainWindow.loadFile(connectionPage); mainWindow.show(); }
}
async function connect(value: unknown): Promise<{ ok: boolean; error?: string }> {
  if (connecting) return { ok: false, error: '正在连接，请稍候' };
  connecting = true;
  try {
    const serverUrl = normalizeServerUrl(value);
    const response = await fetch(`${serverUrl}/api/health`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    const health = await response.json();
    if (!response.ok) throw new Error('服务器健康检查未通过');
    const service = checkServiceHealth(health);
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '窗口已关闭' };
    connectedOrigin = serverUrl;
    await mainWindow.loadURL(serverUrl);
    mainWindow.setTitle(`WorkPivot · 已连接 ${new URL(serverUrl).host} · ${service.version}`);
    saveServer(serverUrl); lastError = ''; mainWindow.show();
    log(`CONNECTED ${serverUrl}; local backend disabled`);
    if (smoke) { log('SMOKE OK'); setTimeout(() => app.exit(0), 300); }
    return { ok: true };
  } catch (error) {
    log(`CONNECTION FAILED: ${error instanceof Error ? error.message : 'unknown'}`);
    const message = error instanceof CompatibilityError ? error.message : '无法连接服务器。请确认服务器已启动，地址、端口和网络正确后重试。';
    await showConnection(message);
    if (smoke) { log('SMOKE OFFLINE'); setTimeout(() => app.exit(2), 300); }
    return { ok: false, error: message };
  } finally { connecting = false; }
}
function isConnectionPage(event: Electron.IpcMainInvokeEvent): boolean {
  return event.sender === mainWindow?.webContents && event.senderFrame === mainWindow.webContents.mainFrame && event.senderFrame.url === connectionPageUrl;
}
function createTray(): void {
  const png = join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'build'), 'icon.png');
  const icon = existsSync(png) ? nativeImage.createFromPath(png).resize({ width: 32, height: 32 }) : nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 128), { width: 32, height: 32 });
  tray = new Tray(icon); tray.setToolTip('WorkPivot');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 WorkPivot', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '服务器设置', click: () => { void showConnection(); } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
}
async function boot(): Promise<void> {
  log('CLIENT START; no local server, model keys or task runtime');
  mainWindow = new BrowserWindow({ width: 1440, height: 900, title: 'WorkPivot', show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: join(__dirname, 'preload.js') },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const permitted = (url: string): boolean => {
    try { return Boolean(connectedOrigin && new URL(url).origin === connectedOrigin); } catch { return false; }
  };
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!permitted(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-redirect', (event, url) => { if (!permitted(url)) event.preventDefault(); });
  mainWindow.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3 && !connecting && connectedOrigin) void showConnection('与服务器的连接已中断，请重新连接。');
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.on('close', (event) => { if (!quitting) { event.preventDefault(); mainWindow?.hide(); } });
  mainWindow.on('closed', () => { mainWindow = null; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '服务器', submenu: [{ label: '更换服务器', click: () => { void showConnection(); } }, { label: '重新连接', click: () => { void connect(configuredServer()); } }, { type: 'separator' }, { label: '退出', click: () => app.quit() }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
  ipcMain.handle('connection:show', async (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !permitted(event.senderFrame.url)) throw new Error('不允许此页面切换服务器');
    await showConnection();
  });
  ipcMain.handle('connection:settings', (event) => {
    if (!isConnectionPage(event)) throw new Error('不允许远程页面访问客户端设置');
    return { serverUrl: configuredServer(), error: lastError };
  });
  let selectingDirectory = false;
  let openingArtifact = false;
  const syncStore = new ArtifactSync(join(app.getPath('userData'), 'artifact-sync'));
  let syncBusy = false;
  let syncGeneration = 0;
  mainWindow.webContents.on('did-start-navigation', () => { syncGeneration++; });
  for (const action of ['status', 'configure', 'sync', 'folder', 'stop'] as const) ipcMain.handle(`workspace:sync-${action}`, async (event, token: string, enabled?: boolean) => {
    const window = mainWindow, origin = connectedOrigin;
    if (!window || !origin || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !permitted(event.senderFrame.url)) throw Error('不允许此页面访问成果同步');
    if (action === 'stop') { syncGeneration++; return; }
    if (syncBusy) throw Error('成果同步正在处理，请稍候');
    syncBusy = true;
    const generation = syncGeneration;
    const valid = () => generation === syncGeneration && origin === connectedOrigin && !window.isDestroyed() && permitted(window.webContents.getURL());
    try {
      const manifest = await fetchManifest(origin, token);
      if (!valid()) throw Error('连接已切换');
      const current = syncStore.status(origin, manifest.accountId);
      if (action === 'status') return current;
      if (action === 'configure') {
        if (enabled === false) return syncStore.configure(origin, manifest.accountId, current.directory, false);
        const result = await dialog.showOpenDialog(window, { title: '选择成果同步目录（过程材料不下载）', properties: ['openDirectory', 'createDirectory'] });
        if (!valid() || result.canceled || !result.filePaths[0]) return current;
        return syncStore.configure(origin, manifest.accountId, result.filePaths[0], true);
      }
      if (action === 'folder') { if (current.directory) { const error = await shell.openPath(current.directory); if (error) throw Error('本地成果目录不可打开'); } return current; }
      return await syncStore.sync(origin, token, manifest, valid);
    } finally { syncBusy = false; }
  });
  const openedArtifacts = new Map<string, string>();
  for (const action of ['open', 'show'] as const) ipcMain.handle(`workspace:${action}-artifact`, async (event, taskId: string, name: string, token: string, version?: string) => {
    const window = mainWindow;
    const origin = connectedOrigin;
    if (!window || !origin || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !permitted(event.senderFrame.url)) throw new Error('不允许此页面打开产物');
    if (openingArtifact) throw new Error('正在打开文件，请稍候');
    openingArtifact = true;
    try {
      artifactRequest(origin, taskId, name, token, version);
      const key = JSON.stringify([origin, token, taskId, name, version]);
      const cached = openedArtifacts.get(key);
      let synced: string | null = null;
      const manifest = await fetchManifest(origin, token);
      const delivery = manifest.files.find(f => f.taskId === taskId && f.name === name && (!version || f.version === version));
      if (delivery) synced = syncStore.localPath(origin, manifest.accountId, taskId, name, delivery.version);
      const path = synced ?? (action === 'show' && cached && existsSync(cached) ? cached : await downloadArtifact(origin, taskId, name, token, join(app.getPath('userData'), 'artifacts'), version ?? delivery?.version));
      openedArtifacts.set(key, path);
      if (window.isDestroyed() || origin !== connectedOrigin || !permitted(window.webContents.getURL())) throw new Error('服务器连接已切换，请重新打开');
      if (action === 'show') { shell.showItemInFolder(path); return; }
      const error = await shell.openPath(path);
      if (error) throw new Error('无法打开文件，请确认已安装对应的本地软件');
    } finally { openingArtifact = false; }
  });
  ipcMain.handle('workspace:select-directory', async (event) => {
    const window = mainWindow;
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !permitted(event.senderFrame.url)) throw new Error('不允许此页面选择本机目录');
    if (selectingDirectory) return null;
    selectingDirectory = true;
    const origin = connectedOrigin;
    try {
      const result = await dialog.showOpenDialog(window, { title: '选择项目工作目录', buttonLabel: '选择此文件夹', properties: ['openDirectory', 'createDirectory'] });
      if (window.isDestroyed() || connectedOrigin !== origin || !permitted(window.webContents.getURL())) return null;
      return result.canceled ? null : result.filePaths[0] ?? null;
    } finally { selectingDirectory = false; }
  });
  ipcMain.handle('connection:connect', (event, value: unknown) => {
    if (!isConnectionPage(event)) throw new Error('不允许远程页面修改服务器地址');
    return connect(value);
  });
  try { createTray(); } catch { log('Tray unavailable'); }
  await showConnection();
  await connect(configuredServer());
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.on('before-quit', () => { quitting = true; });
  app.whenReady().then(boot).catch((error: unknown) => { log(`Startup failed: ${String(error)}`); app.exit(1); });
}
