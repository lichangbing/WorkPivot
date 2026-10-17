import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'workpivot-backup-db-'));
const name = 'workpivot-backup-' + Date.now(), password = randomBytes(24).toString('hex');
const docker = args => {
  try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim(); }
  catch { throw Error('恢复测试容器操作失败，临时凭据未输出'); }
};
let started = false;
try {
  docker(['run', '-d', '--name', name, '--label', 'workpivot.disposable=backup-test', '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,size=512m', '-v', `${root}:${root}`, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=workpivot_test', process.env.WORKPIVOT_TEST_PG_IMAGE ?? 'pgvector/pgvector:pg16']);
  started = true;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  if (!ready) throw Error('隔离 PostgreSQL 启动超时');
  const port = JSON.parse(docker(['inspect', name]))[0].NetworkSettings.Ports['5432/tcp'][0].HostPort;
  // 只挂载合成的临时文件；容器中不挂载业务卷或 Docker 套接字。
  for (const tool of ['pg_dump', 'pg_restore']) writeFileSync(join(root, tool), `#!/bin/sh\nexec docker exec -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE ${name} ${tool} "$@"\n`, { mode: 0o700 });
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'eval/backup-database.mts'], { cwd: resolve(import.meta.dirname, '..'), stdio: 'inherit', timeout: 180000, env: { ...process.env, WORKPIVOT_TEST_PG_DISPOSABLE: '1', WORKPIVOT_TEST_PG_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/workpivot_test`, WORKPIVOT_TEST_BACKUP_ROOT: root, WORKPIVOT_PG_DUMP: join(root, 'pg_dump'), WORKPIVOT_PG_RESTORE: join(root, 'pg_restore'), WORKPIVOT_BACKUP_OFFLINE: '1', WORKPIVOT_RESTORE_OFFLINE: '1' } });
  if (run.error) throw Error('恢复验收未能完成');
  process.exitCode = run.status ?? 1;
} finally {
  if (started) {
    const info = JSON.parse(docker(['inspect', name]))[0];
    if (info.Config.Labels['workpivot.disposable'] !== 'backup-test') throw Error('拒绝清理非本次测试容器');
    docker(['rm', '-f', name]);
  }
  rmSync(root, { recursive: true, force: true });
}
