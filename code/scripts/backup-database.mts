import { BackupError } from './backup-error.mjs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pool } from '../packages/server/src/database/connection.js';
import { schemaSql, personalTables, schemaVersion, schemaUpgrades, matchesV1Checksum } from '../packages/server/src/database/schema.js';
import type { BackupEntry } from './backup-lib.mjs';
import { exportRetention, applyRetention, type RetentionState } from '../packages/server/src/database/restore-retention.js';

export const latestBackupSchema = schemaUpgrades.at(-1)?.version ?? schemaVersion;

export async function inspectDatabase(url: string, files?: BackupEntry[]) {
  const db = pool(url, { max: 1 });
  try {
    const versions = (await db.query('SELECT version,checksum,app_role,auth_role FROM workpivot_meta.schema_versions ORDER BY version')).rows;
    const expected = [{ version: schemaVersion, sql: schemaSql + personalTables.join(',') }, ...schemaUpgrades];
    if (versions.length !== expected.length || versions.some((row, i) => {
      const current = createHash('sha256').update(expected[i]!.sql).digest('hex');
      return row.version !== expected[i]?.version || !(i === 0 ? matchesV1Checksum(row.checksum, current) : row.checksum === current);
    })) throw new BackupError('数据库 schema 校验与当前程序不匹配');
    const { app_role: appRole, auth_role: authRole } = versions[0];
    if (versions.some(v => v.app_role !== appRole || v.auth_role !== authRole)) throw new BackupError('数据库运行角色记录不一致');
    for (const [role, schema, foreign] of [[appRole, 'workpivot', 'identity.credentials'], [authRole, 'identity', 'workpivot.projects']]) {
      const row = (await db.query(`SELECT rolsuper,rolbypassrls,rolcreaterole,
        has_schema_privilege(rolname,$2,'USAGE') AS access,
        has_table_privilege(rolname,$3,'SELECT') AS foreign_access
        FROM pg_roles WHERE rolname=$1`, [role, schema, foreign])).rows[0];
      if (!row || row.rolsuper || row.rolbypassrls || row.rolcreaterole || !row.access || row.foreign_access) throw new BackupError('备份数据库运行角色缺失或权限未隔离');
      const missing = await db.query(`SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) AS p(privilege)
        WHERE n.nspname=$1 AND c.relkind='r' AND NOT has_table_privilege($2,c.oid,p.privilege)`, [schema, role]);
      if (missing.rowCount) throw new BackupError('数据库运行角色缺少表授权');
    }
    const unsafe = await db.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='workpivot' AND c.relkind='r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)");
    if (unsafe.rowCount) throw new BackupError('数据库缺少强制行级隔离');
    if (files) {
      const payload = new Map(files.map(f => [f.path, f]));
      for (const row of (await db.query("SELECT owner_user_id,id,size,sha256 FROM workpivot.document_versions UNION ALL SELECT t.owner_user_id,(f->>'id')::uuid,(f->>'size')::integer,f->>'sha256' FROM workpivot.trash_entries t CROSS JOIN LATERAL jsonb_array_elements(files) f")).rows) {
        const file = payload.get(join(row.owner_user_id, row.id).split('\\').join('/'));
        if (!file || file.bytes !== row.size || file.sha256 !== row.sha256) throw new BackupError('数据库文件引用与备份载荷不一致');
      }
    }
    return { schemaVersion: latestBackupSchema, appRole: appRole as string, authRole: authRole as string };
  } finally { await db.end(); }
}

/** 备份期间持有文件发布锁和数据库读锁，阻止业务写入及孤儿文件清理。 */
export async function reserveBackupSource(url: string) {
  const db = pool(url, { max: 1, idle_in_transaction_session_timeout: 0 });
  const client = await db.connect();
  client.on('error', () => { /* 发布前通过同一连接检查锁是否仍然有效。 */ });
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'");
    const owners = (await client.query('SELECT id FROM identity.users ORDER BY id')).rows;
    for (const owner of owners) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['files:' + owner.id]);
    const tables = (await client.query("SELECT quote_ident(n.nspname)||'.'||quote_ident(c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('identity','workpivot','workpivot_meta') AND c.relkind='r' ORDER BY n.nspname,c.relname")).rows;
    if (!tables.length) throw new BackupError('缺少可备份的业务结构');
    await client.query(`LOCK TABLE ${tables.map(t => t.name).join(',')} IN SHARE MODE`);
    const busy = await client.query("SELECT 1 FROM workpivot.tasks WHERE status IN ('running','waiting','queued') UNION ALL SELECT 1 FROM workpivot.document_processing WHERE status='running' UNION ALL SELECT 1 FROM workpivot.skill_executions WHERE status='running' UNION ALL SELECT 1 FROM workpivot.memory_jobs WHERE status='running' UNION ALL SELECT 1 FROM workpivot.expert_jobs WHERE status='running' UNION ALL SELECT 1 FROM workpivot.skill_trials WHERE status='running' UNION ALL SELECT 1 FROM workpivot.automation_runs WHERE status='running' UNION ALL SELECT 1 FROM workpivot.embedding_jobs WHERE status='running'");
    if (busy.rowCount) throw new BackupError('还有活动任务或后台作业，请停止应用后重试');
    // 专用连接在整个转储与复制期间保持借出，避免被连接池按空闲连接回收。
    return { async assertAlive() { await client.query('SELECT 1'); }, async end() { client.release(true); await db.end(); } };
  } catch (error) { client.release(true); await db.end(); throw error; }
}

/** 持有会话咨询锁直至恢复与校验结束，禁止删除已有目标中的对象。 */
export async function reserveEmptyDatabase(url: string) {
  const db = pool(url, { max: 1 });
  const client = await db.connect();
  client.on('error', () => { /* 发布前通过同一连接检查锁是否仍然有效。 */ });
  try {
    const result = await client.query('SELECT pg_try_advisory_lock(937038) AS locked');
    if (!result.rows[0].locked) throw new BackupError('此恢复目标正在使用');
    const objects = await client.query("SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%' UNION ALL SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'");
    if (objects.rowCount) throw new BackupError('恢复目标数据库必须为空');
    const connections = await client.query('SELECT 1 FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()');
    if (connections.rowCount) throw new BackupError('恢复目标还有其他连接，请停止应用');
    return { async assertAlive() { await client.query('SELECT 1'); }, async end() { client.release(true); await db.end(); } };
  } catch (error) { client.release(true); await db.end(); throw error; }
}

export async function sanitizeRestoredDatabase(url: string) {
  const db = pool(url, { max: 1 });
  try {
    await db.query(`BEGIN;
      UPDATE workpivot.embedding_spaces SET enabled=false,tested=false,revision=revision+1;
      UPDATE workpivot.embedding_jobs SET status='pending',fence=NULL,lease_until=NULL,attempts=0 WHERE status='running';
      UPDATE identity.sessions SET revoked_at=now() WHERE revoked_at IS NULL;
      UPDATE workpivot.automation_runs SET status='interrupted',revoked=true,error='恢复备份后需重新确认',lease_until=NULL WHERE status IN ('queued','waiting_login','running');
      UPDATE workpivot.browser_profiles SET state_cipher=NULL,revoked_at=now(),lease_id=NULL,lease_kind=NULL,lease_until=NULL,revision=revision+1;
      UPDATE workpivot.network_targets SET revoked_at=now() WHERE revoked_at IS NULL;
      UPDATE workpivot.automations SET state='paused',grant_id=NULL,next_at=NULL,draft=NULL,issue='恢复备份后需要重新确认启用' WHERE state<>'deleted';
      UPDATE workpivot.tasks SET status='interrupted' WHERE status IN ('running','waiting','queued');
      UPDATE workpivot.task_runs SET status='interrupted',stop_reason='offline_restore',lease_until=now(),finished_at=now() WHERE status IN ('running','stopping');
      UPDATE workpivot.run_permissions SET state='expired' WHERE state IN ('pending','allowed');
      UPDATE workpivot.skill_trials SET status='interrupted',report=jsonb_build_object('error','恢复备份后需重新试运行') WHERE status='running';
      UPDATE workpivot.skill_builds SET status='stale',validation=NULL,trial=NULL,dismissed=true;
      UPDATE workpivot.skill_drafts SET disabled=true WHERE visibility='private';
      UPDATE workpivot.skill_catalog SET disabled=true WHERE visibility='private';
      UPDATE workpivot.skill_executions SET status='interrupted',error='恢复备份后需重新发起执行',finished_at=now() WHERE status='running';
      UPDATE workpivot.memory_jobs SET status='failed',error='恢复备份后需手动重试',lease_until=NULL WHERE status IN ('pending','running');
      UPDATE workpivot.expert_jobs SET status='failed',error='恢复备份后需手动重试',lease_until=NULL WHERE status IN ('pending','running');
      UPDATE workpivot.document_processing SET status='failed',error='恢复备份后需手动重试',fence=NULL,lease_until=NULL WHERE status IN ('pending','running');
      UPDATE workpivot.context_checkpoints SET status='failed',error='恢复备份后需重新整理',revision=revision+1 WHERE status='generating';
      COMMIT;`);
  } finally { await db.end(); }
}

/** 离线管理员连接切换到受限业务角色后，复用已有遗忘清单规则。 */
function retentionPool(url: string, role: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role)) throw new BackupError('业务角色名称无效');
  return pool(url, { max: 1, options: '-c role=' + role });
}

export async function captureRetention(url: string): Promise<RetentionState[]> {
  const state = await inspectDatabase(url), db = pool(url, { max: 1 }), restricted = retentionPool(url, state.appRole);
  try {
    const users = (await db.query('SELECT id FROM identity.users ORDER BY id')).rows;
    const inventory: RetentionState[] = [];
    for (const user of users) inventory.push(await exportRetention(restricted, user.id));
    return inventory;
  } finally { await Promise.all([db.end(), restricted.end()]); }
}

export async function reconcileRetention(url: string, filesRoot: string, inventory: RetentionState[], role: string) {
  const db = pool(url, { max: 1 }), restricted = retentionPool(url, role);
  try {
    for (const user of (await db.query('SELECT id FROM identity.users')).rows) {
      const state = inventory.find(s => s.actor === user.id);
      await applyRetention(restricted, filesRoot, state ?? { actor: user.id, projects: [], tasks: [], documents: [], memories: [], experts: [], experiences: [] });
      if (!state) await db.query('UPDATE identity.users SET disabled=true WHERE id=$1', [user.id]);
    }
  } finally { await Promise.all([db.end(), restricted.end()]); }
}
