import { pool } from '../packages/server/src/database/connection.js';
import { createDatabaseApp } from '../packages/server/src/database/app.js';
if (process.env['WORKPIVOT_DATABASE_PREVIEW'] !== '1') throw Error('仅供独立数据库验收，需要 WORKPIVOT_DATABASE_PREVIEW=1');
const application = pool(process.env['WORKPIVOT_DATABASE_URL'] ?? '');
const identity = pool(process.env['WORKPIVOT_AUTH_DATABASE_URL'] ?? '');
const initToken = process.env['WORKPIVOT_ADMIN_INIT_TOKEN'] ?? '';
try {
  if (initToken.length < 24) throw Error('初始化凭据至少24字符');
  const port = Number(process.env['WORKPIVOT_DATABASE_PREVIEW_PORT'] ?? 39985);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('端口无效');
  const app = await createDatabaseApp(identity, application, initToken);
  const server = app.listen(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  console.log(`Database integration preview: http://127.0.0.1:${port}; not production ready`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return; closing = true;
    server.closeIdleConnections();
    const forced = setTimeout(() => server.closeAllConnections(), 5000); forced.unref();
    await new Promise<void>(resolve => server.close(() => resolve())); clearTimeout(forced);
    await Promise.all([application.end(), identity.end()]);
  };
  process.on('SIGINT', () => { void close(); }); process.on('SIGTERM', () => { void close(); });
} catch {
  console.error('数据库验证服务启动失败；请核对数据库配置、权限和初始化参数。未启动旧文件存储回退。');
  await Promise.all([application.end(), identity.end()]); process.exitCode = 1;
}
