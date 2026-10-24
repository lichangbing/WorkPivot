/**
 * R007 建表脚本：创建 chat schema、运行角色与两张表。
 *
 * 与应用使用不同连接串：本脚本用管理员（schema owner）执行；
 * 运行时只用 WORKPIVOT_CHAT_DATABASE_URL 的受限角色，没有 DDL 权限。
 *
 * 用法：
 *   WORKPIVOT_CHAT_DATABASE_ADMIN_URL=postgres://... \
 *   WORKPIVOT_CHAT_ROLE_PASSWORD=*** \
 *   pnpm chat:install
 */
import { createRequire } from 'node:module';

// pg 是 server 包的依赖，从 server 的模块解析路径加载（根目录不做依赖提升）。
const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Pool } = require('pg') as typeof import('pg');

const adminUrl = process.env['WORKPIVOT_CHAT_DATABASE_ADMIN_URL'];
const rolePassword = process.env['WORKPIVOT_CHAT_ROLE_PASSWORD'];
const roleName = process.env['WORKPIVOT_CHAT_ROLE'] ?? 'workpivot_chat';

if (!adminUrl) throw new Error('需要 WORKPIVOT_CHAT_DATABASE_ADMIN_URL（schema owner 连接串）');
if (!rolePassword || rolePassword.length < 12) throw new Error('需要 WORKPIVOT_CHAT_ROLE_PASSWORD（至少 12 位）');
if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) throw new Error('WORKPIVOT_CHAT_ROLE 只能是小写字母、数字和下划线');

const pool = new Pool({ connectionString: adminUrl, max: 1 });
try {
  await pool.query('BEGIN');
  // 角色幂等创建；已存在时只更新密码，不改变其他属性。
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleName]);
  if (role.rowCount) {
    await pool.query(`ALTER ROLE ${roleName} WITH LOGIN PASSWORD '${rolePassword.replace(/'/g, "''")}'`);
  } else {
    await pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword.replace(/'/g, "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 20`);
  }

  await pool.query('CREATE SCHEMA IF NOT EXISTS chat');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat.tasks (
      id            text PRIMARY KEY,
      owner_user_id text,
      tenant_id     text,
      name          text NOT NULL,
      directory     text NOT NULL,
      status        text NOT NULL,
      stop_reason   text,
      project_id    text,
      temp          boolean NOT NULL DEFAULT false,
      last_seq      bigint NOT NULL DEFAULT 0,
      created_at    timestamptz NOT NULL,
      updated_at    timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS chat_tasks_owner ON chat.tasks(owner_user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS chat_tasks_project ON chat.tasks(project_id) WHERE project_id IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat.messages (
      id         uuid PRIMARY KEY,
      task_id    text NOT NULL REFERENCES chat.tasks(id) ON DELETE CASCADE,
      seq        bigint NOT NULL,
      kind       text NOT NULL CHECK (kind IN ('user_message','assistant_message','tool_use','tool_result','meta')),
      payload    jsonb NOT NULL,
      parent_id  uuid,
      created_at timestamptz NOT NULL,
      UNIQUE (task_id, seq)
    )`);
  await pool.query('CREATE INDEX IF NOT EXISTS chat_messages_task_seq ON chat.messages(task_id, seq)');

  // 运行时角色：只给 chat schema 的读写，不能建表、不能碰其他 schema。
  await pool.query(`REVOKE ALL ON SCHEMA chat FROM PUBLIC`);
  await pool.query(`GRANT USAGE ON SCHEMA chat TO ${roleName}`);
  await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA chat TO ${roleName}`);
  await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA chat GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${roleName}`);
  await pool.query('COMMIT');

  const check = await pool.query("SELECT to_regclass('chat.tasks') AS tasks, to_regclass('chat.messages') AS messages");
  console.log(JSON.stringify({ ok: true, schema: 'chat', role: roleName, ...check.rows[0] }));
} catch (error) {
  await pool.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
