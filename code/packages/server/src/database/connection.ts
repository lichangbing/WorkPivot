import pg from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import { createHash } from 'node:crypto';
import { schemaSql, schemaVersion, personalTables, schemaUpgrades, matchesV1Checksum } from './schema.js';

export class RepositoryError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function uuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new RepositoryError(400, '标识无效');
}
export function pool(connectionString: string, extra: PoolConfig = {}): pg.Pool {
  if (!connectionString) throw new Error('缺少数据库连接配置');
  const result = new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 15000, idle_in_transaction_session_timeout: 15000, ...extra });
  // 空闲连接错误日志不得记录连接串、SQL 参数或凭据。
  result.on('error', () => { console.error('PostgreSQL 空闲连接失效，将在下一次请求重新连接'); });
  return result;
}
export async function transaction<T>(db: pg.Pool, action: (client: PoolClient) => Promise<T>, actorId?: string, exclusive = false): Promise<T> {
  if (actorId !== undefined) uuid(actorId);
  const client = await db.connect(); let broken = false;
  try {
    await client.query('BEGIN');
    // 个人数据导出/清空独占，普通业务事务共享；统一锁顺序先用户再具体资源。
    if(actorId)await client.query(`SELECT ${exclusive?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,['personal-data:'+actorId]);
    await client.query("SELECT set_config('workpivot.user_id',$1,true)", [actorId ?? '']);
    const result = await action(client);
    await client.query('COMMIT'); return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('数据库角色名称无效');
  return '"' + value + '"';
}

/** 使用独立高权限连接，不由 HTTP 服务器自动调用。 */
export async function installSchema(db: pg.Pool, appRole: string, authRole: string): Promise<void> {
  const app = identifier(appRole), auth = identifier(authRole);
  if (appRole === authRole) throw new Error('身份与业务数据库角色必须分离');
  await transaction(db, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(937031)');
    for (const role of [appRole, authRole]) {
      const result = await client.query('SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=$1', [role]);
      if (result.rowCount !== 1 || result.rows[0].rolsuper || result.rows[0].rolbypassrls || result.rows[0].rolcreaterole) throw new Error('运行角色不存在或权限过高');
    }
    await client.query('CREATE SCHEMA IF NOT EXISTS workpivot_meta; REVOKE ALL ON SCHEMA workpivot_meta FROM PUBLIC');
    await client.query('CREATE TABLE IF NOT EXISTS workpivot_meta.schema_versions(version integer PRIMARY KEY, checksum text NOT NULL, app_role text NOT NULL, auth_role text NOT NULL, installed_at timestamptz NOT NULL DEFAULT now())');
    const checksum = createHash('sha256').update(schemaSql + personalTables.join(',')).digest('hex');
    const versions = await client.query('SELECT version,checksum,app_role,auth_role FROM workpivot_meta.schema_versions ORDER BY version');
    if (versions.rowCount) {
      if (versions.rowCount > schemaUpgrades.length + 1 || versions.rows[0].version !== schemaVersion || !matchesV1Checksum(versions.rows[0].checksum, checksum) || versions.rows.some(r => r.app_role !== appRole || r.auth_role !== authRole)) throw new Error('数据库结构版本、角色或校验不匹配');
    } else {
    await client.query(schemaSql);
    for (const table of personalTables) await client.query(`ALTER TABLE workpivot.${table} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE workpivot.${table} FORCE ROW LEVEL SECURITY;
      CREATE POLICY personal_scope ON workpivot.${table} USING(owner_user_id=workpivot.actor_id()) WITH CHECK(owner_user_id=workpivot.actor_id())`);
    await client.query(`GRANT USAGE ON SCHEMA identity TO ${auth}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA identity TO ${auth}; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA identity TO ${auth};
      GRANT USAGE ON SCHEMA workpivot TO ${app}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA workpivot TO ${app};
      REVOKE ALL ON FUNCTION workpivot.actor_id() FROM PUBLIC; GRANT EXECUTE ON FUNCTION workpivot.actor_id() TO ${app}`);
    await client.query('INSERT INTO workpivot_meta.schema_versions(version,checksum,app_role,auth_role) VALUES($1,$2,$3,$4)', [schemaVersion, checksum, appRole, authRole]);
    }
    for (const [index, upgrade] of schemaUpgrades.entries()) {
      const digest = createHash('sha256').update(upgrade.sql).digest('hex');
      const installed = versions.rows[index + 1];
      if (installed) {
        if (installed.version !== upgrade.version || installed.checksum !== digest) throw new Error('数据库升级校验不匹配');
      } else {
        await client.query(upgrade.sql);
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA workpivot TO ${app}`);
        await client.query('INSERT INTO workpivot_meta.schema_versions(version,checksum,app_role,auth_role) VALUES($1,$2,$3,$4)', [upgrade.version, digest, appRole, authRole]);
      }
    }
  });
}

export async function assertRestrictedRole(db: pg.Pool, schema: 'identity' | 'workpivot'): Promise<void> {
  const result = await db.query(`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,
    EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=$1 AND n.nspowner=r.oid) AS owns_schema,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relowner=r.oid) AS owns_table
    FROM pg_roles r WHERE r.rolname=current_user`, [schema]);
  const row = result.rows[0];
  if (!row || row.rolsuper || row.rolbypassrls || row.rolcreaterole || row.owns_schema || row.owns_table) throw new Error('拒绝使用高权限数据库运行账号');
  const foreign = schema === 'workpivot' ? ['identity', 'credentials'] : ['workpivot', 'projects'];
  const permissions = await db.query("SELECT has_table_privilege(current_user,c.oid,'SELECT') AS allowed FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2", foreign);
  if (permissions.rowCount !== 1) throw new Error('缺少数据库结构，请先安装');
  if (permissions.rows[0]?.allowed) throw new Error('身份与业务数据库权限未隔离');
  const memberships = await db.query(`SELECT 1 FROM pg_roles r WHERE r.rolname<>current_user
    AND pg_has_role(current_user,r.oid,'MEMBER') AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
    OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('identity','workpivot') AND n.nspowner=r.oid))`);
  if (memberships.rowCount) throw new Error('运行账号继承了高权限角色');
  if (schema === 'workpivot') {
    const unsafe = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='workpivot' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)");
    if (unsafe.rowCount) throw new Error('个人数据表缺少强制行级安全策略');
  }
}
