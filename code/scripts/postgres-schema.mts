import { pool, installSchema } from '../packages/server/src/database/connection.js';
const url = process.env['WORKPIVOT_DATABASE_ADMIN_URL'];
if (!url) throw Error('需要独立建表账号 WORKPIVOT_DATABASE_ADMIN_URL；不要使用线上旧数据环境');
const db = pool(url, { max: 1 });
try {
  await installSchema(db, process.env['WORKPIVOT_DATABASE_APP_ROLE'] ?? 'workpivot_app', process.env['WORKPIVOT_DATABASE_AUTH_ROLE'] ?? 'workpivot_auth');
  console.log('PostgreSQL schema v1 installed and verified; no legacy files imported');
} catch { console.error('数据库初始化失败；请核对空库、独立运行角色、已有结构版本及数据库管理员日志。连接凭据未输出。'); process.exitCode = 1; }
finally { await db.end(); }
