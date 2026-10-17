import { browserService } from '../packages/server/src/web/browser-service.js';
import { BrowserEngine } from '../packages/server/src/web/browser-engine.js';

const service = browserService(process.env.WORKPIVOT_BROWSER_TOKEN ?? '', new BrowserEngine(undefined, { executablePath: process.env.WORKPIVOT_BROWSER_EXECUTABLE_PATH }));
const port = Number(process.env.WORKPIVOT_BROWSER_PORT ?? 39991);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('浏览器服务端口无效');
const server = service.app.listen(port, process.env.WORKPIVOT_BROWSER_HOST ?? '127.0.0.1');
server.on('listening', () => console.log('Workpivot browser service ready'));
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  server.close(); await service.close(); server.closeAllConnections();
};
process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
